#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const withEq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const runScript = path.join(process.cwd(), 'bench', 'memorybench', 'run.js');
const baseFilesPattern = argValue('--base', '');
const candFilesPattern = argValue('--cand', '');
const baseA = argValue('--base-a', process.env.GB_COMPARE_BASE_A || '');
const tokenA = argValue('--token-a', process.env.GB_COMPARE_TOKEN_A || process.env.GB_UI_TOKEN || '');
const labelA = argValue('--label-a', 'vCurrent');
const baseB = argValue('--base-b', process.env.GB_COMPARE_BASE_B || '');
const tokenB = argValue('--token-b', process.env.GB_COMPARE_TOKEN_B || process.env.GB_UI_TOKEN || '');
const labelB = argValue('--label-b', 'vNext');
const runs = argValue('--runs', '3');
const cases = argValue('--cases', path.join(process.cwd(), 'eval', 'cases.jsonl'));
const topK = argValue('--topk', '8');

const median = (values) => {
  const cleaned = values.filter((v) => Number.isFinite(v));
  if (cleaned.length === 0) return 0;
  const sorted = [...cleaned].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const runOne = (base, token) => {
  const res = spawnSync('node', [runScript,
    '--base-url', base,
    '--token', token,
    '--cases', cases,
    '--runs', runs,
    '--topk', topK,
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`run.js failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  const parsed = JSON.parse((res.stdout || '{}').trim());
  return parsed;
};

const globToRegex = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
};

const expandPattern = (pattern) => {
  if (!pattern) return [];
  const abs = path.resolve(pattern);
  if (!abs.includes('*')) return fs.existsSync(abs) ? [abs] : [];
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) return [];
  const re = globToRegex(abs);
  return fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((p) => re.test(p));
};

const summarizeFileRuns = (paths, label) => {
  const parsed = [];
  for (const p of paths) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      parsed.push(raw);
    } catch {
      // skip invalid run file
    }
  }
  const recalls = parsed.map((r) => Number(r?.metrics?.recall_at_k_median)).filter(Number.isFinite);
  const top1 = parsed.map((r) => Number(r?.metrics?.top1_hit_rate_median)).filter(Number.isFinite);
  const p50 = parsed.map((r) => Number(r?.metrics?.latency_p50_ms_median)).filter(Number.isFinite);
  const p95 = parsed.map((r) => Number(r?.metrics?.latency_p95_ms_median)).filter(Number.isFinite);
  return {
    label,
    files: paths,
    recall_at_k_median: median(recalls),
    top1_hit_rate_median: median(top1),
    latency_p50_ms_median: median(p50),
    latency_p95_ms_median: median(p95),
  };
};

try {
  let summaryA;
  let summaryB;
  const fileMode = Boolean(baseFilesPattern && candFilesPattern);

  if (fileMode) {
    const baseFiles = expandPattern(baseFilesPattern);
    const candFiles = expandPattern(candFilesPattern);
    if (baseFiles.length === 0 || candFiles.length === 0) {
      throw new Error(`file compare mode requires matching files. base=${baseFiles.length} cand=${candFiles.length}`);
    }
    summaryA = summarizeFileRuns(baseFiles, labelA);
    summaryB = summarizeFileRuns(candFiles, labelB);
  } else {
    if (!baseA || !baseB || !tokenA || !tokenB) {
      console.error('Missing compare inputs. Use either --base/--cand run files OR --base-a --base-b --token-a --token-b');
      process.exit(1);
    }
    const a = runOne(baseA, tokenA);
    const b = runOne(baseB, tokenB);
    summaryA = {
      label: labelA,
      base_url: baseA,
      recall_at_k_median: a?.metrics?.recall_at_k_median ?? 0,
      top1_hit_rate_median: a?.metrics?.top1_hit_rate_median ?? 0,
      latency_p50_ms_median: a?.metrics?.latency_p50_ms_median ?? 0,
      latency_p95_ms_median: a?.metrics?.latency_p95_ms_median ?? 0,
    };
    summaryB = {
      label: labelB,
      base_url: baseB,
      recall_at_k_median: b?.metrics?.recall_at_k_median ?? 0,
      top1_hit_rate_median: b?.metrics?.top1_hit_rate_median ?? 0,
      latency_p50_ms_median: b?.metrics?.latency_p50_ms_median ?? 0,
      latency_p95_ms_median: b?.metrics?.latency_p95_ms_median ?? 0,
    };
  }

  const out = {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: fileMode ? 'run-files' : 'live-endpoints',
    compare: [summaryA, summaryB],
    delta: {
      recall_at_k_median: Number(summaryB.recall_at_k_median || 0) - Number(summaryA.recall_at_k_median || 0),
      top1_hit_rate_median: Number(summaryB.top1_hit_rate_median || 0) - Number(summaryA.top1_hit_rate_median || 0),
      latency_p50_ms_median: Number(summaryB.latency_p50_ms_median || 0) - Number(summaryA.latency_p50_ms_median || 0),
      latency_p95_ms_median: Number(summaryB.latency_p95_ms_median || 0) - Number(summaryA.latency_p95_ms_median || 0),
    },
  };
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
