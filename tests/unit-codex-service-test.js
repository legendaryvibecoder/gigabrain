import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import {
  bootstrapStandaloneStore,
  runCheckpoint,
  runDoctor,
  runProvenance,
  runRecall,
  runRecent,
  runRemember,
} from '../lib/core/codex-service.js';

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const withTempProject = (prefix, fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectRoot = path.join(root, 'project');
  const globalStorePath = path.join(root, 'codex-home', '.codex', 'gigabrain');
  fs.mkdirSync(projectRoot, { recursive: true });
  return fn({
    root,
    projectRoot,
    configPath: path.join(globalStorePath, 'config.json'),
    globalStorePath,
    userOverlayPath: path.join(root, 'user-profile'),
  });
};

const withRemoteServer = async (handler, fn) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const run = async () => {
  await withTempProject('gb-codex-service-', async ({ projectRoot, configPath, globalStorePath, userOverlayPath }) => {
    const config = createStandaloneCodexConfig({
      projectRoot,
      projectStorePath: globalStorePath,
      userProfilePath: userOverlayPath,
    });
    writeJsonPretty(configPath, config);
    const projectScope = config.codex.projectScope;

    const bootstrap = bootstrapStandaloneStore({ configPath });
    assert.equal(bootstrap.ok, true, 'standalone bootstrap should succeed');
    assert.equal(fs.existsSync(path.join(globalStorePath, 'MEMORY.md')), true, 'shared Codex MEMORY.md should be created');
    assert.equal(fs.existsSync(path.join(userOverlayPath, 'MEMORY.md')), true, 'shared personal MEMORY.md should be created');
    assert.equal(Boolean(bootstrap.stores?.user?.dbPath), true, 'standalone bootstrap should initialize the personal store as well');

    const durable = runRemember({
      configPath,
      target: 'project',
      type: 'DECISION',
      durability: 'durable',
      content: 'Atlas is the codex adapter project for this repo.',
      scope: projectScope,
    });
    assert.equal(durable.ok, true, 'durable remember should succeed');
    assert.equal(durable.written_native, true, 'durable remember should write native');
    assert.equal(durable.written_registry, true, 'durable remember should write registry');
    assert.equal(Boolean(durable.memory_id), true, 'durable remember should return a memory id');

    const projectIdentity = runRemember({
      configPath,
      target: 'project',
      type: 'USER_FACT',
      durability: 'durable',
      content: 'The repo codename is Atlas Beacon.',
      scope: projectScope,
    });
    assert.equal(projectIdentity.ok, true, 'project identity remember should succeed');

    const checkpoint = runCheckpoint({
      configPath,
      sessionLabel: 'MCP hardening',
      summary: 'Implemented Codex App checkpoint capture for Gigabrain.',
      scope: projectScope,
      decisions: ['Use SDK-based MCP transport for Codex App.'],
      openLoops: ['Document the new checkpoint workflow in the README.'],
      touchedFiles: ['lib/core/codex-mcp.js'],
      durableCandidates: ['The repo codename is Atlas Beacon.'],
    });
    assert.equal(checkpoint.ok, true, 'checkpoint should succeed');
    assert.equal(checkpoint.written_native, true, 'checkpoint should write native session logs');
    assert.equal(String(checkpoint.source_path).endsWith('.md'), true, 'checkpoint should write to today’s daily note');
    assert.equal(checkpoint.written_sections.includes('Codex App Sessions'), true, 'checkpoint should include the summary section');

    const ephemeral = runRemember({
      configPath,
      target: 'project',
      type: 'CONTEXT',
      durability: 'ephemeral',
      content: 'Today the sprint accent color is orange.',
      scope: projectScope,
    });
    assert.equal(ephemeral.ok, true, 'ephemeral remember should succeed');
    assert.equal(ephemeral.written_native, true, 'ephemeral remember should write native');
    assert.equal(ephemeral.written_registry, false, 'ephemeral remember should stay native-only');

    const userOverlay = runRemember({
      configPath,
      target: 'user',
      type: 'PREFERENCE',
      durability: 'durable',
      content: 'The user prefers concise release notes.',
    });
    assert.equal(userOverlay.ok, true, 'user overlay remember should succeed');
    assert.equal(userOverlay.written_registry, true, 'user overlay should write registry');
    assert.equal(String(userOverlay.source_path).includes('user-profile'), true, 'user overlay should write into the user profile store');

    const recallProject = await runRecall({
      configPath,
      target: 'project',
      query: 'What is Atlas?',
      topK: 4,
      scope: projectScope,
    });
    assert.equal(recallProject.ok, true, 'project recall should succeed');
    assert.equal(recallProject.results.some((row) => row.content.includes('Atlas is the codex adapter project')), true, 'project recall should surface durable project memory');

    const recallProjectIdentity = await runRecall({
      configPath,
      target: 'project',
      query: 'Atlas Beacon',
      topK: 4,
      scope: projectScope,
    });
    assert.equal(
      recallProjectIdentity.results.some((row) => row.content.includes('Atlas Beacon')),
      true,
      'stable repo codename memories should remain recallable in project scope',
    );

    const recallCheckpoint = await runRecall({
      configPath,
      target: 'project',
      query: 'SDK-based MCP transport',
      topK: 4,
      includeProvenance: true,
      scope: projectScope,
    });
    assert.equal(
      recallCheckpoint.results.some((row) => row.content.includes('SDK-based MCP transport')),
      true,
      'checkpoint session decisions should be recallable from native logs',
    );

    const recallEphemeral = await runRecall({
      configPath,
      target: 'project',
      query: 'sprint accent color orange',
      topK: 4,
      scope: projectScope,
    });
    assert.equal(recallEphemeral.results.some((row) => row.content.includes('accent color is orange')), true, 'native-only notes should be recallable immediately');

    const recallBoth = await runRecall({
      configPath,
      target: 'both',
      query: 'concise release notes',
      topK: 4,
    });
    assert.equal(recallBoth.results[0].origin, 'user', 'both recall should include the user overlay when project has no match');

    const provenance = await runProvenance({
      configPath,
      target: 'project',
      query: 'Atlas',
      scope: projectScope,
    });
    assert.equal(Boolean(provenance.results[0]?.source_path), true, 'provenance should include a source path');
    assert.equal(Number.isFinite(Number(provenance.results[0]?.source_line)), true, 'provenance should include a source line');

    const nativeProvenance = await runProvenance({
      configPath,
      target: 'project',
      memoryId: recallEphemeral.results[0]?.memory_id,
      scope: projectScope,
    });
    assert.equal(
      nativeProvenance.results.some((row) => String(row.memory_id || '').startsWith('native:')),
      true,
      'provenance should resolve native memory ids from recall results',
    );
    assert.equal(Boolean(nativeProvenance.results[0]?.source_path), true, 'native provenance should include a source path');

    const recentProject = runRecent({
      configPath,
      target: 'project',
      limit: 5,
      scope: projectScope,
    });
    assert.equal(recentProject.ok, true, 'project recent listing should succeed');
    assert.equal(recentProject.results.some((row) => row.origin === 'project'), true, 'project recent results should include project memories');

    const recentUser = runRecent({
      configPath,
      target: 'user',
      limit: 5,
    });
    assert.equal(recentUser.ok, true, 'user recent listing should succeed');
    assert.equal(recentUser.results.some((row) => row.origin === 'user'), true, 'user recent results should include user overlay memories');

    const doctor = await runDoctor({
      configPath,
      target: 'both',
    });
    assert.equal(doctor.ok, true, 'doctor should report healthy local stores');
    assert.equal(doctor.stores.length >= 2, true, 'doctor should report both project and user stores');
  });

  await withTempProject('gb-codex-cross-scope-', async ({ root, configPath, globalStorePath, userOverlayPath }) => {
    const projectAlpha = path.join(root, 'alpha');
    const projectBeta = path.join(root, 'beta');
    fs.mkdirSync(projectAlpha, { recursive: true });
    fs.mkdirSync(projectBeta, { recursive: true });

    const configAlphaPath = path.join(root, 'config-alpha.json');
    const configBetaPath = path.join(root, 'config-beta.json');
    const configAlpha = createStandaloneCodexConfig({
      projectRoot: projectAlpha,
      projectStorePath: globalStorePath,
      userProfilePath: userOverlayPath,
    });
    const configBeta = createStandaloneCodexConfig({
      projectRoot: projectBeta,
      projectStorePath: globalStorePath,
      userProfilePath: userOverlayPath,
    });
    writeJsonPretty(configAlphaPath, configAlpha);
    writeJsonPretty(configBetaPath, configBeta);

    bootstrapStandaloneStore({ configPath: configAlphaPath });
    bootstrapStandaloneStore({ configPath: configBetaPath });

    const alphaProject = runRemember({
      configPath: configAlphaPath,
      target: 'project',
      type: 'DECISION',
      durability: 'durable',
      content: 'Alpha repo uses release train A.',
    });
    assert.equal(alphaProject.ok, true, 'project remember for alpha should succeed');

    const alphaUser = runRemember({
      configPath: configAlphaPath,
      target: 'user',
      type: 'PREFERENCE',
      durability: 'durable',
      content: 'The user prefers globally shared Gigabrain memory.',
    });
    assert.equal(alphaUser.ok, true, 'user remember for alpha should succeed');

    const betaProjectRecall = await runRecall({
      configPath: configBetaPath,
      target: 'project',
      query: 'release train A',
      topK: 4,
    });
    assert.equal(
      betaProjectRecall.results.some((row) => row.content.includes('Alpha repo uses release train A.')),
      false,
      'repo-specific project memory should not leak into another repo when relying on default project scope',
    );

    const betaUserRecall = await runRecall({
      configPath: configBetaPath,
      target: 'user',
      query: 'globally shared Gigabrain memory',
      topK: 4,
    });
    assert.equal(
      betaUserRecall.results.some((row) => row.content.includes('The user prefers globally shared Gigabrain memory.')),
      true,
      'personal user memory should remain available across repos that share the same user store',
    );
  });

  await withTempProject('gb-codex-remote-', async ({ projectRoot, configPath, globalStorePath, userOverlayPath }) => {
    await withRemoteServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/gb/health') {
        send({ ok: true });
        return;
      }
      if (url.pathname === '/gb/recall') {
        send({
          ok: true,
          strategy: 'quick_context',
          results: [
            {
              memory_id: 'remote:1',
              content: 'Nimbus remote memory says the launch city is Vienna.',
              type: 'USER_FACT',
              score: 0.91,
              scope: 'shared',
            },
          ],
        });
        return;
      }
      if (url.pathname === '/gb/recall/explain') {
        send({
          ok: true,
          strategy: 'quick_context',
          ranking_mode: 'remote_bridge',
          confidence: 0.91,
          used_world_model: false,
          explain: {
            result_breakdown: ['remote'],
          },
        });
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const config = createStandaloneCodexConfig({
        projectRoot,
        projectStorePath: globalStorePath,
        userProfilePath: userOverlayPath,
        remoteBridge: {
          enabled: true,
          baseUrl,
        },
      });
      writeJsonPretty(configPath, config);
      bootstrapStandaloneStore({ configPath });

      const recall = await runRecall({
        configPath,
        target: 'both',
        query: 'launch city',
        topK: 4,
        scope: config.codex.projectScope,
      });
      assert.equal(recall.results.some((row) => row.origin === 'remote'), true, 'remote bridge results should be merged in both-mode recall');

      const doctor = await runDoctor({
        configPath,
        target: 'both',
      });
      assert.equal(doctor.remote_bridge.ok, true, 'doctor should validate the remote bridge when enabled');
    });
  });
};

export { run };
