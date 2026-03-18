import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildGigabrainCliResolverSnippet,
  isEphemeralPackageRootHint,
  readPackageSpecFromRoot,
} from '../lib/core/standalone-client.js';

const writeExecutable = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-standalone-client-'));
  const projectRoot = path.join(root, 'project');
  const stablePackageRoot = path.join(root, 'stable-package');
  const ephemeralPackageRoot = path.join(root, 'npm-cache', '_npx', 'abc123', 'node_modules', '@legendaryvibecoder', 'gigabrain');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(stablePackageRoot, { recursive: true });
  fs.mkdirSync(ephemeralPackageRoot, { recursive: true });
  fs.writeFileSync(path.join(stablePackageRoot, 'package.json'), JSON.stringify({
    name: '@legendaryvibecoder/gigabrain',
    version: '0.6.0',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(ephemeralPackageRoot, 'package.json'), JSON.stringify({
    name: '@legendaryvibecoder/gigabrain',
    version: '0.6.0',
  }, null, 2), 'utf8');
  fs.mkdirSync(path.join(stablePackageRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(stablePackageRoot, 'scripts', 'gigabrain-mcp.js'), 'console.log("stable hint used");\n', 'utf8');

  assert.equal(readPackageSpecFromRoot(stablePackageRoot), '@legendaryvibecoder/gigabrain@0.6.0', 'package spec reader should extract name and version');
  assert.equal(isEphemeralPackageRootHint(stablePackageRoot), false, 'stable package roots should not be treated as ephemeral');
  assert.equal(isEphemeralPackageRootHint(ephemeralPackageRoot), true, 'npx cache package roots should be treated as ephemeral');

  const ephemeralSnippet = buildGigabrainCliResolverSnippet({
    projectRoot,
    packageRootHint: ephemeralPackageRoot,
  });
  assert.equal(ephemeralSnippet.includes(path.resolve(ephemeralPackageRoot)), false, 'ephemeral npx cache paths should not be embedded into generated helpers');
  assert.equal(ephemeralSnippet.includes('PACKAGE_SPEC'), true, 'resolver should include a durable package spec fallback');
  assert.equal(ephemeralSnippet.includes('npx --yes --package "$PACKAGE_SPEC" "$tool" "$@"'), true, 'resolver should use a package-spec npx fallback');

  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const npxLog = path.join(root, 'npx.log');
  writeExecutable(path.join(fakeBin, 'npx'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(npxLog)}
if [ "$1" = "--no-install" ]; then
  exit 1
fi
if [ "$1" = "--yes" ] && [ "$2" = "--package" ]; then
  exit 0
fi
exit 1
`);

  const ephemeralScript = path.join(root, 'run-ephemeral.sh');
  writeExecutable(ephemeralScript, `#!/usr/bin/env bash
set -euo pipefail
${ephemeralSnippet}
run_gigabrain_cli gigabrain-mcp scripts/gigabrain-mcp.js --config /tmp/gigabrain.json
`);
  const ephemeralRun = spawnSync(ephemeralScript, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  });
  assert.equal(ephemeralRun.status, 0, 'ephemeral resolver should fall through to the durable npx package fallback');
  const npxCalls = fs.readFileSync(npxLog, 'utf8');
  assert.match(npxCalls, /--no-install gigabrain-mcp --help/, 'resolver should first probe local/global npx availability without install');
  assert.match(npxCalls, /--yes --package @legendaryvibecoder\/gigabrain@0\.6\.0 gigabrain-mcp --config \/tmp\/gigabrain\.json/, 'resolver should fall back to the package-spec npx path');

  const stableSnippet = buildGigabrainCliResolverSnippet({
    projectRoot,
    packageRootHint: stablePackageRoot,
  });
  assert.equal(stableSnippet.includes(path.resolve(stablePackageRoot)), true, 'stable package roots should remain available as a source hint');

  const nodeLog = path.join(root, 'node.log');
  writeExecutable(path.join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > ${JSON.stringify(nodeLog)}
exit 0
`);
  const stableScript = path.join(root, 'run-stable.sh');
  writeExecutable(stableScript, `#!/usr/bin/env bash
set -euo pipefail
${stableSnippet}
run_gigabrain_cli gigabrain-mcp scripts/gigabrain-mcp.js --config /tmp/gigabrain.json
`);
  const stableRun = spawnSync(stableScript, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  });
  assert.equal(stableRun.status, 0, 'stable resolver should be able to use the stable setup-time source hint');
  assert.match(fs.readFileSync(nodeLog, 'utf8'), /scripts\/gigabrain-mcp\.js --config \/tmp\/gigabrain\.json/, 'stable resolver should execute the hinted package script through node');
};

export { run };
