import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import {
  bootstrapStandaloneStore,
  runCheckpoint,
  runRecall,
  runRemember,
} from '../lib/core/codex-service.js';
import {
  REMOTE_READ_TOOLS,
  resolveRemoteMcpOptions,
  startRemoteMcpServer,
} from '../lib/core/remote-mcp.js';
import { openDatabase } from '../lib/core/sqlite.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const createClient = async (url, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const client = new Client({ name: 'gigabrain-remote-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
};

const textOf = (response) => response?.content
  ?.filter((item) => item.type === 'text')
  .map((item) => item.text)
  .join('\n') || '';

const assertSuccess = (response, label) => {
  assert.notEqual(response.isError, true, `${label} should succeed: ${textOf(response)}`);
  assert.equal(Boolean(response.structuredContent), true, `${label} should return structured content`);
};

const run = async () => {
  assert.throws(
    () => resolveRemoteMcpOptions({ allowNoAuth: true, host: '127.0.0.1' }),
    /exact allowed memory scope/,
    'even loopback development mode must have an explicit memory-scope allowlist',
  );
  assert.throws(
    () => resolveRemoteMcpOptions({
      allowNoAuth: true,
      host: '127.0.0.1',
      allowedScopes: ['project:*'],
    }),
    /wildcards are not allowed/,
    'remote memory-scope wildcards must fail closed',
  );

  const scratchBase = path.join(REPO_ROOT, '.tmp');
  fs.mkdirSync(scratchBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchBase, 'remote-mcp-'));
  const projectRoot = path.join(root, 'project');
  const projectStorePath = path.join(root, 'store');
  const userProfilePath = path.join(root, 'profile');
  const configPath = path.join(projectStorePath, 'config.json');
  fs.mkdirSync(projectRoot, { recursive: true });

  const config = createStandaloneCodexConfig({ projectRoot, projectStorePath, userProfilePath });
  writeJsonPretty(configPath, config);
  bootstrapStandaloneStore({ configPath });

  const alphaScope = 'project:alpha';
  const betaScope = 'project:beta';
  const alphaMemory = runRemember({
    configPath,
    target: 'project',
    scope: alphaScope,
    type: 'DECISION',
    content: 'Alpha uses the copper lighthouse release policy.',
  });
  const betaMemory = runRemember({
    configPath,
    target: 'project',
    scope: betaScope,
    type: 'DECISION',
    content: 'Beta uses the private violet submarine policy.',
  });
  const userSecret = runRemember({
    configPath,
    target: 'user',
    scope: 'profile:user',
    type: 'USER_FACT',
    content: 'Personal overlay secret uses the topaz snow leopard phrase.',
  });
  const misplacedProfileSecret = runRemember({
    configPath,
    target: 'project',
    scope: 'profile:user',
    type: 'USER_FACT',
    content: 'Legacy project database profile secret uses the amber kestrel phrase.',
  });
  const sharedSecret = runRemember({
    configPath,
    target: 'project',
    scope: 'shared',
    type: 'CONTEXT',
    content: 'Shared memory secret uses the silver narwhal phrase.',
  });
  assert.equal(alphaMemory.recallable, true, 'alpha seed should be recallable');
  assert.equal(betaMemory.recallable, true, 'beta seed should be recallable');
  await assert.rejects(
    () => runRecall({
      configPath,
      target: 'project',
      allowedScopes: [alphaScope, betaScope],
      query: 'release policy',
    }),
    /scope is required when multiple memory scopes are authorized/,
    'multi-scope tokens must choose one exact recall boundary per request',
  );

  const alphaCheckpoint = runCheckpoint({
    configPath,
    scope: alphaScope,
    summary: 'Alpha checkpoint for connector verification.',
    sourceAgent: 'fixture-codex',
    decisions: ['Expose only exact authorized scopes.'],
  });
  const betaCheckpoint = runCheckpoint({
    configPath,
    scope: betaScope,
    summary: 'Beta checkpoint must never cross the alpha boundary.',
    sourceAgent: 'fixture-claude',
  });

  // Leave a deliberately empty world model behind. Authenticated read tools
  // must not repair/rebuild it as a side effect; the connector is a scoped
  // read boundary, not a maintenance trigger.
  const projectDbPath = path.resolve(
    String(config.runtime?.paths?.workspaceRoot || projectStorePath),
    String(config.runtime?.paths?.registryPath || 'memory/registry.sqlite'),
  );
  const emptyWorldDb = openDatabase(projectDbPath);
  const nowIso = new Date().toISOString();
  const nativeFixtures = [
    {
      chunkId: 'native-unscoped-curated',
      sourceKind: 'curated',
      content: 'Curated overlay secret uses the indigo albatross phrase.',
      linkedMemoryId: null,
    },
    {
      chunkId: 'native-unscoped-memory-md',
      sourceKind: 'memory_md',
      content: 'Main profile native secret uses the crimson oriole phrase.',
      linkedMemoryId: null,
    },
    {
      chunkId: 'native-unscoped-daily',
      sourceKind: 'daily_note',
      content: 'Unscoped daily native secret uses the cobalt ibis phrase.',
      linkedMemoryId: null,
    },
    {
      chunkId: 'native-linked-alpha-memory-md',
      sourceKind: 'memory_md',
      content: 'Alpha linked native evidence uses the saffron compass phrase.',
      linkedMemoryId: alphaMemory.memory_id,
    },
  ];
  const insertNativeFixture = emptyWorldDb.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section,
      line_start, line_end, content, normalized, hash, scope,
      linked_memory_id, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active')
  `);
  for (const fixture of nativeFixtures) {
    insertNativeFixture.run(
      fixture.chunkId,
      path.join(projectRoot, `${fixture.chunkId}.md`),
      fixture.sourceKind,
      '2026-08-16',
      'Remote isolation fixture',
      1,
      1,
      fixture.content,
      fixture.content.toLowerCase(),
      `hash-${fixture.chunkId}`,
      fixture.linkedMemoryId,
      nowIso,
      nowIso,
    );
  }
  emptyWorldDb.exec(`
    DELETE FROM memory_entity_relationships;
    DELETE FROM memory_syntheses;
    DELETE FROM memory_open_loops;
    DELETE FROM memory_episodes;
    DELETE FROM memory_beliefs;
    DELETE FROM memory_entity_aliases;
    DELETE FROM memory_entities;
    DELETE FROM memory_claims;
  `);
  emptyWorldDb.close();

  const readToken = 'fixture-read-token';
  let readServer;
  let readClient;
  let writeServer;
  let writeClient;
  try {
    readServer = await startRemoteMcpServer({ configPath }, {
      host: '127.0.0.1',
      port: 0,
      staticToken: readToken,
      allowedScopes: [alphaScope],
      allowedOrigins: ['https://chatgpt.com'],
    });
    const baseUrl = readServer.options.resourceUrl;
    const mcpUrl = `${baseUrl}${readServer.options.mcpPath}`;
    assert.notEqual(new URL(baseUrl).port, '0', 'ephemeral binding should publish its actual resource port');

    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(metadataResponse.status, 200, 'protected-resource metadata should be public');
    const metadata = await metadataResponse.json();
    assert.equal(metadata.resource, baseUrl, 'protected-resource metadata should name the exact resource');
    assert.equal(metadata.scopes_supported.includes('gigabrain:read'), true, 'metadata should advertise read scope');
    assert.equal(
      metadata.scopes_supported.includes('gigabrain:commit'),
      false,
      'read-only deployments must not advertise disabled write scopes',
    );

    const unauthorized = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401, 'missing bearer tokens must fail before MCP dispatch');
    assert.match(
      unauthorized.headers.get('www-authenticate') || '',
      /oauth-protected-resource/,
      'authentication challenge should point clients to protected-resource metadata',
    );

    const badOrigin = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: '{}',
    });
    assert.equal(badOrigin.status, 403, 'an explicitly disallowed browser origin must fail closed');

    const connected = await createClient(mcpUrl, readToken);
    readClient = connected.client;
    const listed = await readClient.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...REMOTE_READ_TOOLS].sort(), 'read-only connector must expose only the remote-safe allowlist');
    assert.equal(names.includes('gigabrain_remember'), false, 'the broad legacy write tool must stay hidden remotely');
    const recallTool = listed.tools.find((tool) => tool.name === 'gigabrain_recall');
    assert.deepEqual(
      recallTool?._meta?.securitySchemes,
      [{ type: 'oauth2', scopes: ['gigabrain:read'] }],
      'remote tools should declare their OAuth scope in MCP metadata',
    );

    const defaultRecall = await readClient.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'copper lighthouse release policy',
        top_k: 5,
      },
    });
    assertSuccess(defaultRecall, 'default remote recall');
    assert.equal(defaultRecall.structuredContent.target, 'project', 'remote recall should default to the project store');
    assert.equal(
      defaultRecall.structuredContent.results.some((row) => row.content.includes('copper lighthouse')),
      true,
      'the single authorized project scope should be selected without a client-supplied scope',
    );

    const recall = await readClient.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'copper lighthouse release policy',
        target: 'project',
        scope: alphaScope,
        top_k: 5,
        include_provenance: true,
      },
    });
    assertSuccess(recall, 'remote recall');
    assert.equal(
      recall.structuredContent.results.some((row) => row.content.includes('copper lighthouse')),
      true,
      'authorized alpha memory should be recalled',
    );
    assert.equal(
      recall.structuredContent.results.some((row) => row.content.includes('violet submarine')),
      false,
      'beta content must not cross the alpha scope boundary',
    );
    assert.equal(
      recall.structuredContent.results.every((row) => row.scope === alphaScope),
      true,
      'every exact-scope recall result, including an authorized native twin, must retain the authorized scope label',
    );
    assert.equal(
      recall.structuredContent.results.every((row) => row.source_path === '' && row.source_line === null),
      true,
      'remote provenance should redact local paths even when requested',
    );
    assert.match(recall.structuredContent.receipt_id, /^rcpt_/, 'remote recall should create an evidence receipt');

    const linkedNativeRecall = await readClient.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'saffron compass',
        target: 'project',
        scope: alphaScope,
        top_k: 5,
      },
    });
    assertSuccess(linkedNativeRecall, 'linked native effective-scope recall');
    assert.equal(
      linkedNativeRecall.structuredContent.results.some((row) => row.content.includes('saffron compass')),
      true,
      'a native mirror linked to an authorized registry memory should remain recallable',
    );
    assert.equal(
      linkedNativeRecall.structuredContent.results.every((row) => row.scope === alphaScope),
      true,
      'a linked native mirror must preserve its registry scope ahead of source-kind defaults',
    );

    for (const [label, phrase] of [
      ['user overlay', 'topaz snow leopard'],
      ['misplaced project profile', 'amber kestrel'],
      ['implicit shared overlay', 'silver narwhal'],
    ]) {
      const deniedOverlayRecall = await readClient.callTool({
        name: 'gigabrain_recall',
        arguments: {
          query: phrase,
          target: 'both',
          top_k: 10,
        },
      });
      assertSuccess(deniedOverlayRecall, `${label} isolation recall`);
      assert.equal(
        deniedOverlayRecall.structuredContent.results.some((row) => row.content.includes(phrase)),
        false,
        `${label} content must not be inherited by an exact project scope`,
      );
    }

    const incompatibleUserTarget = await readClient.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'topaz snow leopard',
        target: 'user',
      },
    });
    assert.equal(incompatibleUserTarget.isError, true, 'a project-scoped token must not query the user store');
    assert.doesNotMatch(textOf(incompatibleUserTarget), /topaz snow leopard/, 'target denial must not disclose profile content');

    const recent = await readClient.callTool({
      name: 'gigabrain_recent',
      arguments: { target: 'both', limit: 50 },
    });
    assertSuccess(recent, 'exact-scope recent');
    assert.equal(
      recent.structuredContent.results.every((row) => row.scope === alphaScope),
      true,
      'recent must exclude profile, shared, and other-project overlays',
    );

    const receipt = await readClient.callTool({
      name: 'gigabrain_receipt_get',
      arguments: { receipt_id: recall.structuredContent.receipt_id, scope: alphaScope },
    });
    assertSuccess(receipt, 'receipt get');
    assert.equal(receipt.structuredContent.receipt.scope, alphaScope, 'receipt should retain the authorized scope');
    assert.equal(
      receipt.structuredContent.receipt.input_refs.every((ref) => !ref.includes('copper lighthouse')),
      true,
      'receipt inputs should contain a query hash, not the raw query',
    );

    const checkpoints = await readClient.callTool({
      name: 'gigabrain_checkpoint_list',
      arguments: { all_scopes: true, include_local_paths: true, limit: 100 },
    });
    assertSuccess(checkpoints, 'checkpoint list');
    assert.equal(
      checkpoints.structuredContent.checkpoints.every((checkpoint) => checkpoint.scope === alphaScope),
      true,
      'all_scopes must not override the token scope allowlist',
    );
    assert.equal(
      checkpoints.structuredContent.checkpoints.every((checkpoint) => checkpoint.repo.root === '' && checkpoint.source_ref.path === ''),
      true,
      'checkpoint list must ignore a remote attempt to re-enable local paths',
    );
    const postReadDb = openDatabase(projectDbPath);
    const postReadEntityCount = Number(postReadDb.prepare('SELECT COUNT(*) AS c FROM memory_entities').get()?.c || 0);
    postReadDb.close();
    assert.equal(postReadEntityCount, 0, 'authenticated checkpoint reads must not rebuild an empty world model');

    const checkpointGet = await readClient.callTool({
      name: 'gigabrain_checkpoint_get',
      arguments: {
        checkpoint_id: alphaCheckpoint.checkpoint_id,
        scope: alphaScope,
        include_local_paths: true,
      },
    });
    assertSuccess(checkpointGet, 'checkpoint get');
    assert.equal(checkpointGet.structuredContent.checkpoint.repo.root, '', 'exact checkpoint get should redact repo root');

    const deniedCheckpoint = await readClient.callTool({
      name: 'gigabrain_checkpoint_get',
      arguments: { checkpoint_id: betaCheckpoint.checkpoint_id, scope: alphaScope },
    });
    assert.equal(deniedCheckpoint.isError, true, 'a guessed cross-scope checkpoint id must be denied');
    assert.doesNotMatch(textOf(deniedCheckpoint), /Beta checkpoint/, 'denial must not disclose checkpoint content');

    const deniedProvenance = await readClient.callTool({
      name: 'gigabrain_provenance',
      arguments: { memory_id: betaMemory.memory_id, target: 'project', scope: alphaScope },
    });
    assertSuccess(deniedProvenance, 'cross-scope provenance lookup');
    assert.equal(deniedProvenance.structuredContent.results.length, 0, 'a guessed cross-scope memory id must return no result');

    for (const [label, memoryId] of [
      ['user overlay', userSecret.memory_id],
      ['misplaced project profile', misplacedProfileSecret.memory_id],
      ['implicit shared overlay', sharedSecret.memory_id],
    ]) {
      const deniedOverlayProvenance = await readClient.callTool({
        name: 'gigabrain_provenance',
        arguments: { memory_id: memoryId, target: 'both' },
      });
      assertSuccess(deniedOverlayProvenance, `${label} provenance isolation`);
      assert.equal(
        deniedOverlayProvenance.structuredContent.results.length,
        0,
        `a guessed ${label} id must return no result`,
      );
    }

    for (const fixture of nativeFixtures.filter((item) => !item.linkedMemoryId)) {
      const deniedNativeProvenance = await readClient.callTool({
        name: 'gigabrain_provenance',
        arguments: {
          memory_id: `native:${fixture.chunkId}`,
          target: 'project',
          scope: alphaScope,
        },
      });
      assertSuccess(deniedNativeProvenance, `${fixture.sourceKind} native direct-id isolation`);
      assert.equal(
        deniedNativeProvenance.structuredContent.results.length,
        0,
        `a guessed ${fixture.sourceKind} native id must not inherit the caller's project scope`,
      );
      assert.doesNotMatch(
        textOf(deniedNativeProvenance),
        new RegExp(fixture.content.split(' uses ')[1].replace(/\.$/, ''), 'i'),
        `${fixture.sourceKind} native denial must not disclose content`,
      );
    }

    const wrongScopeRecall = await readClient.callTool({
      name: 'gigabrain_recall',
      arguments: { query: 'violet submarine', target: 'project', scope: betaScope },
    });
    assert.equal(wrongScopeRecall.isError, true, 'requesting a scope outside the token allowlist must fail before ranking');
    assert.doesNotMatch(textOf(wrongScopeRecall), /private violet submarine policy/, 'scope denial must not leak matching content');

    await readClient.close();
    readClient = null;
    await readServer.close();
    readServer = null;

    const writeToken = 'fixture-owner-token';
    writeServer = await startRemoteMcpServer({ configPath }, {
      host: '127.0.0.1',
      port: 0,
      staticToken: writeToken,
      allowedScopes: [alphaScope],
      enableWrites: true,
    });
    const writeMetadata = await fetch(
      `${writeServer.options.resourceUrl}/.well-known/oauth-protected-resource`,
    ).then((response) => response.json());
    assert.equal(
      writeMetadata.scopes_supported.includes('gigabrain:commit'),
      true,
      'write-enabled deployments should advertise the commit scope',
    );
    const writeConnected = await createClient(
      `${writeServer.options.resourceUrl}${writeServer.options.mcpPath}`,
      writeToken,
    );
    writeClient = writeConnected.client;
    const writeTools = await writeClient.listTools();
    const writeNames = writeTools.tools.map((tool) => tool.name);
    assert.equal(writeNames.includes('gigabrain_checkpoint'), true, 'write-enabled owner connector should expose checkpoint');
    assert.equal(writeNames.includes('gigabrain_claim_propose'), true, 'write-enabled owner connector should expose proposal creation');
    assert.equal(writeNames.includes('gigabrain_claim_decide'), true, 'write-enabled owner connector should expose manual claim decisions');
    assert.equal(writeNames.includes('gigabrain_remember'), false, 'write-enabled remote mode should still hide broad direct remember');
    assert.deepEqual(
      writeTools.tools.find((tool) => tool.name === 'gigabrain_claim_decide')?._meta?.securitySchemes,
      [{ type: 'oauth2', scopes: ['gigabrain:commit'] }],
      'commit tool metadata should advertise its narrower OAuth scope',
    );

    const remoteCheckpoint = await writeClient.callTool({
      name: 'gigabrain_checkpoint',
      arguments: {
        scope: alphaScope,
        summary: 'Remote checkpoint with a defeasible candidate.',
        durable_candidates: ['Alpha should use receipt-bound connector answers.'],
      },
    });
    assertSuccess(remoteCheckpoint, 'remote checkpoint write');
    assert.equal(remoteCheckpoint.structuredContent.source_path, '', 'remote checkpoint write response must redact its local path');
    assert.equal(remoteCheckpoint.structuredContent.proposal_ids.length, 1, 'durable candidates should become proposals');

    const proposed = await writeClient.callTool({
      name: 'gigabrain_claim_propose',
      arguments: {
        scope: alphaScope,
        claim_type: 'DECISION',
        content: 'Alpha publishes only receipt-bound connector answers.',
        evidence_class: 'project_decision',
        evidence_refs: [`checkpoint:${remoteCheckpoint.structuredContent.checkpoint_id}`],
      },
    });
    assertSuccess(proposed, 'claim proposal');
    assert.equal(proposed.structuredContent.recallable, false, 'proposal creation must not make a claim recallable');

    const decided = await writeClient.callTool({
      name: 'gigabrain_claim_decide',
      arguments: {
        proposal_id: proposed.structuredContent.proposal.proposal_id,
        action: 'accepted',
        reason: 'Owner-reviewed connector policy decision.',
        scope: alphaScope,
        authority: 'owner',
      },
    });
    assertSuccess(decided, 'claim decision');
    assert.equal(decided.structuredContent.action, 'accepted', 'manual acceptance should be recorded');
    assert.equal(decided.structuredContent.memory.recallable, true, 'accepted decision should use the explicit memory commit path');
    assert.equal(decided.structuredContent.memory.source_path, '', 'remote commit response must redact its local path');
  } finally {
    if (readClient) await readClient.close().catch(() => {});
    if (writeClient) await writeClient.close().catch(() => {});
    if (readServer) await readServer.close().catch(() => {});
    if (writeServer) await writeServer.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { run };
