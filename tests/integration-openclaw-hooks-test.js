import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

import gigabrainPlugin from '../index.ts';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const slugifyScopeToken = (value = '') => {
  const input = String(value || '').toLowerCase();
  let out = '';
  let lastWasDash = false;
  for (const char of input) {
    const code = char.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      out += char;
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash && out) {
      out += '-';
      lastWasDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out.slice(0, 40);
};

const deriveScopeFromWorkspaceDir = (workspaceDir = '') => {
  const absolute = path.resolve(String(workspaceDir || ''));
  const slug = slugifyScopeToken(path.basename(absolute)) || 'workspace';
  const hash = createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  return `project:${slug}:${hash}`;
};

const registerPlugin = (workspace) => {
  const handlers = new Map();
  const logs = [];
  const api = {
    config: makeConfigObject(workspace).plugins.entries.gigabrain.config,
    logger: {
      info: (msg) => logs.push(['info', String(msg)]),
      warn: (msg) => logs.push(['warn', String(msg)]),
      error: (msg) => logs.push(['error', String(msg)]),
    },
    on: (name, handler) => {
      handlers.set(name, handler);
    },
  };
  gigabrainPlugin.register(api);
  return { handlers, logs };
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v053-openclaw-hooks-');
  const workspaceOnlyDir = path.join(ws.root, 'Agent Workspace', 'CPTO Ops');
  const workspaceOnlyScope = deriveScopeFromWorkspaceDir(workspaceOnlyDir);
  const { handlers, logs } = registerPlugin(ws.workspace);
  const beforeAgentStart = handlers.get('before_agent_start');
  const agentEnd = handlers.get('agent_end');

  assert.equal(typeof beforeAgentStart, 'function', 'plugin should register before_agent_start');
  assert.equal(typeof agentEnd, 'function', 'plugin should register agent_end');

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'm-cpto-roadmap',
        type: 'DECISION',
        scope: 'cpto',
        content: 'The cpto agent owns roadmap planning and release sequencing.',
        normalized: 'the cpto agent owns roadmap planning and release sequencing',
        value_label: 'core',
        value_score: 0.96,
        confidence: 0.93,
      },
      {
        memory_id: 'm-workspace-runbook',
        type: 'USER_FACT',
        scope: workspaceOnlyScope,
        content: 'Workspace-only runbooks are stored under /ops/runbooks/cpto.',
        normalized: 'workspace only runbooks are stored under ops runbooks cpto',
        value_label: 'core',
        value_score: 0.91,
        confidence: 0.88,
      },
    ]);
  } finally {
    db.close();
  }

  const recallResult = await beforeAgentStart(
    {
      messages: [
        { role: 'user', content: 'Who owns roadmap planning?' },
      ],
    },
    {
      agentId: 'cpto',
      sessionKey: 'agent:cpto:slack:ops:123',
      workspaceDir: ws.workspace,
    },
  );

  assert.equal(Boolean(recallResult?.appendSystemContext), true, 'OpenClaw recall hook should return appendSystemContext');
  assert.equal(String(recallResult?.appendSystemContext || '').includes('<gigabrain-context>'), true, 'hook should emit a Gigabrain context block');
  assert.equal(
    String(recallResult?.appendSystemContext || '').includes('roadmap planning and release sequencing'),
    true,
    'hook recall should use ctx-derived agent scope rather than falling back to shared',
  );
  assert.equal('messages' in (recallResult || {}), false, 'hook should not rely on returning a rewritten messages array');

  const workspaceRecall = await beforeAgentStart(
    {
      messages: [
        { role: 'user', content: 'Where are the workspace runbooks stored?' },
      ],
    },
    {
      workspaceDir: workspaceOnlyDir,
    },
  );
  assert.equal(Boolean(workspaceRecall?.appendSystemContext), true, 'workspace-only ctx should still inject recall context');
  assert.equal(
    String(workspaceRecall?.appendSystemContext || '').includes('/ops/runbooks/cpto'),
    true,
    'before_agent_start should derive scope from ctx.workspaceDir when agent identity is missing',
  );

  await agentEnd(
    {
      prompt: 'remember this',
      messages: [
        { role: 'user', content: 'Remember this decision.' },
      ],
      output: '<memory_note type="DECISION" confidence="0.9">The cpto agent prefers weekly roadmap reviews.</memory_note>',
    },
    {
      agentId: 'cpto',
      sessionKey: 'agent:cpto:slack:ops:999',
      workspaceDir: ws.workspace,
    },
  );

  await agentEnd(
    {
      prompt: 'remember this',
      messages: [
        { role: 'user', content: 'Remember the workspace fallback path.' },
      ],
      output: '<memory_note type="USER_FACT" confidence="0.86">The workspace fallback scope was exercised in this test.</memory_note>',
    },
    {
      workspaceDir: workspaceOnlyDir,
    },
  );

  const dbAfter = openDb(ws.dbPath);
  try {
    const stored = dbAfter.prepare(`
      SELECT scope, content
      FROM memory_current
      WHERE normalized LIKE '%weekly roadmap reviews%'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    assert.equal(Boolean(stored), true, 'agent_end should capture memory notes from the hook');
    assert.equal(String(stored.scope || ''), 'cpto', 'captured memory should inherit agent scope from ctx');
    assert.equal(String(stored.content || '').includes('weekly roadmap reviews'), true, 'captured memory content should be stored');

    const workspaceStored = dbAfter.prepare(`
      SELECT scope
      FROM memory_current
      WHERE normalized LIKE '%workspace fallback scope was exercised%'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    assert.equal(Boolean(workspaceStored), true, 'agent_end should persist workspace-only ctx captures');
    assert.equal(
      String(workspaceStored.scope || ''),
      workspaceOnlyScope,
      'agent_end should derive scope from ctx.workspaceDir when agentId/sessionKey are unavailable',
    );
  } finally {
    dbAfter.close();
  }

  assert.equal(
    logs.some(([, msg]) => msg.includes('recall injected')),
    true,
    'hook path should still log successful recall injection',
  );
};

export { run };

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
