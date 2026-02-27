#!/usr/bin/env node
/**
 * graph-build.js — Build graph.db from memory_entity_mentions and memory_relations.
 *
 * Reads registry.sqlite, extracts entity co-occurrence graph, explicit relations,
 * and runs label propagation community detection to produce clusters.
 *
 * Output: graph.db (SQLite) with tables: nodes, edges, clusters, cluster_members
 *
 * Usage:
 *   node scripts/graph-build.js --config ~/.openclaw/openclaw.json
 *   node scripts/graph-build.js --db ~/.openclaw/gigabrain/memory/registry.sqlite --out ~/.openclaw/gigabrain/memory/graph.db
 */
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../lib/core/sqlite.js';
import { loadResolvedConfig } from '../lib/core/config.js';

/* ── CLI flags ─────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const withEq = args.find((a) => String(a || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const configPath = readFlag('--config', '');
const loaded = loadResolvedConfig({ configPath: configPath || undefined });
const defaultDbPath = String(
  loaded?.config?.runtime?.paths?.registryPath
  || path.join(process.env.HOME || '', '.openclaw', 'gigabrain', 'memory', 'registry.sqlite'),
).trim();

const dbPath = path.resolve(readFlag('--db', defaultDbPath));
const outPath = path.resolve(readFlag('--out', path.join(path.dirname(dbPath), 'graph.db')));

if (!fs.existsSync(dbPath)) {
  console.error(`registry.sqlite not found: ${dbPath}`);
  process.exit(1);
}

console.log(`[graph-build] registry: ${dbPath}`);
console.log(`[graph-build] output:   ${outPath}`);

/* ── Stopwords — filter noise entities ─────────────────────────── */
const STOPWORDS = new Set([
  'the', 'this', 'that', 'user', 'agent', 'assistant', 'after', 'key',
  'keep', 'it', 'they', 'we', 'he', 'she', 'a', 'an', 'one', 'two',
  'three', 'all', 'any', 'some', 'each', 'his', 'her', 'its', 'our',
  'my', 'your', 'their', 'new', 'old', 'first', 'last', 'make', 'use',
  'set', 'get', 'add', 'run', 'see', 'now', 'also', 'still', 'just',
  'back', 'here', 'there', 'when', 'where', 'how', 'what', 'which',
  'who', 'more', 'most', 'very', 'only', 'then', 'well', 'not', 'but',
  'and', 'for', 'with', 'from', 'into', 'over', 'about', 'between',
  'through', 'during', 'before', 'above', 'below', 'has', 'have', 'had',
  'does', 'did', 'will', 'can', 'may', 'should', 'would', 'could',
  'being', 'been', 'are', 'was', 'were', 'is', 'be', 'do', 'no', 'yes',
  'if', 'or', 'so', 'at', 'to', 'of', 'on', 'in', 'up', 'out', 'off',
  'than', 'like', 'per', 'via',
]);

/* Min mentions to become a node (filters one-off noise) */
const MIN_MENTIONS = 2;

/* ── Read registry ────────────────────────────────────────────── */
const reg = openDatabase(dbPath, { readOnly: true });

// Entity mentions grouped by memory
const mentionRows = reg.prepare(`
  SELECT memory_id, entity_key, entity_display, role, confidence, source
  FROM memory_entity_mentions
`).all();

// Entity mention counts
const entityCounts = new Map();
for (const row of mentionRows) {
  const key = String(row.entity_key).toLowerCase().trim();
  entityCounts.set(key, (entityCounts.get(key) || 0) + 1);
}

// Filter: keep entities with >= MIN_MENTIONS and not stopwords
const validEntity = (key) => {
  const k = String(key).toLowerCase().trim();
  if (k.length < 2) return false;
  if (STOPWORDS.has(k)) return false;
  if ((entityCounts.get(k) || 0) < MIN_MENTIONS) return false;
  return true;
};

// Build entity node map: entity_key -> { display, role, mentions, memoryIds }
const entityNodes = new Map();
const memoryEntities = new Map(); // memory_id -> [entity_key, ...]

for (const row of mentionRows) {
  const key = String(row.entity_key).toLowerCase().trim();
  if (!validEntity(key)) continue;

  if (!entityNodes.has(key)) {
    entityNodes.set(key, {
      key,
      display: String(row.entity_display || key),
      role: String(row.role || 'general'),
      mentions: 0,
      memoryIds: new Set(),
    });
  }
  const node = entityNodes.get(key);
  node.mentions += 1;
  node.memoryIds.add(String(row.memory_id));

  const mid = String(row.memory_id);
  if (!memoryEntities.has(mid)) memoryEntities.set(mid, []);
  memoryEntities.get(mid).push(key);
}

console.log(`[graph-build] ${entityNodes.size} entity nodes (filtered from ${entityCounts.size} total, min ${MIN_MENTIONS} mentions)`);

