#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getAllowedCoreFiles,
  getRuntimePrefixes,
  loadMemoryStudioConfig,
} from '../bench/memorybench/memory-studio-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultWorkspace = repoRoot;
const defaultMemoryBenchDir = path.join(defaultWorkspace, 'bench', 'memorybench', 'vendor', 'memorybench');
const studioDataDir = path.join(repoRoot, 'bench', 'memorybench', 'data', 'memory-studio');
const autoLoopDir = path.join(studioDataDir, 'autoloop');
const championPath = path.join(studioDataDir, 'champion.json');
const ledgerPath = path.join(studioDataDir, 'ledger.jsonl');

const args = process.argv.slice(2);
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

const run = (cmd, cmdArgs, options = {}) => {
  const result = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
};

const runOrThrow = (cmd, cmdArgs, options = {}) => {
  const result = run(cmd, cmdArgs, options);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${cmd} exited with code ${result.status}`);
  }
  return result;
};

const parseStatusLines = (cwd) => {
  const result = runOrThrow('git', ['-C', cwd, 'status', '--short', '--untracked-files=all']);
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
};

const getChangedTrackedFiles = (cwd) => {
  const unstaged = runOrThrow('git', ['-C', cwd, 'diff', '--name-only']).stdout;
  const staged = runOrThrow('git', ['-C', cwd, 'diff', '--cached', '--name-only']).stdout;
  return Array.from(
    new Set(
      `${unstaged}\n${staged}`
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );
};

const getUntrackedFiles = (cwd) => {
  const output = runOrThrow('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard']).stdout;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const cleanupWorkspace = (cwd, note = '') => {
  const tracked = getChangedTrackedFiles(cwd);
  if (tracked.length > 0) {
    runOrThrow('git', ['-C', cwd, 'restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
  }
  for (const relPath of getUntrackedFiles(cwd)) {
    fs.rmSync(path.join(cwd, relPath), { recursive: true, force: true });
  }
  if (note) {
    console.log(`[cleanup] ${note}`);
  }
};

const validateWorkspaceSafety = ({
  workspaceRoot,
  requireForceClean = true,
  allowRepoWorkspace = false,
}) => {
  if (!workspaceRoot) {
    throw new Error('workspace is required');
  }
  if (requireForceClean) {
    throw new Error('memory-studio-autoloop requires --force-clean because preflight cleanup resets tracked changes and deletes untracked files');
  }
  if (!allowRepoWorkspace && path.resolve(workspaceRoot) === repoRoot) {
    throw new Error('memory-studio-autoloop refuses to clean the main repo by default; pass --workspace to a disposable git clone or add --allow-repo-workspace if you really mean it');
  }
};

const appendJsonl = (filePath, payload) => {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
};

const readJsonl = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const getHeadCommit = (cwd) => runOrThrow('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD']).stdout.trim();

const getAllowedSet = () => new Set(getAllowedCoreFiles());
const runtimePrefixes = getRuntimePrefixes();

const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');

const collectCandidateFiles = (cwd) => {
  const tracked = getChangedTrackedFiles(cwd).map(normalizePath);
  const untracked = getUntrackedFiles(cwd).map(normalizePath);
  return Array.from(new Set([...tracked, ...untracked])).filter(Boolean);
};

const filterUnexpectedFiles = (filePaths) => {
  const allowed = getAllowedSet();
  return filePaths
    .map(normalizePath)
    .filter((filePath) => !runtimePrefixes.some((prefix) => filePath.startsWith(prefix)))
    .filter((filePath) => !allowed.has(filePath));
};

const slug = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'experiment';

const hypothesisBank = [
  {
    name: 'duration-facts',
    focus:
      'Improve retrieval for user facts that encode durations, elapsed time, or how-long questions, especially statements like “I have been ... for three months”.',
  },
  {
    name: 'subject-noun-boost',
    focus:
      'Improve quick-context ranking when the query repeats a concrete user-owned noun phrase such as vintage cameras, certifications, collections, hobbies, or possessions.',
  },
  {
    name: 'question-shape-match',
    focus:
      'Improve matching between “How long / What did I complete / What certification” style questions and directly answer-bearing user facts or decisions.',
  },
  {
    name: 'fact-vs-preference-separation',
    focus:
      'Reduce irrelevant preference memories outranking explicit user facts for factual recall questions, while keeping preference-heavy preference questions stable.',
  },
  {
    name: 'temporal-fact-anchors',
    focus:
      'Improve ranking of memories that contain explicit temporal anchors like last month, three months, recently, or completed last month for factual questions.',
  },
  {
    name: 'world-model-entity-noise',
    focus:
      'Reduce entity/world-model noise in quick-context recall when the selected entity is generic or misleading, especially person:what style false locks.',
  },
  {
    name: 'capture-fact-preservation',
    focus:
      'Preserve high-value user facts from long transcripts during capture so short factual statements do not get diluted by nearby conversational preference sentences.',
  },
  {
    name: 'rare-term-lexical-priority',
    focus:
      'Boost rare lexical anchors such as vintage cameras, Rolleiflex, certification, Data Science, and similar concrete terms for factual recall questions.',
  },
];

const buildPrompt = ({
  iteration,
  hypothesis,
  champion,
  workspaceRoot,
}) => {
  const allowedFiles = Array.from(getAllowedSet()).map((item) => `- ${item}`).join('\n');
  const championSummary = champion?.entries?.main30?.metrics
    ? JSON.stringify(champion.entries.main30.metrics)
    : '{}';
  return `
You are running one autonomous Gigabrain Memory Studio experiment in ${workspaceRoot}.

Read and follow:
- bench/memorybench/memory-studio-program.md

Hard constraints:
- Only edit these files:
${allowedFiles}
- Do not edit any benchmark adapter, scripts, tests, docs, package files, vendor files, or data files.
- Do not commit changes.
- Do not run the memory benchmark yourself; the outer runner will do that.
- Keep the experiment small and focused: one hypothesis, one patch.

Current provisional champion main30 metrics:
${championSummary}

Known weak area:
- single-session-user remains the main gap on Nimbus.
- A still-regressed example is question 15745da0: "How long have I been collecting vintage cameras?"
- The benchmark DB already contains the relevant fact, so improving ranking/selection is more promising than adapter changes.

Experiment ${iteration} hypothesis: ${hypothesis.focus}

What to do:
1. Inspect only the minimum relevant code in the allowed files.
2. Make one focused change that could improve benchmark accuracy under this hypothesis.
3. Prefer preserving current single-session-preference performance.
4. After editing, stop and print a short summary in one paragraph:
   - hypothesis
   - changed file(s)
   - why this might help
`.trim();
};

const extractSummary = (text, fallback) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean || fallback;
};

const writeSummary = (filePath, payload) => {
  const lines = [];
  lines.push(`# Memory Studio Autoloop`);
  lines.push('');
  lines.push(`- Status: ${payload.status}`);
  lines.push(`- Started: ${payload.startedAt}`);
  lines.push(`- Updated: ${payload.updatedAt}`);
  lines.push(`- Workspace: ${payload.workspaceRoot}`);
  lines.push(`- Max experiments: ${payload.maxExperiments}`);
  lines.push(`- Max minutes: ${payload.maxMinutes}`);
  lines.push(`- Completed: ${payload.completed}`);
  lines.push(`- Kept: ${payload.kept}`);
  lines.push(`- Discarded: ${payload.discarded}`);
  lines.push(`- Failed: ${payload.failed}`);
  lines.push(`- Skipped: ${payload.skipped}`);
  lines.push(`- Current head: ${payload.headCommit}`);
  lines.push('');
  lines.push(`## Champion`);
  lines.push('');
  lines.push(`- Provisional: ${payload.champion?.provisional === true ? 'yes' : 'no'}`);
  if (payload.champion?.entries?.main30?.metrics) {
    const metrics = payload.champion.entries.main30.metrics;
    lines.push(`- main30 accuracy: ${metrics.accuracy}`);
    lines.push(`- main30 hit@k: ${metrics.hitAtK}`);
    lines.push(`- main30 mrr: ${metrics.mrr}`);
    lines.push(`- main30 single-session-preference: ${metrics.singleSessionPreferenceAccuracy}`);
  }
  lines.push('');
  lines.push(`## Last Iteration`);
  lines.push('');
  if (payload.lastIteration) {
    lines.push(`- Iteration: ${payload.lastIteration.iteration}`);
    lines.push(`- Hypothesis: ${payload.lastIteration.hypothesis}`);
    lines.push(`- Decision: ${payload.lastIteration.decision}`);
    lines.push(`- Summary: ${payload.lastIteration.summary}`);
  } else {
    lines.push(`- None yet`);
  }
  lines.push('');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const main = () => {
  const workspaceRoot = path.resolve(argValue('--workspace', defaultWorkspace));
  const memoryBenchDir = path.resolve(argValue('--memorybench-dir', defaultMemoryBenchDir));
  const maxExperiments = Math.max(1, Number.parseInt(argValue('--max-experiments', '100'), 10) || 100);
  const maxMinutes = Math.max(1, Number.parseInt(argValue('--max-minutes', '120'), 10) || 120);
  const agentCmd = argValue('--agent-cmd', 'codex');
  const model = argValue('--model', '').trim();
  const dryRun = hasFlag('--dry-run');
  const forceClean = hasFlag('--force-clean');
  const allowRepoWorkspace = hasFlag('--allow-repo-workspace');

  ensureDir(autoLoopDir);
  validateWorkspaceSafety({
    workspaceRoot,
    requireForceClean: !forceClean,
    allowRepoWorkspace,
  });

  const startedAt = new Date();
  const runId = `autoloop-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(autoLoopDir, runId);
  ensureDir(runDir);

  if (!fs.existsSync(championPath)) {
    throw new Error(`champion.json not found at ${championPath}`);
  }

  cleanupWorkspace(workspaceRoot, 'preflight clean');

  const statusLines = parseStatusLines(workspaceRoot);
  if (statusLines.length > 0) {
    throw new Error(`workspace must be clean after preflight cleanup, found: ${statusLines.join(', ')}`);
  }

  const loopLedgerPath = path.join(runDir, 'iterations.jsonl');
  const summaryPath = path.join(runDir, 'summary.md');
  const statePath = path.join(runDir, 'state.json');
  const config = loadMemoryStudioConfig();

  const state = {
    runId,
    status: 'running',
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    workspaceRoot,
    memoryBenchDir,
    maxExperiments,
    maxMinutes,
    completed: 0,
    kept: 0,
    discarded: 0,
    failed: 0,
    skipped: 0,
    headCommit: getHeadCommit(workspaceRoot),
    champion: readJson(championPath),
    lastIteration: null,
    config: {
      agentCmd,
      model: model || config?.models?.answering || '',
    },
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeSummary(summaryPath, state);

  const deadline = Date.now() + maxMinutes * 60 * 1000;

  for (let index = 0; index < maxExperiments && Date.now() < deadline; index += 1) {
    const iteration = index + 1;
    const hypothesis = hypothesisBank[index % hypothesisBank.length];
    const iterationDir = path.join(runDir, `iter-${String(iteration).padStart(3, '0')}-${slug(hypothesis.name)}`);
    ensureDir(iterationDir);

    const prompt = buildPrompt({
      iteration,
      hypothesis,
      champion: state.champion,
      workspaceRoot,
    });
    fs.writeFileSync(path.join(iterationDir, 'prompt.txt'), `${prompt}\n`, 'utf8');

    const lastMessagePath = path.join(iterationDir, 'codex-last-message.txt');
    const codexArgs = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--cd',
      workspaceRoot,
      '--output-last-message',
      lastMessagePath,
      prompt,
    ];
    if (model) {
      codexArgs.splice(1, 0, '--model', model);
    }

    const agentStartedAt = new Date().toISOString();
    let decision = 'failed';
    let summary = '';
    let experimentJson = null;
    let candidateCommit = '';

    const codexResult = dryRun
      ? { status: 0, stdout: '[dry-run] skipped codex exec\n', stderr: '' }
      : run(agentCmd, codexArgs, { cwd: workspaceRoot, env: { ...process.env } });

    fs.writeFileSync(path.join(iterationDir, 'codex.stdout.log'), codexResult.stdout, 'utf8');
    fs.writeFileSync(path.join(iterationDir, 'codex.stderr.log'), codexResult.stderr, 'utf8');

    if (fs.existsSync(lastMessagePath)) {
      summary = extractSummary(fs.readFileSync(lastMessagePath, 'utf8'), hypothesis.focus);
    } else {
      summary = hypothesis.focus;
    }

    if (codexResult.status !== 0) {
      decision = 'failed';
      cleanupWorkspace(workspaceRoot, `iteration ${iteration} codex failure`);
    } else {
      const changedFiles = collectCandidateFiles(workspaceRoot);
      const unexpected = filterUnexpectedFiles(changedFiles);
      if (unexpected.length > 0) {
        decision = 'failed';
        summary = `${summary} Unexpected files changed: ${unexpected.join(', ')}`;
        cleanupWorkspace(workspaceRoot, `iteration ${iteration} unexpected mutation cleanup`);
      } else if (changedFiles.length === 0) {
        decision = 'skipped';
        summary = `${summary} No code changes produced.`;
      } else {
        runOrThrow('git', ['-C', workspaceRoot, 'add', '--', ...changedFiles]);
        const commitMessage = `memory-studio auto ${String(iteration).padStart(3, '0')}: ${slug(hypothesis.name)}`;
        runOrThrow('git', ['-C', workspaceRoot, 'commit', '-m', commitMessage]);
        candidateCommit = getHeadCommit(workspaceRoot);

        const experiment = run(
          'node',
          [
            path.join(workspaceRoot, 'scripts', 'memory-studio.js'),
            'experiment',
            '--workspace',
            workspaceRoot,
            '--memorybench-dir',
            memoryBenchDir,
            '--description',
            `auto ${String(iteration).padStart(3, '0')} ${hypothesis.name}`,
            '--auto-revert',
          ],
          {
            cwd: workspaceRoot,
            env: { ...process.env },
          }
        );

        fs.writeFileSync(path.join(iterationDir, 'experiment.stdout.log'), experiment.stdout, 'utf8');
        fs.writeFileSync(path.join(iterationDir, 'experiment.stderr.log'), experiment.stderr, 'utf8');

        if (experiment.status !== 0) {
          decision = 'failed';
          summary = `${summary} Experiment runner failed: ${experiment.stderr.trim() || experiment.stdout.trim()}`;
          cleanupWorkspace(workspaceRoot, `iteration ${iteration} experiment failure cleanup`);
        } else {
          try {
            experimentJson = JSON.parse(experiment.stdout);
            decision = String(experimentJson?.decision || 'failed');
            if (decision === 'keep') {
              state.champion = readJson(championPath);
            }
          } catch (error) {
            decision = 'failed';
            summary = `${summary} Failed to parse experiment output: ${error instanceof Error ? error.message : String(error)}`;
            cleanupWorkspace(workspaceRoot, `iteration ${iteration} parse failure cleanup`);
          }
        }
      }
    }

    state.completed += 1;
    if (decision === 'keep') state.kept += 1;
    else if (decision === 'discard') state.discarded += 1;
    else if (decision === 'skipped') state.skipped += 1;
    else state.failed += 1;
    state.updatedAt = new Date().toISOString();
    state.headCommit = getHeadCommit(workspaceRoot);
    state.lastIteration = {
      iteration,
      hypothesis: hypothesis.name,
      decision,
      summary,
      candidateCommit,
      agentStartedAt,
      agentStatus: codexResult.status,
    };

    const record = {
      timestamp: state.updatedAt,
      iteration,
      hypothesis: hypothesis.name,
      focus: hypothesis.focus,
      decision,
      summary,
      candidateCommit,
      headCommit: state.headCommit,
      agentStatus: codexResult.status,
      experiment: experimentJson,
      iterationDir,
    };
    appendJsonl(loopLedgerPath, record);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    writeSummary(summaryPath, state);
  }

  state.status = Date.now() >= deadline ? 'deadline_reached' : 'completed';
  state.updatedAt = new Date().toISOString();
  state.headCommit = getHeadCommit(workspaceRoot);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeSummary(summaryPath, state);

  console.log(JSON.stringify({
    ok: true,
    runId,
    runDir,
    statePath,
    summaryPath,
    loopLedgerPath,
    status: state.status,
    completed: state.completed,
    kept: state.kept,
    discarded: state.discarded,
    failed: state.failed,
    skipped: state.skipped,
  }, null, 2));
};

main();
