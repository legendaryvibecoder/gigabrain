import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { buildPublicMirror } from '../scripts/build-public-mirror.mjs';
import {
  PublicMirrorError,
  checkPublicMirror,
  validateManifest,
} from '../scripts/check-public-mirror.mjs';
import {
  BANNED_IDENTIFIER_HASHES,
  BANNED_TOKEN_HASHES,
} from '../scripts/privacy-policy.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right, 'en'));
const testTempRoot = path.resolve(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir());

const runCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
};

const write = (root, relativePath, contents) => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};

const baseManifest = ({
  files = ['LICENSE', 'index.js', 'package.json', 'public-release-manifest.json'],
  packageFiles = ['index.js'],
  npmFiles = ['index.js', 'LICENSE', 'package.json'],
  requiredFiles = ['LICENSE', 'package.json', 'public-release-manifest.json'],
  benchmarkEvidence = [],
  binaryFiles = [],
  contentExceptions = [],
  omitScripts = [],
  setScripts = {},
} = {}) => ({
  schemaVersion: 1,
  repository: {
    files: sorted(files),
    requiredFiles: sorted(requiredFiles),
    runtimeIgnores: [
      '.venv/**',
      '**/__pycache__/**',
      '**/.DS_Store',
      '**/*.pyc',
      '**/Thumbs.db',
      'node_modules/**',
    ],
    binaryFiles,
    contentExceptions,
  },
  npm: {
    packageName: '@synthetic/public-mirror-fixture',
    packageFiles: sorted(packageFiles),
    files: sorted(npmFiles),
  },
  transforms: {
    packageJson: {
      omitScripts: sorted(omitScripts),
      setScripts: Object.fromEntries(
        Object.entries(setScripts).sort(([left], [right]) => left.localeCompare(right, 'en')),
      ),
    },
  },
  benchmarkEvidence,
});

const createRepository = ({ manifest: manifestOverride, packageJson: packageOverride } = {}) => {
  const root = fs.mkdtempSync(path.join(testTempRoot, 'gigabrain-public-mirror-test-'));
  const packageJson = packageOverride || {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['index.js'],
  };
  const manifest = manifestOverride || baseManifest();
  write(root, 'LICENSE', 'Synthetic license fixture.\n');
  write(root, 'index.js', 'export const value = 1;\n');
  write(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  write(root, 'public-release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  runCommand('git', ['init', '-q'], root);
  runCommand('git', ['config', 'user.name', 'Synthetic Fixture'], root);
  runCommand('git', ['config', 'user.email', ['12345+fixture', 'users.noreply.github.com'].join('@')], root);
  runCommand('git', ['add', '.'], root);
  runCommand('git', ['commit', '-qm', 'synthetic root'], root);
  return { root, manifest };
};

const expectClasses = (callback, expectedClasses) => {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof PublicMirrorError);
    const actual = new Set(error.findings.map((finding) => finding.class));
    for (const expected of expectedClasses) assert.ok(actual.has(expected), `missing ${expected}`);
    return true;
  });
};