// Explicit memory relations
const relRows = reg.prepare(`
  SELECT id, from_memory_id, to_memory_id, relation_type, confidence
  FROM memory_relations
`).all();

reg.close();

/* ── Build co-occurrence edges ────────────────────────────────── */
// Two entities mentioned in the same memory = edge (weight += 1)
const edgeMap = new Map(); // "a|b" -> { from, to, type, weight, memoryIds }

const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

for (const [memId, entities] of memoryEntities) {
  const unique = [...new Set(entities)];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const ek = edgeKey(unique[i], unique[j]);
      if (!edgeMap.has(ek)) {
        edgeMap.set(ek, {
          from: unique[i],
          to: unique[j],
          type: 'co_occurrence',
          weight: 0,
          memoryIds: new Set(),
        });
      }
      const e = edgeMap.get(ek);
      e.weight += 1;
      e.memoryIds.add(memId);
    }
  }
}

// Add explicit relations as edges between the entities of those memories
for (const rel of relRows) {
  const fromMid = String(rel.from_memory_id);
  const toMid = String(rel.to_memory_id);
  const fromEnts = memoryEntities.get(fromMid) || [];
  const toEnts = memoryEntities.get(toMid) || [];
  // Cross-product entity connections
  for (const fe of fromEnts) {
    for (const te of toEnts) {
      if (fe === te) continue;
      const ek = edgeKey(fe, te);
      if (!edgeMap.has(ek)) {
        edgeMap.set(ek, {
          from: fe,
          to: te,
          type: 'relation',
          weight: 0,
          memoryIds: new Set(),
        });
      }
      const e = edgeMap.get(ek);
      e.weight += 1;
      e.type = 'relation'; // upgrade if explicit
      e.memoryIds.add(fromMid);
      e.memoryIds.add(toMid);
    }
  }
}

// Filter edges with weight >= 2 to reduce noise (single co-occurrences are weak)
const MIN_EDGE_WEIGHT = 2;
const filteredEdges = [];
for (const [, edge] of edgeMap) {
  if (edge.weight >= MIN_EDGE_WEIGHT) {
    filteredEdges.push(edge);
  }
}

console.log(`[graph-build] ${filteredEdges.length} edges (weight >= ${MIN_EDGE_WEIGHT}, from ${edgeMap.size} raw)`);

/* ── Cluster: Label Propagation ───────────────────────────────── */
// Build adjacency list from filtered edges
const adj = new Map(); // entity_key -> Map<neighbor, weight>

for (const edge of filteredEdges) {
  if (!adj.has(edge.from)) adj.set(edge.from, new Map());
  if (!adj.has(edge.to)) adj.set(edge.to, new Map());
  adj.get(edge.from).set(edge.to, edge.weight);
  adj.get(edge.to).set(edge.from, edge.weight);
}

// Label propagation: each node starts with its own label
// Iterate: each node adopts the most common label among its weighted neighbors
const labels = new Map();
const connectedNodes = [...adj.keys()];
for (const n of connectedNodes) labels.set(n, n);

const MAX_ITERATIONS = 50;
for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
  let changed = 0;
  // Randomize order each iteration
  const shuffled = [...connectedNodes].sort(() => Math.random() - 0.5);
  for (const node of shuffled) {
    const neighbors = adj.get(node);
    if (!neighbors || neighbors.size === 0) continue;
    // Count weighted votes for each label
    const votes = new Map();
    for (const [neighbor, weight] of neighbors) {
      const lbl = labels.get(neighbor);
      votes.set(lbl, (votes.get(lbl) || 0) + weight);
    }
    // Pick label with max votes (tie-break: keep current)
    let bestLabel = labels.get(node);
    let bestScore = votes.get(bestLabel) || 0;
    for (const [lbl, score] of votes) {
      if (score > bestScore) {
        bestLabel = lbl;
        bestScore = score;
      }
    }
    if (bestLabel !== labels.get(node)) {
      labels.set(node, bestLabel);
      changed++;
    }
  }
  if (changed === 0) {
    console.log(`[graph-build] label propagation converged at iteration ${iter + 1}`);
    break;
  }
}

// Group by label -> cluster
const clusterMap = new Map(); // label -> [entity_key, ...]
for (const [node, label] of labels) {
  if (!clusterMap.has(label)) clusterMap.set(label, []);
  clusterMap.get(label).push(node);
}

// Filter clusters: min 3 members
const MIN_CLUSTER_SIZE = 3;
const clusters = [];
let clusterId = 0;
for (const [label, members] of clusterMap) {
  if (members.length < MIN_CLUSTER_SIZE) continue;
  // Pick representative: highest mention count
  const sorted = [...members].sort((a, b) => {
    const ma = entityNodes.get(a)?.mentions || 0;
    const mb = entityNodes.get(b)?.mentions || 0;
    return mb - ma;
  });
  const representative = sorted[0];
  const repNode = entityNodes.get(representative);
  clusters.push({
    id: clusterId++,
    label: repNode?.display || representative,
    representative,
    size: members.length,
    members,
  });
}

