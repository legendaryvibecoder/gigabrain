#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const withEq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const defaultExpectedCommit = '59338e40759d6ad0241bdb11a1a65a472209c26c';
const memoryBenchDir = path.resolve(
  argValue('--memorybench-dir', process.env.MEMORYBENCH_DIR || `${process.env.HOME}/ext-memorybench`)
);
const expectedMemoryBenchCommit = argValue(
  '--expected-memorybench-commit',
  process.env.MEMORYBENCH_EXPECTED_COMMIT || defaultExpectedCommit
);
const allowUnpinnedMemoryBench =
  process.argv.includes('--allow-unpinned-memorybench')
  || String(process.env.MEMORYBENCH_ALLOW_UNPINNED || '').trim() === '1';
const overlayDir = path.join(scriptDir, 'provider', 'gigabrain');
const targetProviderDir = path.join(memoryBenchDir, 'src', 'providers', 'gigabrain');

const ensureExists = (targetPath, description) => {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing ${description}: ${targetPath}`);
  }
};

const resolveCheckoutHead = () => {
  const result = spawnSync('git', ['-C', memoryBenchDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to resolve MemoryBench checkout commit at ${memoryBenchDir}: ${
        String(result.stderr || result.stdout || '').trim() || 'git rev-parse failed'
      }`
    );
  }
  return String(result.stdout || '').trim();
};

const replaceOnce = (source, needle, replacement, label) => {
  if (!source.includes(needle)) {
    throw new Error(`Could not patch ${label}; marker not found.`);
  }
  return source.replace(needle, replacement);
};

const patchFile = (filePath, transform) => {
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
  }
};

const installProviderFiles = () => {
  fs.mkdirSync(targetProviderDir, { recursive: true });
  for (const fileName of fs.readdirSync(overlayDir)) {
    const srcPath = path.join(overlayDir, fileName);
    const dstPath = path.join(targetProviderDir, fileName);
    const content = fs.readFileSync(srcPath, 'utf8');
    fs.writeFileSync(dstPath, content, 'utf8');
  }
};

const patchProviderType = () => {
  const filePath = path.join(memoryBenchDir, 'src', 'types', 'provider.ts');
  patchFile(filePath, (source) => {
    if (source.includes('"gigabrain"')) return source;
    return replaceOnce(
      source,
      'export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag"',
      'export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag" | "gigabrain"',
      'ProviderName'
    );
  });
};

const patchProvidersIndex = () => {
  const filePath = path.join(memoryBenchDir, 'src', 'providers', 'index.ts');
  patchFile(filePath, (source) => {
    let next = source;
    if (!next.includes('import { GigabrainProvider } from "./gigabrain"')) {
      next = replaceOnce(
        next,
        'import { RAGProvider } from "./rag"\n',
        'import { RAGProvider } from "./rag"\nimport { GigabrainProvider } from "./gigabrain"\n',
        'providers import'
      );
    }
    if (!next.includes('gigabrain: GigabrainProvider')) {
      next = replaceOnce(
        next,
        '  rag: RAGProvider,\n',
        '  rag: RAGProvider,\n  gigabrain: GigabrainProvider,\n',
        'providers registry'
      );
    }
    if (
      next.includes('export { SupermemoryProvider, Mem0Provider, ZepProvider, FilesystemProvider, RAGProvider }\n')
    ) {
      next = replaceOnce(
        next,
        'export { SupermemoryProvider, Mem0Provider, ZepProvider, FilesystemProvider, RAGProvider }\n',
        'export { SupermemoryProvider, Mem0Provider, ZepProvider, FilesystemProvider, RAGProvider, GigabrainProvider }\n',
        'providers export'
      );
    }
    return next;
  });
};

