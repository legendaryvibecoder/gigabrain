import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runCommand = ({
  cmd,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeout = 120_000,
  label = '',
} = {}) => {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${label || cmd} terminated by ${result.signal}:\n${result.stderr || result.stdout}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label || cmd} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
};

const packRepo = ({ repoRoot, prefix = 'gb-packaged-' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const packed = runCommand({
    cmd: 'npm',
    args: ['pack', repoRoot],
    cwd: root,
    label: 'npm pack',
  });
  const tarballName = String(packed.stdout || '').trim().split('\n').filter(Boolean).pop();
  return {
    root,
    tarballPath: path.join(root, tarballName),
  };
};

const installTarballIntoTempApp = ({ tarballPath, prefix = 'gb-installed-app-' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runCommand({
    cmd: 'npm',
    args: ['init', '-y'],
    cwd: root,
    label: 'npm init',
  });
  runCommand({
    cmd: 'npm',
    args: ['install', tarballPath],
    cwd: root,
    label: 'npm install tarball',
  });
  return {
    appRoot: root,
    packageRoot: path.join(root, 'node_modules', '@legendaryvibecoder', 'gigabrain'),
  };
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export {
  runCommand,
  packRepo,
  installTarballIntoTempApp,
  readJson,
};
