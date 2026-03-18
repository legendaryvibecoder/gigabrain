import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'memory-studio-presets.json');
const RUNTIME_PREFIXES = ['bench/memorybench/data/', 'bench/memorybench/vendor/'];
const EPSILON = 1e-9;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const numberOrZero = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');

export const loadMemoryStudioConfig = () => readJson(CONFIG_PATH);

export const getMemoryStudioPreset = (name) => {
  const config = loadMemoryStudioConfig();
  const preset = config?.presets?.[name];
  if (!preset) {
    throw new Error(`Unknown Memory Studio preset: ${name}`);
  }
  return {
    name,
    benchmark: config.memorybench.benchmark,
    provider: config.memorybench.provider,
    samplePerCategory: preset.samplePerCategory,
    sampleType: preset.sampleType || 'consecutive',
    expectedQuestionIds: Array.isArray(preset.expectedQuestionIds) ? [...preset.expectedQuestionIds] : [],
    description: String(preset.description || '').trim(),
  };
};

export const getAllowedCoreFiles = () => {
  const config = loadMemoryStudioConfig();
  return Array.isArray(config.allowedCoreFiles) ? config.allowedCoreFiles.map(normalizePath) : [];
};

export const getRuntimePrefixes = () => [...RUNTIME_PREFIXES];

export const extractReportCard = (report = {}) => ({
  accuracy: numberOrZero(report?.summary?.accuracy),
  hitAtK: numberOrZero(report?.retrieval?.hitAtK),
  mrr: numberOrZero(report?.retrieval?.mrr),
  latencyMs: numberOrZero(report?.latency?.total?.mean || report?.latency?.total?.median),
  singleSessionPreferenceAccuracy: numberOrZero(
    report?.byQuestionType?.['single-session-preference']?.accuracy
  ),
});

export const compareReportCards = (candidate = {}, champion = {}) => {
  const orderedChecks = [
    ['accuracy', 'desc'],
    ['mrr', 'desc'],
    ['hitAtK', 'desc'],
    ['latencyMs', 'asc'],
  ];

  for (const [key, direction] of orderedChecks) {
    const left = numberOrZero(candidate[key]);
    const right = numberOrZero(champion[key]);
    if (Math.abs(left - right) <= EPSILON) continue;
    const better = direction === 'desc' ? left > right : left < right;
    return {
      decision: better ? 'better' : 'worse',
      decisiveMetric: key,
      candidateValue: left,
      championValue: right,
    };
  }

  return {
    decision: 'equal',
    decisiveMetric: null,
    candidateValue: null,
    championValue: null,
  };
};

export const canPromoteMain30 = (candidate = {}, champion = {}) => ({
  accepted:
    numberOrZero(candidate.accuracy) + EPSILON >= numberOrZero(champion.accuracy)
    && numberOrZero(candidate.singleSessionPreferenceAccuracy) + EPSILON
      >= numberOrZero(champion.singleSessionPreferenceAccuracy),
  accuracyFloor: numberOrZero(champion.accuracy),
  preferenceFloor: numberOrZero(champion.singleSessionPreferenceAccuracy),
});

export const findUnexpectedMutations = (changedFiles = [], allowedFiles = [], runtimePrefixes = RUNTIME_PREFIXES) => {
  const allowed = new Set((allowedFiles || []).map(normalizePath));
  return changedFiles
    .map(normalizePath)
    .filter(Boolean)
    .filter((filePath) => !runtimePrefixes.some((prefix) => filePath.startsWith(prefix)))
    .filter((filePath) => !allowed.has(filePath));
};

export const getDefaultBaseline = () => {
  const config = loadMemoryStudioConfig();
  return config?.baseline?.main30 || {};
};

export { CONFIG_PATH };