const patchConfig = () => {
  const filePath = path.join(memoryBenchDir, 'src', 'utils', 'config.ts');
  patchFile(filePath, (source) => {
    let next = source;
    if (!next.includes('gigabrainModuleRoot: string')) {
      next = replaceOnce(
        next,
        '  googleApiKey: string\n',
        '  googleApiKey: string\n  gigabrainModuleRoot: string\n  gigabrainConfigTemplate: string\n  gigabrainStoreRoot: string\n',
        'config interface'
      );
    }
    if (!next.includes('gigabrainModuleRoot: process.env.GIGABRAIN_MODULE_ROOT')) {
      next = replaceOnce(
        next,
        '  googleApiKey: process.env.GOOGLE_API_KEY || "",\n',
        '  googleApiKey: process.env.GOOGLE_API_KEY || "",\n  gigabrainModuleRoot: process.env.GIGABRAIN_MODULE_ROOT || "",\n  gigabrainConfigTemplate: process.env.GIGABRAIN_CONFIG_TEMPLATE || "",\n  gigabrainStoreRoot: process.env.GIGABRAIN_STORE_ROOT || "",\n',
        'config values'
      );
    }
    if (!next.includes('case "gigabrain":')) {
      next = replaceOnce(
        next,
        '    case "filesystem":\n',
        '    case "gigabrain":\n      return {\n        apiKey: "local",\n        gigabrainModuleRoot: config.gigabrainModuleRoot,\n        gigabrainConfigTemplate: config.gigabrainConfigTemplate,\n        gigabrainStoreRoot: config.gigabrainStoreRoot,\n      }\n    case "filesystem":\n',
        'getProviderConfig gigabrain case'
      );
    }
    return next;
  });
};

const patchCliHelp = () => {
  const filePath = path.join(memoryBenchDir, 'src', 'cli', 'index.ts');
  if (!fs.existsSync(filePath)) return;

  patchFile(filePath, (source) => {
    let next = source;
    if (!next.includes('bun run src/index.ts run -p gigabrain -b longmemeval -j gpt-4o -r run-gb')) {
      next = replaceOnce(
        next,
        '  bun run src/index.ts run -p rag -b locomo -j gpt-4o -r run-rag\n',
        '  bun run src/index.ts run -p rag -b locomo -j gpt-4o -r run-rag\n  bun run src/index.ts run -p gigabrain -b longmemeval -j gpt-4o -r run-gb\n',
        'help examples'
      );
    }
    if (!next.includes('gigabrain     Gigabrain local-memory provider')) {
      next = replaceOnce(
        next,
        '  filesystem     File-based memory (Claude MEMORY.md / CLAUDE.md style)\n' +
          '                 Extracts structured memories via LLM, stores as Markdown files, text-based search.\n' +
          '                 Requires: OPENAI_API_KEY (for memory extraction via gpt-4o-mini)\n\n',
        '  filesystem     File-based memory (Claude MEMORY.md / CLAUDE.md style)\n' +
          '                 Extracts structured memories via LLM, stores as Markdown files, text-based search.\n' +
          '                 Requires: OPENAI_API_KEY (for memory extraction via gpt-4o-mini)\n\n' +
          '  gigabrain     Gigabrain local-memory provider\n' +
          '                 Uses a per-container isolated Gigabrain store cloned from a config template.\n' +
          '                 Requires: GIGABRAIN_MODULE_ROOT optional, GIGABRAIN_CONFIG_TEMPLATE optional, plus a judge model key for full runs.\n\n',
        'providers help section'
      );
    }
    if (!next.includes('  -p gigabrain      Use Gigabrain as the memory provider')) {
      next = replaceOnce(
        next,
        '  -p rag            Use hybrid RAG memory (OpenClaw/QMD style)\n',
        '  -p rag            Use hybrid RAG memory (OpenClaw/QMD style)\n  -p gigabrain      Use Gigabrain as the memory provider\n',
        'providers help usage'
      );
    }
    return next;
  });
};

const main = () => {
  ensureExists(memoryBenchDir, 'MemoryBench checkout');
  ensureExists(path.join(memoryBenchDir, 'src', 'providers', 'index.ts'), 'MemoryBench providers index');
  ensureExists(overlayDir, 'Gigabrain provider overlay');

  const checkoutHead = resolveCheckoutHead();
  if (!allowUnpinnedMemoryBench && checkoutHead !== expectedMemoryBenchCommit) {
    throw new Error(
      `MemoryBench checkout mismatch: expected ${expectedMemoryBenchCommit}, found ${checkoutHead}. ` +
      'Use --allow-unpinned-memorybench only when intentionally validating against a different checkout.'
    );
  }

  installProviderFiles();
  patchProviderType();
  patchProvidersIndex();
  patchConfig();
  patchCliHelp();

  const summary = {
    ok: true,
    memorybench_dir: memoryBenchDir,
    provider_dir: targetProviderDir,
    source_repo: repoRoot,
    validated_memorybench_commit: checkoutHead,
    expected_memorybench_commit: expectedMemoryBenchCommit,
    allow_unpinned_memorybench: allowUnpinnedMemoryBench,
    installed_at: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
