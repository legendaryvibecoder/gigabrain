import { gigabrainMemoryRuntime } from './openclaw-memory-runtime.js';

const formatJson = (value) => JSON.stringify(value, null, 2);

const printSearchResults = (results = []) => {
  for (const result of results) {
    process.stdout.write(`${result.path}:${result.startLine}-${result.endLine} score=${Number(result.score || 0).toFixed(3)}\n`);
    process.stdout.write(`${result.snippet || ''}\n\n`);
  }
};

const requireManager = async (config, agentId = 'main') => {
  const { manager, error } = await gigabrainMemoryRuntime.getMemorySearchManager({
    cfg: config,
    agentId,
    purpose: 'cli',
  });
  if (!manager) {
    throw new Error(error || 'gigabrain memory manager unavailable');
  }
  return manager;
};

const registerGigabrainMemoryCli = ({ program, config }) => {
  const isMemoryRoot = typeof program?.name === 'function' && String(program.name() || '').trim() === 'memory';
  const memory = isMemoryRoot
    ? program.description('Search and inspect Gigabrain memory')
    : program.command('memory').description('Search and inspect Gigabrain memory');

  memory
    .command('status')
    .description('Show Gigabrain memory backend status')
    .option('--agent <id>', 'Agent id / scope hint', 'main')
    .option('--json', 'Print JSON output')
    .action(async (options) => {
      const manager = await requireManager(config, options.agent);
      const status = manager.status();
      if (options.json) {
        process.stdout.write(`${formatJson(status)}\n`);
        return;
      }
      process.stdout.write(`provider=${status.provider} backend=${status.backend}\n`);
      process.stdout.write(`workspace=${status.workspaceDir}\n`);
      process.stdout.write(`db=${status.dbPath}\n`);
      process.stdout.write(`files=${status.files} chunks=${status.chunks}\n`);
      process.stdout.write(`fts=${status.fts?.available ? 'ready' : 'unavailable'} vector=${status.vector?.available ? 'ready' : status.vector?.enabled ? 'degraded' : 'disabled'}\n`);
    });

  memory
    .command('search <query>')
    .description('Search Gigabrain memory')
    .option('--agent <id>', 'Agent id / scope hint', 'main')
    .option('--limit <n>', 'Maximum results', '8')
    .option('--json', 'Print JSON output')
    .action(async (query, options) => {
      const manager = await requireManager(config, options.agent);
      const results = await manager.search(query, { maxResults: Number(options.limit || 8) || 8 });
      if (options.json) {
        process.stdout.write(`${formatJson(results)}\n`);
        return;
      }
      printSearchResults(results);
    });

  memory
    .command('get <relPath>')
    .description('Read a memory-backed file or virtual Gigabrain record')
    .option('--agent <id>', 'Agent id / scope hint', 'main')
    .option('--from <n>', 'Starting line', '1')
    .option('--lines <n>', 'Number of lines', '120')
    .option('--json', 'Print JSON output')
    .action(async (relPath, options) => {
      const manager = await requireManager(config, options.agent);
      const result = await manager.readFile({
        relPath,
        from: Number(options.from || 1) || 1,
        lines: Number(options.lines || 120) || 120,
      });
      if (options.json) {
        process.stdout.write(`${formatJson(result)}\n`);
        return;
      }
      process.stdout.write(`${result.text || ''}${result.text?.endsWith('\n') ? '' : '\n'}`);
      if (result.truncated && result.nextFrom) {
        process.stdout.write(`\n[next from line ${result.nextFrom}]\n`);
      }
    });
};

const gigabrainMemoryCliDescriptors = [
  {
    name: 'memory',
    description: 'Search and inspect Gigabrain memory',
    hasSubcommands: true,
  },
];

export {
  gigabrainMemoryCliDescriptors,
  registerGigabrainMemoryCli,
};
