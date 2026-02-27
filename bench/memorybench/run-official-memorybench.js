#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const withEq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const memoryBenchDir = argValue('--memorybench-dir', process.env.MEMORYBENCH_DIR || `${process.env.HOME}/ext-memorybench`);
const benchmark = argValue('--benchmark', 'longmemeval');
const providers = argValue('--providers', process.env.MEMORYBENCH_PROVIDERS || 'gigabrain,mem0,zep');
const judge = argValue('--judge', process.env.MEMORYBENCH_JUDGE || 'gpt-4o');
const sample = argValue('--sample', process.env.MEMORYBENCH_SAMPLE || '5');

const cmd = ['run', 'src/index.ts', 'compare',
  '-p', providers,
  '-b', benchmark,
  '-j', judge,
  '-s', sample,
];

const res = spawnSync('bun', cmd, {
  cwd: memoryBenchDir,
  encoding: 'utf8',
  env: process.env,
});

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
if (res.status !== 0) {
  process.exit(res.status || 1);
}