const testValidSyntheticRepositoryAndSafePack = () => {
  const marker = 'prepack-marker.txt';
  const packageJson = {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['index.js'],
    scripts: {
      prepack: `node -e "require('fs').writeFileSync('${marker}','unsafe')"`,
    },
  };
  const { root } = createRepository({ packageJson });
  try {
    const result = checkPublicMirror({ root });
    assert.equal(result.ok, true);
    assert.equal(result.npmFiles, 3);
    assert.equal(fs.existsSync(path.join(root, marker)), false, 'npm lifecycle scripts must not run');
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testManifestFailsClosed = () => {
  const unknown = baseManifest();
  unknown.repository.files = [...unknown.repository.files].reverse();
  unknown.unexpected = true;
  expectClasses(() => validateManifest(unknown), ['MANIFEST_SCHEMA']);

  const traversal = baseManifest();
  traversal.repository.files = ['../private.txt', ...traversal.repository.files];
  expectClasses(() => validateManifest(traversal), ['MANIFEST_SCHEMA']);

  const broadIgnore = baseManifest();
  broadIgnore.repository.runtimeIgnores = ['**'];
  expectClasses(() => validateManifest(broadIgnore), ['MANIFEST_SCHEMA']);

  const conflictingScriptTransform = baseManifest({
    omitScripts: ['test'],
    setScripts: { test: 'node index.js --smoke' },
  });
  expectClasses(() => validateManifest(conflictingScriptTransform), ['MANIFEST_SCHEMA']);

  const emptyScriptTransform = baseManifest({ setScripts: { test: '' } });
  expectClasses(() => validateManifest(emptyScriptTransform), ['MANIFEST_SCHEMA']);

  const { root } = createRepository();
  const external = fs.mkdtempSync(path.join(testTempRoot, 'gigabrain-external-manifest-test-'));
  try {
    const externalManifest = path.join(external, 'manifest.json');
    fs.copyFileSync(path.join(root, 'public-release-manifest.json'), externalManifest);
    expectClasses(
      () => checkPublicMirror({
        root,
        manifestPath: externalManifest,
        checkNpm: false,
        checkHistory: false,
      }),
      ['MANIFEST_PATH'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(external, { force: true, recursive: true });
  }
};

const testUnexpectedTrackedAndUntrackedFiles = () => {
  const { root } = createRepository();
  try {
    write(root, 'extra-tracked.txt', 'tracked\n');
    runCommand('git', ['add', 'extra-tracked.txt'], root);
    write(root, 'extra-untracked.txt', 'untracked\n');
    expectClasses(
      () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
      ['UNEXPECTED_FILE', 'UNEXPECTED_TRACKED_FILE'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testNarrowRuntimeIgnores = () => {
  const { root } = createRepository();
  try {
    write(root, 'node_modules/dependency/index.js', 'ignored\n');
    write(root, 'nested/__pycache__/module.pyc', Buffer.from([0, 1, 2]));
    const result = checkPublicMirror({ root, checkNpm: false, checkHistory: false });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testPrivateArtifactClasses = () => {
  const prohibited = [
    'bench/frontier/run-synthetic-answerer.js',
    'bench/longmemeval/models/frozen-contract.json',
    'bench/longmemeval/results/private.json',
    'docs/audits/private.md',
    'docs/benchmarks/frontier-results-private.md',
    'docs/brainstorms/private.md',
    'docs/ideation/private.md',
    'docs/plans/private.md',
    'eval/recall-baseline.json',
    'eval/results/private.json',
    'release-notes/unreleased-hardening.md',
    'scripts/memory-studio.js',
    'tasks/private.md',
    'tests/fixtures/a8-private.json',
    'tests/unit-frontier-answerer-test.js',
  ];
  for (const privatePath of prohibited) {
    const manifest = baseManifest({
      files: ['LICENSE', 'index.js', 'package.json', 'public-release-manifest.json', privatePath],
    });
    const { root } = createRepository({ manifest });
    try {
      write(root, privatePath, 'synthetic\n');
      expectClasses(
        () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
        ['PRIVATE_ARTIFACT_PATH'],
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
};

const testSensitiveContentIsRedacted = () => {
  const sensitivePath = 'sensitive.txt';
  const manifest = baseManifest({
    files: ['LICENSE', 'index.js', 'package.json', 'public-release-manifest.json', sensitivePath],
  });
  const { root } = createRepository({ manifest });
  const homePath = ['', 'Users', 'synthetic-person', 'private', 'file.txt'].join('/');
  const providerEmail = ['synthetic.person', 'proton.me'].join('@');
  const token = ['ghp', 'A'.repeat(40)].join('_');
  const shortOpenAiToken = `sk-${'B'.repeat(20)}`;
  const contents = `${homePath}\n${providerEmail}\n${token}\n${shortOpenAiToken}\n`;
  try {
    write(root, sensitivePath, contents);
    assert.throws(
      () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
      (error) => {
        assert.ok(error instanceof PublicMirrorError);
        const serialized = JSON.stringify(error.findings);
        assert.equal(serialized.includes(homePath), false);
        assert.equal(serialized.includes(providerEmail), false);
        assert.equal(serialized.includes(token), false);
        assert.equal(serialized.includes(shortOpenAiToken), false);
        const classes = new Set(error.findings.map((finding) => finding.class));
        assert.ok(classes.has('ABSOLUTE_HOME_PATH'));
        assert.ok(classes.has('EMAIL'));
        assert.ok(classes.has('SECRET'));
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testMissingRequiredAndUnreviewedBinary = () => {
  const manifest = baseManifest({
    files: ['LICENSE', 'binary.dat', 'index.js', 'package.json', 'public-release-manifest.json'],
    requiredFiles: ['LICENSE', 'binary.dat', 'package.json', 'public-release-manifest.json'],
  });
  const { root } = createRepository({ manifest });
  try {
    fs.rmSync(path.join(root, 'LICENSE'));
    write(root, 'binary.dat', Buffer.from([0xff, 0xfe, 0x00]));
    expectClasses(
      () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
      ['MISSING_ALLOWLISTED_FILE', 'MISSING_REQUIRED_FILE', 'UNREVIEWED_BINARY_FILE'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const validEvidence = () => ({
  schema_version: 1,
  evidence_kind: 'sanitized-public-aggregate',
  generated_at: '2026-01-01T00:00:00.000Z',
  evidence_sets: [{
    id: 'synthetic-development',
    status: 'development',
    denominator: 3,
    metrics: { score: 0.5 },
    limitations: ['Synthetic aggregate only'],
  }],
  claims: {
    held_out_score: false,
    public_sota: false,
  },
});

const testBenchmarkEvidenceSchemaAndDigest = () => {
  const evidencePath = 'bench/public/aggregate.json';
  const evidenceText = `${JSON.stringify(validEvidence(), null, 2)}\n`;
  const manifest = baseManifest({
    files: ['LICENSE', evidencePath, 'index.js', 'package.json', 'public-release-manifest.json'],
    benchmarkEvidence: [{
      path: evidencePath,
      schema: 'sanitized-public-aggregate-v1',
      sha256: sha256(evidenceText),
    }],
  });
  const { root } = createRepository({ manifest });
  try {
    write(root, evidencePath, evidenceText);
    assert.equal(checkPublicMirror({ root, checkNpm: false, checkHistory: false }).ok, true);
    const invalid = validEvidence();
    invalid.question = 'content must never be in aggregate evidence';
    write(root, evidencePath, `${JSON.stringify(invalid, null, 2)}\n`);
    expectClasses(
      () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
      ['BENCHMARK_EVIDENCE_DIGEST_DRIFT', 'BENCHMARK_EVIDENCE_SCHEMA'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testCoordinatorBuildsFreshCandidate = () => {
  const checkerPath = 'scripts/check-public-mirror.mjs';
  const safeFsPath = 'lib/core/safe-fs.js';
  const files = ['LICENSE', safeFsPath, checkerPath, 'index.js', 'package.json', 'public-release-manifest.json'];
  const manifest = baseManifest({
    files,
    requiredFiles: ['LICENSE', safeFsPath, checkerPath, 'package.json', 'public-release-manifest.json'],
    omitScripts: ['private:fixture'],
    setScripts: { test: 'node index.js --smoke' },
  });
  const packageJson = {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['index.js'],
    scripts: {
      'private:fixture': 'node tasks/private.js',
      test: 'node index.js',
    },
  };
  const { root } = createRepository({ manifest, packageJson });
  const destination = path.join(testTempRoot, `gigabrain-built-candidate-${crypto.randomUUID()}`);
  const rebuiltDestination = path.join(testTempRoot, `gigabrain-rebuilt-candidate-${crypto.randomUUID()}`);
  try {
    write(root, checkerPath, fs.readFileSync(new URL('../scripts/check-public-mirror.mjs', import.meta.url)));
    write(root, safeFsPath, fs.readFileSync(new URL('../lib/core/safe-fs.js', import.meta.url)));
    write(root, 'tasks/private.md', 'must not be copied\n');
    runCommand('git', ['add', checkerPath, safeFsPath, 'tasks/private.md'], root);
    runCommand('git', ['commit', '-qm', 'add synthetic source-only material'], root);
    const result = buildPublicMirror({
      source: root,
      destination,
      commitDate: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(fs.existsSync(path.join(destination, 'tasks/private.md')), false);
    const publicPackage = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(publicPackage.scripts, 'private:fixture'), false);
    assert.equal(publicPackage.scripts.test, 'node index.js --smoke');
    assert.equal(runCommand('git', ['rev-list', '--count', 'HEAD'], destination).trim(), '1');
    assert.ok(result.head);

    const rebuilt = buildPublicMirror({
      source: destination,
      destination: rebuiltDestination,
      commitDate: '2026-01-01T00:00:00.000Z',
    });
    const rebuiltPackage = JSON.parse(fs.readFileSync(path.join(rebuiltDestination, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(rebuiltPackage.scripts, 'private:fixture'), false);
    assert.equal(rebuiltPackage.scripts.test, 'node index.js --smoke');
    assert.equal(runCommand('git', ['rev-list', '--count', 'HEAD'], rebuiltDestination).trim(), '1');
    assert.equal(rebuilt.head, result.head, 'an already-sanitized candidate must rebuild identically');
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(destination, { force: true, recursive: true });
    fs.rmSync(rebuiltDestination, { force: true, recursive: true });
  }
};

const testCoordinatorRejectsPartialPackageTransform = () => {
  const checkerPath = 'scripts/check-public-mirror.mjs';
  const safeFsPath = 'lib/core/safe-fs.js';
  const files = ['LICENSE', safeFsPath, checkerPath, 'index.js', 'package.json', 'public-release-manifest.json'];
  const manifest = baseManifest({
    files,
    requiredFiles: ['LICENSE', safeFsPath, checkerPath, 'package.json', 'public-release-manifest.json'],
    omitScripts: ['private:first', 'private:second'],
  });
  const packageJson = {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['index.js'],
    scripts: {
      'private:first': 'node tasks/private-first.js',
      test: 'node index.js',
    },
  };
  const { root } = createRepository({ manifest, packageJson });
  const destination = path.join(testTempRoot, `gigabrain-partial-transform-${crypto.randomUUID()}`);
  try {
    write(root, checkerPath, fs.readFileSync(new URL('../scripts/check-public-mirror.mjs', import.meta.url)));
    write(root, safeFsPath, fs.readFileSync(new URL('../lib/core/safe-fs.js', import.meta.url)));
    runCommand('git', ['add', checkerPath, safeFsPath], root);
    runCommand('git', ['commit', '-qm', 'add synthetic checker'], root);
    assert.throws(
      () => buildPublicMirror({ source: root, destination }),
      /package\.json transform is partially applied/u,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(destination, { force: true, recursive: true });
  }
};

const testCheckerRejectsUnappliedPackageTransform = () => {
  const manifest = baseManifest({
    omitScripts: ['private:fixture'],
    setScripts: { test: 'node index.js --smoke' },
  });
  const packageJson = {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['index.js'],
    scripts: {
      'private:fixture': 'node private.js',
      test: 'node index.js',
    },
  };
  const { root } = createRepository({ manifest, packageJson });
  try {
    expectClasses(
      () => checkPublicMirror({ root, checkNpm: false, checkHistory: false }),
      ['PUBLIC_PACKAGE_SCRIPT_NOT_OMITTED', 'PUBLIC_PACKAGE_SCRIPT_TRANSFORM_DRIFT'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testCoordinatorRejectsDestinationSymlinkIntoSource = () => {
  const { root } = createRepository();
  const carrier = fs.mkdtempSync(path.join(testTempRoot, 'gigabrain-destination-link-test-'));
  const sourceTarget = path.join(root, 'tracked-destination-parent');
  const linkedParent = path.join(carrier, 'linked-parent');
  const destination = path.join(linkedParent, 'candidate');
  try {
    write(root, 'tracked-destination-parent/.keep', 'tracked\n');
    runCommand('git', ['add', 'tracked-destination-parent/.keep'], root);
    runCommand('git', ['commit', '-qm', 'add synthetic destination target'], root);
    fs.symlinkSync(sourceTarget, linkedParent, 'dir');
    assert.throws(
      () => buildPublicMirror({ source: root, destination }),
      /destination must be outside the source repository/u,
    );
    assert.equal(fs.existsSync(path.join(sourceTarget, 'candidate')), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(carrier, { force: true, recursive: true });
  }
};

const testCoordinatorRejectsSymlinkedSourceComponent = () => {
  const linkedFile = 'linked/escape.js';
  const manifest = baseManifest({
    files: ['LICENSE', 'index.js', linkedFile, 'package.json', 'public-release-manifest.json'],
  });
  const { root } = createRepository({ manifest });
  const external = fs.mkdtempSync(path.join(testTempRoot, 'gigabrain-source-link-target-'));
  const destination = path.join(testTempRoot, `gigabrain-source-link-candidate-${crypto.randomUUID()}`);
  try {
    write(external, 'escape.js', 'export const escaped = true;\n');
    fs.symlinkSync(external, path.join(root, 'linked'), 'dir');
    runCommand('git', ['add', 'linked'], root);
    runCommand('git', ['commit', '-qm', 'add synthetic source symlink'], root);
    assert.throws(
      () => buildPublicMirror({ source: root, destination }),
      /allowlisted source path contains a symbolic link/u,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(external, { force: true, recursive: true });
    fs.rmSync(destination, { force: true, recursive: true });
  }
};

const testReleaseManifestStaysNarrow = () => {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(
    new URL('../public-release-manifest.json', import.meta.url),
    'utf8',
  )));
  assert.ok(manifest.repository.files.length < 160, 'repository inventory must remain deliberately narrow');
  for (const required of [
    '.github/workflows/ci.yml',
    '.github/workflows/codeql.yml',
    '.github/workflows/pii-scan.yml',
    '.github/workflows/public-mirror.yml',
    'scripts/build-public-mirror.mjs',
    'scripts/audit-github-surface.mjs',
    'scripts/check-no-pii.mjs',
    'scripts/check-public-mirror.mjs',
    'scripts/package-smoke.js',
    'tests/run-all.js',
  ]) {
    assert.ok(manifest.repository.requiredFiles.includes(required), `missing required public file: ${required}`);
  }
  assert.deepEqual(
    manifest.benchmarkEvidence.map((entry) => entry.path),
    ['docs/public/benchmark-evidence.json'],
  );
  assert.equal(
    manifest.repository.files.some((file) => file.startsWith('bench/')),
    false,
    'an incomplete benchmark executor must not enter the public repository',
  );
  assert.equal(
    manifest.repository.files.includes('STRATEGY.md'),
    false,
    'internal strategy and owner-environment detail must not enter the public repository',
  );
  assert.equal(
    manifest.repository.files.includes('scripts/private-scan-fixtures.mjs'),
    false,
    'source-private identifier hashes and fixture approvals must not enter the public repository',
  );
  const publicPrivacyPolicy = fs.readFileSync(new URL('../scripts/privacy-policy.mjs', import.meta.url), 'utf8');
  assert.equal(BANNED_IDENTIFIER_HASHES.size, 0, 'public identifier-hash set must stay empty');
  assert.equal(BANNED_TOKEN_HASHES.size, 0, 'public token-hash set must stay empty');
  assert.doesNotMatch(
    publicPrivacyPolicy,
    /\b[a-f0-9]{64}\b/u,
    'public privacy policy must not publish guessable hashes of private identifiers',
  );
  assert.ok(
    manifest.repository.files.includes('scripts/audit-github-surface.mjs'),
    'public readers must receive the reproducible GitHub metadata audit',
  );
  assert.equal(
    manifest.transforms.packageJson.omitScripts.includes('audit:github-metadata'),
    false,
    'the public package must retain its GitHub metadata audit command',
  );
  for (const scriptName of [
    'build:public-mirror',
    'check:pii',
    'check:public-mirror',
    'eval:deep-recall',
    'release:initial-public-mirror',
    'release:public-mirror',
    'test:gates',
    'test:integration',
    'test:performance',
    'test:public-mirror',
    'test:regression',
    'test:release',
    'test:release-live',
    'test:unit',
  ]) {
    assert.ok(
      manifest.transforms.packageJson.omitScripts.includes(scriptName),
      `missing public package-script omission: ${scriptName}`,
    );
  }
  assert.equal(
    manifest.transforms.packageJson.setScripts.test,
    'node scripts/package-smoke.js',
  );

  const prohibitedRepositoryPatterns = [
    /^bench\/.*\/results\//u,
    /^docs\/(?:audits|brainstorms|ideation|plans)\//u,
    /^docs\/benchmarks\/frontier-/u,
    /^eval\/.*(?:baseline|cases?|fixture|results)/u,
    /^release-notes\//u,
    /(?:^|\/)memory-studio/u,
    /(?:^|\/)(?:tasks|outputs?|data|config)\//u,
    /^bench\/.*(?:answerer|judge|score(?:r|-answers))/u,
    /^tests\/fixtures\//u,
    /^tests\/.*(?:a[5-8]|frontier|longmemeval|structured-memory-envelope|versioned-evidence)/u,
  ];
  for (const file of manifest.repository.files) {
    assert.equal(
      prohibitedRepositoryPatterns.some((pattern) => pattern.test(file)),
      false,
      `prohibited repository class: ${file}`,
    );
  }

  for (const file of manifest.npm.files) {
    assert.equal(/^(?:bench|eval|site|tests)\//u.test(file), false, `non-runtime npm class: ${file}`);
    assert.notEqual(file, 'scripts/build-public-mirror.mjs');
    assert.notEqual(file, 'scripts/check-public-mirror.mjs');
    assert.notEqual(file, 'tests/unit-pii-scanner-test.js');
  }
  for (const publicPage of [
    'docs/public/benchmark-evidence.md',
    'docs/public/privacy-model.md',
    'docs/public/release-readiness.md',
    'docs/public/security-review.md',
    'docs/public/why-gigabrain.md',
  ]) {
    assert.ok(manifest.npm.files.includes(publicPage), `missing public npm page: ${publicPage}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(
    packageLock.packages?.['']?.engines?.node,
    packageJson.engines?.node,
    'package-lock runtime metadata must match package.json',
  );
  for (const [scriptName, expectedValue] of [
    ['release:public-mirror', 'node scripts/check-public-mirror.mjs'],
    ['release:initial-public-mirror', 'node scripts/check-public-mirror.mjs --require-single-commit'],
  ]) {
    if (packageJson.scripts[scriptName] === undefined) {
      assert.ok(
        manifest.transforms.packageJson.omitScripts.includes(scriptName),
        `public package may omit ${scriptName} only through the declared transform`,
      );
    } else {
      assert.equal(packageJson.scripts[scriptName], expectedValue);
    }
  }
  assert.equal(packageJson.scripts.prepack, 'node scripts/check-no-pii.mjs --quiet');
  if (packageJson.scripts['test:release'] === undefined) {
    assert.ok(
      manifest.transforms.packageJson.omitScripts.includes('test:release'),
      'public package may omit test:release only through the declared transform',
    );
  } else {
    assert.match(packageJson.scripts['test:release'], /^npm test &&/u);
  }
};

const testRunAllRejectsPartialOrMixedInventory = () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../public-release-manifest.json', import.meta.url), 'utf8'));
  const publicTests = manifest.repository.files
    .filter((file) => /^tests\/.*-test\.js$/u.test(file))
    .map((file) => path.posix.basename(file))
    .sort();
  const root = fs.mkdtempSync(path.join(testTempRoot, 'gigabrain-run-all-inventory-test-'));
  try {
    write(root, 'package.json', '{"type":"module"}\n');
    fs.copyFileSync(new URL('./run-all.js', import.meta.url), path.join(root, 'run-all.js'));
    for (const testFile of publicTests) write(root, testFile, 'export const run = async () => {};\n');

    const exact = spawnSync(process.execPath, ['run-all.js', '--inventory-only'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.equal(exact.status, 0, exact.stderr);
    assert.equal(JSON.parse(exact.stdout).inventoryMode, 'public');

    fs.rmSync(path.join(root, publicTests[0]));
    write(root, 'unit-mixed-inventory-test.js', 'export const run = async () => {};\n');
    const mixed = spawnSync(process.execPath, ['run-all.js', '--inventory-only'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /matches neither the full nor public suite/u);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testNpmInventoryDrift = () => {
  const manifest = baseManifest({ npmFiles: ['package.json'] });
  const { root } = createRepository({ manifest });
  try {
    expectClasses(() => checkPublicMirror({ root, checkHistory: false }), ['UNEXPECTED_NPM_FILE']);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testNpmLinksUsePackageInventory = () => {
  const packageJson = {
    name: '@synthetic/public-mirror-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['docs/guide.md', 'index.js'],
  };
  const manifest = baseManifest({
    files: [
      'LICENSE',
      'docs/guide.md',
      'docs/repository-only.md',
      'index.js',
      'package.json',
      'public-release-manifest.json',
    ],
    packageFiles: packageJson.files,
    npmFiles: ['LICENSE', 'docs/guide.md', 'index.js', 'package.json'],
  });
  const { root } = createRepository({ manifest, packageJson });
  try {
    write(root, 'docs/guide.md', '[Repository-only target](repository-only.md)\n');
    write(root, 'docs/repository-only.md', 'Repository-only documentation.\n');
    assert.throws(
      () => checkPublicMirror({ root, checkHistory: false }),
      (error) => {
        assert.ok(error instanceof PublicMirrorError);
        const classes = new Set(error.findings.map((finding) => finding.class));
        assert.ok(classes.has('BROKEN_NPM_LINK'));
        assert.equal(classes.has('BROKEN_PUBLIC_LINK'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testHistoryEmailAndFreshRootWithoutLeak = () => {
  const { root } = createRepository();
  const personalEmail = 'private.fixture@example.com';
  try {
    runCommand('git', ['config', 'user.email', personalEmail], root);
    write(root, 'index.js', 'export const value = 2;\n');
    runCommand('git', ['add', 'index.js'], root);
    runCommand('git', ['commit', '-qm', 'synthetic second commit'], root);
    assert.throws(
      () => checkPublicMirror({ root, checkNpm: false, requireSingleCommit: true }),
      (error) => {
        assert.ok(error instanceof PublicMirrorError);
        assert.equal(JSON.stringify(error.findings).includes(personalEmail), false);
        const classes = new Set(error.findings.map((finding) => finding.class));
        assert.ok(classes.has('GIT_HISTORY_EMAIL'));
        assert.ok(classes.has('GIT_HISTORY_NOT_FRESH_ROOT'));
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testHistoryRejectsContentOnlyExampleDomain = () => {
  const { root } = createRepository();
  try {
    runCommand('git', ['config', 'user.email', 'release@example.com'], root);
    write(root, 'index.js', 'export const value = 2;\n');
    runCommand('git', ['add', 'index.js'], root);
    runCommand('git', ['commit', '-qm', 'synthetic example-domain author'], root);
    expectClasses(
      () => checkPublicMirror({ root, checkNpm: false }),
      ['GIT_HISTORY_EMAIL'],
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const testNormalPublicHistoryMayGrow = () => {
  const { root } = createRepository();
  try {
    write(root, 'index.js', 'export const value = 2;\n');
    runCommand('git', ['add', 'index.js'], root);
    runCommand('git', ['commit', '-qm', 'synthetic public follow-up'], root);
    const result = checkPublicMirror({ root, checkNpm: false });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

export const run = async () => {
  testValidSyntheticRepositoryAndSafePack();
  testManifestFailsClosed();
  testUnexpectedTrackedAndUntrackedFiles();
  testNarrowRuntimeIgnores();
  testPrivateArtifactClasses();
  testSensitiveContentIsRedacted();
  testMissingRequiredAndUnreviewedBinary();
  testBenchmarkEvidenceSchemaAndDigest();
  testCoordinatorBuildsFreshCandidate();
  testCoordinatorRejectsPartialPackageTransform();
  testCheckerRejectsUnappliedPackageTransform();
  testCoordinatorRejectsDestinationSymlinkIntoSource();
  testCoordinatorRejectsSymlinkedSourceComponent();
  testReleaseManifestStaysNarrow();
  testRunAllRejectsPartialOrMixedInventory();
  testNpmInventoryDrift();
  testNpmLinksUsePackageInventory();
  testHistoryEmailAndFreshRootWithoutLeak();
  testHistoryRejectsContentOnlyExampleDomain();
  testNormalPublicHistoryMayGrow();
};

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  run()
    .then(() => fs.writeSync(1, `${JSON.stringify({ ok: true, test: 'unit-public-mirror-test.js' })}\n`))
    .catch((error) => {
      fs.writeSync(2, `${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
