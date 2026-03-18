#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadMemoryStudioConfig,
  getMemoryStudioPreset,
  getAllowedCoreFiles,
  getRuntimePrefixes,
  extractReportCard,
  compareReportCards,
  canPromoteMain30,
  findUnexpectedMutations,
  getDefaultBaseline,
} from '../bench/memorybench/memory-studio-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'bench', 'memorybench', 'data', 'memory-studio');
const ledgerPath = path.join(dataDir, 'ledger.jsonl');
const championPath = path.join(dataDir, 'champion.json');
const wrapperScript = path.join(repoRoot, 'bench', 'memorybench', 'run-official-memorybench.js');

const args = process.argv.slice(2);
const command = args[0] || 'help';

const argValue = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const withEq = args.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const hasFlag = (name) => args.includes(name);

const ensureDir = (targetPath) => {
  fs.mkdirSync(targetPath, { recursive: true });
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const readReportOrCheckpoint = (reportPath) => {
  if (fs.existsSync(reportPath)) {
    return readJson(reportPath);
  }
  const checkpointPath = path.join(path.dirname(reportPath), 'checkpoint.json');
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`Expected MemoryBench report at ${reportPath}, but neither report.json nor checkpoint.json exists.`);
  }
  const checkpoint = readJson(checkpointPath);
  const failedQuestion = Object.values(checkpoint?.questions || {}).find(
    (question) => String(question?.phases?.ingest?.status || question?.phases?.search?.status || '') === 'failed'
      || Object.values(question?.phases || {}).some((phase) => String(phase?.status || '') === 'failed')
  );
  const failedPhase = failedQuestion
    ? Object.entries(failedQuestion.phases || {}).find(([, phase]) => String(phase?.status || '') === 'failed')
    : null;
  const reason = failedPhase?.[1]?.error || checkpoint?.error || 'MemoryBench run failed before report generation.';
  throw new Error(
    `MemoryBench run ${String(checkpoint?.runId || '').trim() || 'unknown'} did not produce report.json. ` +
      `Status=${String(checkpoint?.status || 'unknown')}. ` +
      `Root cause: ${String(reason).trim()}`
  );
};

const writeJson = (filePath, payload) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const appendJsonl = (filePath, payload) => {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
};

const runOrThrow = (cmd, cmdArgs, options = {}) => {
  const result = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `${cmd} exited with code ${result.status || 1}`);
  }
  return result;
};

const resolveRepoRoot = (inputPath) => {
  const resolved = path.resolve(inputPath || repoRoot);
  return String(
    runOrThrow('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { cwd: resolved }).stdout
  ).trim();
};

const getGitInfo = (cwd) => {
  const branch = String(runOrThrow('git', ['-C', cwd, 'branch', '--show-current']).stdout).trim();
  const commit = String(runOrThrow('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD']).stdout).trim();
  const fullCommit = String(runOrThrow('git', ['-C', cwd, 'rev-parse', 'HEAD']).stdout).trim();
  return { branch, commit, fullCommit };
};

const getTrackedStatusLines = (cwd) => {
  const output = String(
    runOrThrow('git', ['-C', cwd, 'status', '--short', '--untracked-files=all']).stdout
  ).trim();
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
};

const getHeadDiffFiles = (cwd) => {
  const output = String(
    runOrThrow('git', ['-C', cwd, 'diff', '--name-only', 'HEAD^', 'HEAD']).stdout
  ).trim();
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
};

const extractWrapperJson = (stdout) => {
  const line = String(stdout || '')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('MEMORYBENCH_JSON:'));
  if (!line) {
    throw new Error('MemoryBench wrapper did not emit structured JSON output.');
  }
  return JSON.parse(line.slice('MEMORYBENCH_JSON:'.length));
};

const readChampion = () => (fs.existsSync(championPath) ? readJson(championPath) : null);

const writeChampion = (payload) => writeJson(championPath, payload);

const buildRunEntry = ({
  presetName,
  description,
  status,
  reportPath,
  runId,
  compareId,
  workingTreeRoot,
}) => {
  const report = readReportOrCheckpoint(reportPath);
  const gitInfo = getGitInfo(workingTreeRoot);
  const card = extractReportCard(report);
  return {
    timestamp: new Date().toISOString(),
    preset: presetName,
    description: String(description || '').trim() || presetName,
    status,
    commit: gitInfo.commit,
    fullCommit: gitInfo.fullCommit,
    branch: gitInfo.branch,
    runId,
    compareId,
    reportPath,
    metrics: card,
    questionCount: Number(report?.summary?.totalQuestions || 0),
  };
};

const defaultMemoryBenchDir = (workingTreeRoot) =>
  path.join(workingTreeRoot, 'bench', 'memorybench', 'vendor', 'memorybench');

