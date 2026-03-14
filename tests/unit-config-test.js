import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig, V3_CONFIG_SCHEMA, loadResolvedConfig } from '../lib/core/config.js';
import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import {
  DEFAULT_GLOBAL_STANDALONE_STORE,
  DEFAULT_LEGACY_CODEX_STORE,
  describeStandaloneConfigPath,
  expandHome,
  resolveStandaloneConfigPath,
  resolveRuntimeStandaloneConfigPath,
} from '../lib/core/standalone-client.js';

const run = async () => {
  assert.throws(
    () => normalizeConfig({ memoryRegistryPath: '/tmp/legacy.sqlite' }),
    /deprecated keys/i,
    'legacy key rejection must hard-fail in v3',
  );

  const config = normalizeConfig({
    runtime: {
      paths: {
        workspaceRoot: '/tmp/demo-workspace',
      },
    },
    dedupe: {
      autoThreshold: 0.85,
      reviewThreshold: 0.92,
    },
    recall: {
      classBudgets: {
        core: 2,
        situational: 1,
        decisions: 1,
      },
    },
  });

  assert.equal(config.dedupe.autoThreshold >= config.dedupe.reviewThreshold, true, 'auto threshold must be >= review threshold');
  const budgetTotal = config.recall.classBudgets.core + config.recall.classBudgets.situational + config.recall.classBudgets.decisions;
  assert.equal(Math.abs(budgetTotal - 1) < 0.00001, true, 'class budgets must normalize to 1');
  assert.equal(config.native.syncMode, 'hybrid', 'native sync mode should stay hybrid');
  assert.equal(Array.isArray(config.native.includeFiles), true, 'native include files should normalize to array');
  assert.equal(config.person.keepPublicFacts, true, 'person policy should keep public facts by default');
  assert.equal(config.capture.rememberIntent.enabled, true, 'remember intent should be enabled by default');
  assert.equal(Array.isArray(config.capture.rememberIntent.phrasesBase), true, 'remember intent phrases should normalize');
  assert.equal(config.capture.rememberIntent.writeNative, true, 'remember intent should dual-write to native by default');
  assert.equal(config.nativePromotion.enabled, true, 'native promotion should be enabled by default');
  assert.equal(Number(config.nativePromotion.minConfidence).toFixed(2), '0.72', 'native promotion threshold should default to 0.72');
  assert.equal(String(config.llm.taskProfiles.memory_review.model), 'qwen3.5:9b', 'memory review should default to qwen3.5:9b');
  assert.equal(Number(config.llm.taskProfiles.chat_general.temperature), 1, 'chat general should use official-ish default sampling');
  assert.equal(String(config.llm.review.profile), 'memory_review', 'review profile should default to memory_review');
  assert.equal(String(config.vault.subdir), 'Gigabrain', 'vault mirror should default to Gigabrain subdir');
  assert.equal(String(config.vault.homeNoteName), 'Home', 'vault home note should default to Home');
  assert.deepEqual(config.vault.manualFolders, ['Inbox', 'Manual'], 'vault manual folders should normalize');
  assert.equal(config.vault.views.enabled, true, 'vault views should be enabled by default');
  assert.equal(config.codex.projectScope.startsWith('project:demo-workspace:'), true, 'codex config should derive a stable project scope from the workspace');
  assert.equal(config.codex.defaultProjectScope, config.codex.projectScope, 'codex project scope should default to the derived repo scope');
  assert.equal(config.codex.defaultUserScope, 'profile:user', 'codex user scope should default to profile:user');
  assert.equal(config.codex.projectStorePath, path.join(os.homedir(), '.gigabrain'), 'shared standalone store should default to ~/.gigabrain');
  assert.equal(config.codex.userProfilePath, path.join(os.homedir(), '.gigabrain', 'profile'), 'shared standalone user store should default to ~/.gigabrain/profile');
  assert.deepEqual(config.codex.recallOrder, ['project', 'user', 'remote'], 'codex recall should include the personal store by default');
  assert.equal(config.remoteBridge.enabled, false, 'remote bridge should stay disabled by default');
  assert.equal(Object.keys(V3_CONFIG_SCHEMA.properties || {}).length <= 25, true, 'top-level config keys must stay lean');

  const longSlugConfig = normalizeConfig({
    runtime: {
      paths: {
        workspaceRoot: `/tmp/repo${'-'.repeat(5000)}name`,
      },
    },
    remoteBridge: {
      baseUrl: `https://example.com/api${'/'.repeat(5000)}`,
    },
  });
  assert.equal(longSlugConfig.codex.projectScope.startsWith('project:repo-name:'), true, 'project scope slugging should stay stable for long hyphen-heavy workspace names');
  assert.equal(longSlugConfig.remoteBridge.baseUrl, 'https://example.com/api', 'remote bridge URLs should trim trailing slashes without regex backtracking');

  const standaloneRaw = createStandaloneCodexConfig({
    projectRoot: '/tmp/demo-project',
  });
  const standaloneLoaded = loadResolvedConfig({
    config: standaloneRaw,
  });
  assert.equal(standaloneLoaded.source, 'standalone', 'direct standalone configs should auto-detect');
  assert.equal(standaloneLoaded.config.runtime.paths.workspaceRoot, path.join(os.homedir(), '.gigabrain'), 'standalone configs should default to the shared standalone store');
  assert.equal(standaloneLoaded.config.codex.projectScope.startsWith('project:demo-project:'), true, 'standalone configs should derive a stable repo scope');
  assert.equal(standaloneLoaded.config.codex.defaultProjectScope, standaloneLoaded.config.codex.projectScope, 'standalone configs should use the repo scope as the default project scope');
  assert.equal(standaloneLoaded.config.codex.userProfilePath, path.join(os.homedir(), '.gigabrain', 'profile'), 'standalone configs should default to a shared user store');
  assert.deepEqual(standaloneLoaded.config.codex.recallOrder, ['project', 'user', 'remote'], 'standalone configs should recall project memory before personal memory and remote sources');

  const slugHeavyStandalone = createStandaloneCodexConfig({
    projectRoot: `/tmp/repo${'-'.repeat(5000)}name`,
  });
  assert.equal(slugHeavyStandalone.codex.projectScope.startsWith('project:repo-name:'), true, 'standalone Codex setup should derive project scopes safely from long hyphen-heavy repo names');

  const standaloneLocal = createStandaloneCodexConfig({
    projectRoot: '/tmp/demo-project',
    storeMode: 'project-local',
  });
  assert.equal(standaloneLocal.codex.storeMode, 'project_local', 'project-local mode should normalize');
  assert.equal(standaloneLocal.runtime.paths.workspaceRoot, '/tmp/demo-project/.gigabrain', 'project-local mode should still support repo-local storage');
  assert.equal(standaloneLocal.codex.userProfilePath, '/tmp/demo-project/.gigabrain/profile', 'project-local mode should keep the personal overlay inside the repo-local store');

  const staleStandalone = normalizeConfig({
    runtime: {
      paths: {
        workspaceRoot: '/tmp/demo-workspace',
      },
    },
    codex: {
      projectStorePath: path.join(os.homedir(), '.codex', 'gigabrain'),
      userProfilePath: '',
      recallOrder: ['project', 'remote'],
    },
  });
  assert.equal(staleStandalone.codex.userProfilePath, '', 'explicitly empty legacy userProfilePath values should stay empty until setup migrates them');
  assert.deepEqual(staleStandalone.codex.recallOrder, ['project', 'remote'], 'legacy recall order should keep the user store disabled until setup migrates the config');

  const openclawLoaded = loadResolvedConfig({
    config: {
      plugins: {
        entries: {
          gigabrain: {
            config: standaloneRaw,
          },
        },
      },
    },
  });
  assert.equal(openclawLoaded.source, 'openclaw', 'OpenClaw-wrapped Gigabrain configs should still resolve as plugin configs');

  const describedCanonical = describeStandaloneConfigPath({
    configPath: path.join(os.homedir(), '.gigabrain', 'config.json'),
    projectRoot: '/tmp/demo-project',
    storeMode: 'global',
  });
  assert.equal(describedCanonical.pathKind, 'canonical', 'canonical standalone config should be identified');
  assert.equal(describedCanonical.sharingMode, 'shared-standalone', 'global standalone mode should be reported as shared');

  const describedLegacy = describeStandaloneConfigPath({
    configPath: path.join(os.homedir(), '.codex', 'gigabrain', 'config.json'),
    projectRoot: '/tmp/demo-project',
    storeMode: 'global',
  });
  assert.equal(describedLegacy.pathKind, 'legacy_supported', 'legacy standalone config should be identified');
  assert.equal(describedLegacy.legacyConfigPath, path.join(os.homedir(), '.codex', 'gigabrain', 'config.json'), 'legacy config path should be stable');

  const describedProjectLocal = describeStandaloneConfigPath({
    configPath: '/tmp/demo-project/.gigabrain/config.json',
    projectRoot: '/tmp/demo-project',
    storeMode: 'project-local',
  });
  assert.equal(describedProjectLocal.pathKind, 'project_local', 'project-local standalone config should be identified');
  assert.equal(describedProjectLocal.sharingMode, 'project-local', 'project-local mode should be reported as isolated');

  const resolvedExplicit = resolveStandaloneConfigPath({
    explicitConfigPath: '/tmp/custom/config.json',
    projectRoot: '/tmp/demo-project',
    storeMode: 'global',
  });
  assert.equal(resolvedExplicit.configPath, '/tmp/custom/config.json', 'explicit standalone config path should always win');

  const canonicalDefault = resolveStandaloneConfigPath({
    projectRoot: '/tmp/demo-project',
    storeMode: 'global',
  });
  assert.equal(canonicalDefault.canonicalConfigPath, path.join(DEFAULT_GLOBAL_STANDALONE_STORE, 'config.json'), 'canonical standalone config path should be rooted under ~/.gigabrain');
  assert.equal(canonicalDefault.legacyConfigPath, path.join(DEFAULT_LEGACY_CODEX_STORE, 'config.json'), 'legacy standalone config path should stay discoverable');

  assert.equal(expandHome('${HOME}/.gigabrain/config.json'), path.join(os.homedir(), '.gigabrain', 'config.json'), 'standalone helpers should expand ${HOME} config paths');
  assert.equal(expandHome('$HOME/.gigabrain/config.json'), path.join(os.homedir(), '.gigabrain', 'config.json'), 'standalone helpers should expand $HOME config paths');
  assert.equal(expandHome('~/.gigabrain/config.json'), path.join(os.homedir(), '.gigabrain', 'config.json'), 'standalone helpers should expand ~ config paths');

  const runtimeCanonical = resolveRuntimeStandaloneConfigPath('~/.gigabrain/config.json');
  const runtimeExpectedPath = fs.existsSync(path.join(os.homedir(), '.gigabrain', 'config.json'))
    ? path.join(os.homedir(), '.gigabrain', 'config.json')
    : (fs.existsSync(path.join(os.homedir(), '.codex', 'gigabrain', 'config.json'))
      ? path.join(os.homedir(), '.codex', 'gigabrain', 'config.json')
      : path.join(os.homedir(), '.gigabrain', 'config.json'));
  assert.equal(runtimeCanonical.resolvedPath, runtimeExpectedPath, 'runtime standalone resolution should expand portable canonical paths and respect canonical-then-legacy fallback');
  const runtimeLegacy = resolveRuntimeStandaloneConfigPath('${HOME}/.codex/gigabrain/config.json');
  assert.equal(runtimeLegacy.resolvedPath, path.join(os.homedir(), '.codex', 'gigabrain', 'config.json'), 'runtime standalone resolution should expand portable legacy paths');
};

export { run };
