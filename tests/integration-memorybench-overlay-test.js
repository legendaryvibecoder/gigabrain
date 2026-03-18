import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const writeFile = (targetPath, content) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
};

const run = async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-memorybench-overlay-'));
  const memorybenchDir = path.join(tempRoot, 'memorybench');
  fs.mkdirSync(memorybenchDir, { recursive: true });

  writeFile(
    path.join(memorybenchDir, 'src', 'types', 'provider.ts'),
    'export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag"\n'
  );
  writeFile(
    path.join(memorybenchDir, 'src', 'providers', 'index.ts'),
    'import { RAGProvider } from "./rag"\n' +
      'const providers = {\n' +
      '  rag: RAGProvider,\n' +
      '}\n' +
      'export { SupermemoryProvider, Mem0Provider, ZepProvider, FilesystemProvider, RAGProvider }\n'
  );
  writeFile(
    path.join(memorybenchDir, 'src', 'utils', 'config.ts'),
    'export interface Config {\n' +
      '  googleApiKey: string\n' +
      '}\n' +
      'export const config: Config = {\n' +
      '  googleApiKey: process.env.GOOGLE_API_KEY || "",\n' +
      '}\n' +
      'export function getProviderConfig(provider: string) {\n' +
      '  switch (provider) {\n' +
      '    case "filesystem":\n' +
      '      return { apiKey: config.googleApiKey }\n' +
      '    default:\n' +
      '      throw new Error(`Unknown provider: ${provider}`)\n' +
      '  }\n' +
      '}\n'
  );
  writeFile(
    path.join(memorybenchDir, 'src', 'cli', 'index.ts'),
    '  bun run src/index.ts run -p rag -b locomo -j gpt-4o -r run-rag\n' +
      '  filesystem     File-based memory (Claude MEMORY.md / CLAUDE.md style)\n' +
      '                 Extracts structured memories via LLM, stores as Markdown files, text-based search.\n' +
      '                 Requires: OPENAI_API_KEY (for memory extraction via gpt-4o-mini)\n\n' +
      '  -p rag            Use hybrid RAG memory (OpenClaw/QMD style)\n'
  );

  spawnSync('git', ['init'], { cwd: memorybenchDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Codex Test'], { cwd: memorybenchDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: memorybenchDir, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: memorybenchDir, encoding: 'utf8' });
  const commitResult = spawnSync('git', ['commit', '-m', 'seed'], { cwd: memorybenchDir, encoding: 'utf8' });
  assert.equal(commitResult.status, 0, 'temp MemoryBench repo should commit cleanly');
  const head = String(
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: memorybenchDir, encoding: 'utf8' }).stdout
  ).trim();

  const installResult = spawnSync('node', [
    'bench/memorybench/install-official-provider.js',
    '--memorybench-dir',
    memorybenchDir,
    '--expected-memorybench-commit',
    head,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(installResult.status, 0, `installer should succeed: ${installResult.stderr || installResult.stdout}`);

  const providerType = fs.readFileSync(path.join(memorybenchDir, 'src', 'types', 'provider.ts'), 'utf8');
  assert.equal(providerType.includes('"gigabrain"'), true, 'provider type should include gigabrain');

  const providersIndex = fs.readFileSync(path.join(memorybenchDir, 'src', 'providers', 'index.ts'), 'utf8');
  assert.equal(providersIndex.includes('GigabrainProvider'), true, 'providers index should register gigabrain');

  const configFile = fs.readFileSync(path.join(memorybenchDir, 'src', 'utils', 'config.ts'), 'utf8');
  assert.equal(configFile.includes('case "gigabrain":'), true, 'config should wire gigabrain provider config');

  const overlayIndex = path.join(memorybenchDir, 'src', 'providers', 'gigabrain', 'index.ts');
  assert.equal(fs.existsSync(overlayIndex), true, 'gigabrain overlay should be copied into checkout');

  const mismatchResult = spawnSync('node', [
    'bench/memorybench/install-official-provider.js',
    '--memorybench-dir',
    memorybenchDir,
    '--expected-memorybench-commit',
    'deadbeef',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  assert.notEqual(mismatchResult.status, 0, 'installer should reject the wrong pinned MemoryBench commit');
};

export { run };