// Sort clusters by size desc
clusters.sort((a, b) => b.size - a.size);
// Re-assign IDs after sorting
clusters.forEach((c, i) => { c.id = i; });

console.log(`[graph-build] ${clusters.length} clusters (min size ${MIN_CLUSTER_SIZE})`);

/* ── Write graph.db ───────────────────────────────────────────── */
// Remove old file
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

const gdb = openDatabase(outPath);
gdb.exec('PRAGMA journal_mode = WAL');

gdb.exec(`
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_key TEXT NOT NULL UNIQUE,
    display TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'general',
    mentions INTEGER NOT NULL DEFAULT 0,
    cluster_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_nodes_entity ON nodes(entity_key);
  CREATE INDEX idx_nodes_cluster ON nodes(cluster_id);

  CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    edge_type TEXT NOT NULL DEFAULT 'co_occurrence',
    weight INTEGER NOT NULL DEFAULT 1,
    memory_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_entity, to_entity)
  );
  CREATE INDEX idx_edges_from ON edges(from_entity);
  CREATE INDEX idx_edges_to ON edges(to_entity);
  CREATE INDEX idx_edges_weight ON edges(weight DESC);

  CREATE TABLE clusters (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    representative TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE cluster_members (
    cluster_id INTEGER NOT NULL,
    entity_key TEXT NOT NULL,
    PRIMARY KEY (cluster_id, entity_key),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id),
    FOREIGN KEY (entity_key) REFERENCES nodes(entity_key)
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Build cluster lookup: entity -> cluster_id
const entityCluster = new Map();
for (const c of clusters) {
  for (const m of c.members) {
    entityCluster.set(m, c.id);
  }
}

// Insert nodes
const insertNode = gdb.prepare(
  `INSERT INTO nodes (entity_key, display, role, mentions, cluster_id)
   VALUES (?, ?, ?, ?, ?)`
);

let nodeCount = 0;
gdb.exec('BEGIN');
for (const [key, node] of entityNodes) {
  // Only insert nodes that participate in at least one filtered edge
  if (adj.has(key)) {
    insertNode.run(key, node.display, node.role, node.mentions, entityCluster.get(key) ?? null);
    nodeCount++;
  }
}
gdb.exec('COMMIT');

// Insert edges
const insertEdge = gdb.prepare(
  `INSERT INTO edges (from_entity, to_entity, edge_type, weight, memory_ids)
   VALUES (?, ?, ?, ?, ?)`
);

gdb.exec('BEGIN');
for (const edge of filteredEdges) {
  const memIds = [...edge.memoryIds].slice(0, 20).join(','); // cap stored IDs
  insertEdge.run(edge.from, edge.to, edge.type, edge.weight, memIds);
}
gdb.exec('COMMIT');

// Insert clusters
const insertCluster = gdb.prepare(
  `INSERT INTO clusters (id, label, representative, size) VALUES (?, ?, ?, ?)`
);
const insertMember = gdb.prepare(
  `INSERT OR IGNORE INTO cluster_members (cluster_id, entity_key) VALUES (?, ?)`
);

gdb.exec('BEGIN');
for (const c of clusters) {
  insertCluster.run(c.id, c.label, c.representative, c.size);
  for (const m of c.members) {
    insertMember.run(c.id, m);
  }
}
gdb.exec('COMMIT');

// Insert metadata
const insertMeta = gdb.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);
gdb.exec('BEGIN');
insertMeta.run('built_at', new Date().toISOString());
insertMeta.run('source_db', dbPath);
insertMeta.run('node_count', String(nodeCount));
insertMeta.run('edge_count', String(filteredEdges.length));
insertMeta.run('cluster_count', String(clusters.length));
insertMeta.run('min_mentions', String(MIN_MENTIONS));
insertMeta.run('min_edge_weight', String(MIN_EDGE_WEIGHT));
insertMeta.run('min_cluster_size', String(MIN_CLUSTER_SIZE));
gdb.exec('COMMIT');

gdb.close();

const stat = fs.statSync(outPath);
console.log(`[graph-build] Done: ${nodeCount} nodes, ${filteredEdges.length} edges, ${clusters.length} clusters`);
console.log(`[graph-build] ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`);

// Output JSON summary for programmatic consumption
const summary = {
  ok: true,
  nodes: nodeCount,
  edges: filteredEdges.length,
  clusters: clusters.length,
  topClusters: clusters.slice(0, 10).map((c) => ({
    id: c.id,
    label: c.label,
    size: c.size,
    members: c.members.slice(0, 8),
  })),
  graphDb: outPath,
  sizeKB: Math.round(stat.size / 1024),
};
console.log(JSON.stringify(summary, null, 2));