const runPreset = ({
  workingTreeRoot,
  presetName,
  description,
  status,
  memoryBenchDir,
}) => {
  const config = loadMemoryStudioConfig();
  const preset = getMemoryStudioPreset(presetName);
  const wrapperArgs = [
    wrapperScript,
    '--memorybench-dir',
    memoryBenchDir,
    '--benchmark',
    preset.benchmark,
    '--providers',
    preset.provider,
    '--judge',
    config.models.judge,
    '--answering-model',
    config.models.answering,
    '--preset',
    presetName,
    '--json',
  ];

  const result = runOrThrow('node', wrapperArgs, {
    cwd: workingTreeRoot,
    env: { ...process.env },
  });

  const wrapperJson = extractWrapperJson(result.stdout);
  const entry = buildRunEntry({
    presetName,
    description,
    status,
    reportPath: wrapperJson.report_path,
    runId: wrapperJson.run_id,
    compareId: wrapperJson.compare_id,
    workingTreeRoot,
  });
  appendJsonl(ledgerPath, entry);
  return entry;
};

const ensureBaselineFloor = (mainEntry) => {
  const baseline = getDefaultBaseline();
  if (!baseline || Object.keys(baseline).length === 0) return;
  if (mainEntry.metrics.accuracy + 1e-9 < Number(baseline.accuracy || 0)) {
    throw new Error(
      `main30 accuracy ${mainEntry.metrics.accuracy.toFixed(3)} is below baseline floor ${Number(
        baseline.accuracy || 0
      ).toFixed(3)}`
    );
  }
  if (
    mainEntry.metrics.singleSessionPreferenceAccuracy + 1e-9
    < Number(baseline.singleSessionPreferenceAccuracy || 0)
  ) {
    throw new Error(
      `main30 single-session-preference accuracy ${mainEntry.metrics.singleSessionPreferenceAccuracy.toFixed(
        3
      )} is below baseline floor ${Number(baseline.singleSessionPreferenceAccuracy || 0).toFixed(3)}`
    );
  }
};

const printUsage = () => {
  console.log('Usage:');
  console.log('  npm run memory-studio -- setup-workspace [--workspace-path <path>] [--source-repo <path>]');
  console.log('  npm run memory-studio -- seed-baseline [--memorybench-dir <path>]');
  console.log('  npm run memory-studio -- run <preset> [--description <text>] [--status <value>]');
  console.log('  npm run memory-studio -- experiment --description <text> [--auto-revert]');
};

const setupWorkspace = () => {
  const sourceRepo = resolveRepoRoot(argValue('--source-repo', repoRoot));
  const dateTag = argValue(
    '--tag',
    `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-nimbus`
  );
  const branchName = argValue('--branch', `codex/memory-studio/${dateTag}`);
  const workspacePath = path.resolve(
    argValue(
      '--workspace-path',
      path.join(path.dirname(sourceRepo), `gigabrain-memory-studio-${dateTag}`)
    )
  );
  const config = loadMemoryStudioConfig();
  const memoryBenchDir = path.join(workspacePath, 'bench', 'memorybench', 'vendor', 'memorybench');

  if (fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path already exists: ${workspacePath}`);
  }

  const branchExists = spawnSync('git', ['-C', sourceRepo, 'rev-parse', '--verify', branchName], {
    encoding: 'utf8',
  });
  if (branchExists.status === 0) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  runOrThrow('git', ['-C', sourceRepo, 'worktree', 'add', '-b', branchName, workspacePath, 'HEAD']);
  ensureDir(path.dirname(memoryBenchDir));
  runOrThrow('git', ['clone', config.memorybench.origin, memoryBenchDir], { cwd: workspacePath });
  runOrThrow('git', ['-C', memoryBenchDir, 'fetch', '--depth', '1', 'origin', config.memorybench.commit]);
  runOrThrow('git', ['-C', memoryBenchDir, 'checkout', config.memorybench.commit]);

  const sessionPayload = {
    createdAt: new Date().toISOString(),
    sourceRepo,
    workspacePath,
    branchName,
    memoryBenchDir,
    pinnedMemoryBenchCommit: config.memorybench.commit,
    judgeModel: config.models.judge,
    answeringModel: config.models.answering,
    allowedCoreFiles: getAllowedCoreFiles(),
    programPath: path.join(workspacePath, 'bench', 'memorybench', 'memory-studio-program.md'),
  };
  writeJson(path.join(workspacePath, 'bench', 'memorybench', 'data', 'memory-studio', 'session.json'), sessionPayload);

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspacePath,
        branchName,
        memoryBenchDir,
        next: [
          `cd ${workspacePath}`,
          'npm run memory-studio -- seed-baseline',
        ],
      },
      null,
      2
    )
  );
};

const seedBaseline = () => {
  const workingTreeRoot = resolveRepoRoot(argValue('--workspace', repoRoot));
  const memoryBenchDir = path.resolve(argValue('--memorybench-dir', defaultMemoryBenchDir(workingTreeRoot)));
  const devEntry = runPreset({
    workingTreeRoot,
    presetName: 'dev12',
    description: 'baseline seed dev12',
    status: 'baseline',
    memoryBenchDir,
  });
  const mainEntry = runPreset({
    workingTreeRoot,
    presetName: 'main30',
    description: 'baseline seed main30',
    status: 'baseline',
    memoryBenchDir,
  });
  ensureBaselineFloor(mainEntry);
  const payload = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: {
      dev12: devEntry,
      main30: mainEntry,
    },
  };
  writeChampion(payload);
  console.log(JSON.stringify({ ok: true, championPath, entries: payload.entries }, null, 2));
};

const runSinglePreset = () => {
  const presetName = args[1];
  if (!presetName) {
    throw new Error('Missing preset name.');
  }
  const workingTreeRoot = resolveRepoRoot(argValue('--workspace', repoRoot));
  const memoryBenchDir = path.resolve(argValue('--memorybench-dir', defaultMemoryBenchDir(workingTreeRoot)));
  const entry = runPreset({
    workingTreeRoot,
    presetName,
    description: argValue('--description', presetName),
    status: argValue('--status', 'candidate'),
    memoryBenchDir,
  });
  console.log(JSON.stringify({ ok: true, entry }, null, 2));
};

const runExperiment = () => {
  const workingTreeRoot = resolveRepoRoot(argValue('--workspace', repoRoot));
  const memoryBenchDir = path.resolve(argValue('--memorybench-dir', defaultMemoryBenchDir(workingTreeRoot)));
  const description = argValue('--description', '').trim();
  if (!description) {
    throw new Error('experiment requires --description');
  }

  const dirtyLines = getTrackedStatusLines(workingTreeRoot);
  if (dirtyLines.length > 0) {
    throw new Error('experiment requires a clean working tree; commit the candidate first.');
  }

  const changedFiles = getHeadDiffFiles(workingTreeRoot);
  const unexpected = findUnexpectedMutations(changedFiles, getAllowedCoreFiles(), getRuntimePrefixes());
  if (unexpected.length > 0) {
    throw new Error(
      `experiment candidate touched files outside the allowed core scope: ${unexpected.join(', ')}`
    );
  }

  const champion = readChampion();
  if (!champion?.entries?.dev12 || !champion?.entries?.main30) {
    throw new Error('No champion.json found. Run `npm run memory-studio -- seed-baseline` first.');
  }

  const devEntry = runPreset({
    workingTreeRoot,
    presetName: 'dev12',
    description,
    status: 'candidate',
    memoryBenchDir,
  });

  const devDecision = compareReportCards(devEntry.metrics, champion.entries.dev12.metrics);
  if (devDecision.decision !== 'better') {
    const finalEntry = { ...devEntry, status: 'discard', decision: devDecision };
    appendJsonl(ledgerPath, finalEntry);
    if (hasFlag('--auto-revert')) {
      runOrThrow('git', ['-C', workingTreeRoot, 'reset', '--hard', 'HEAD^']);
    }
    console.log(JSON.stringify({ ok: true, decision: 'discard', dev12: finalEntry }, null, 2));
    return;
  }

  const mainEntry = runPreset({
    workingTreeRoot,
    presetName: 'main30',
    description,
    status: 'candidate',
    memoryBenchDir,
  });

  const promotion = canPromoteMain30(mainEntry.metrics, champion.entries.main30.metrics);
  if (!promotion.accepted) {
    const discardSummary = {
      ok: true,
      decision: 'discard',
      dev12: { ...devEntry, decision: devDecision },
      main30: { ...mainEntry, decision: promotion },
    };
    appendJsonl(ledgerPath, { ...devEntry, status: 'discard', decision: devDecision });
    appendJsonl(ledgerPath, { ...mainEntry, status: 'discard', decision: promotion });
    if (hasFlag('--auto-revert')) {
      runOrThrow('git', ['-C', workingTreeRoot, 'reset', '--hard', 'HEAD^']);
    }
    console.log(JSON.stringify(discardSummary, null, 2));
    return;
  }

  const updatedChampion = {
    createdAt: champion.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: {
      dev12: { ...devEntry, status: 'keep', decision: devDecision },
      main30: { ...mainEntry, status: 'keep', decision: promotion },
    },
  };
  appendJsonl(ledgerPath, updatedChampion.entries.dev12);
  appendJsonl(ledgerPath, updatedChampion.entries.main30);
  writeChampion(updatedChampion);
  console.log(JSON.stringify({ ok: true, decision: 'keep', champion: updatedChampion }, null, 2));
};

try {
  switch (command) {
    case 'setup-workspace':
      setupWorkspace();
      break;
    case 'seed-baseline':
      seedBaseline();
      break;
    case 'run':
      runSinglePreset();
      break;
    case 'experiment':
      runExperiment();
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      throw new Error(`Unknown memory-studio command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
