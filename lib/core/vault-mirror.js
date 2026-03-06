import fs from 'node:fs';
import path from 'node:path';

import { resolveNativeSourcePaths } from './native-sync.js';

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureFileDir = (filePath) => {
  ensureDir(path.dirname(filePath));
};

const readUtf8IfExists = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
};

const sameFileContent = (aPath, bPath) => {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return false;
  const a = fs.readFileSync(aPath, 'utf8');
  const b = fs.readFileSync(bPath, 'utf8');
  return a === b;
};

const toPosix = (value) => String(value || '').replace(/\\/g, '/');

const isProtectedPath = (relPath) => {
  const normalized = toPosix(relPath);
  return normalized.startsWith('.obsidian/')
    || normalized === '.obsidian'
    || normalized.startsWith('.stfolder/')
    || normalized === '.stfolder'
    || normalized.startsWith('.git/')
    || normalized === '.git';
};

const listFilesRecursively = (rootDir) => {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      out.push(filePath);
    }
  };
  walk(rootDir);
  return out;
};

const renderVaultIndex = ({ timestamp, subdir, files }) => {
  const lines = [];
  lines.push('# Gigabrain Vault Mirror');
  lines.push('');
  lines.push(`- updated_at: ${timestamp}`);
  lines.push(`- subdir: ${subdir}`);
  lines.push(`- mirrored_files: ${files.length}`);
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const relPath of files) {
    if (relPath === 'vault-index.md') continue;
    const notePath = relPath.replace(/\.md$/i, '');
    lines.push(`- [[${notePath}]]`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const renderVaultMirrorMarkdown = ({ timestamp, runId, summary }) => {
  const lines = [];
  lines.push('# Vault Mirror Report');
  lines.push('');
  lines.push(`- timestamp: ${timestamp}`);
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- enabled: ${summary?.enabled === true}`);
  lines.push(`- vault_root: ${summary?.vault_root || ''}`);
  lines.push(`- subdir: ${summary?.subdir || ''}`);
  lines.push(`- source_files: ${Number(summary?.source_files || 0)}`);
  lines.push(`- copied_files: ${Number(summary?.copied_files || 0)}`);
  lines.push(`- skipped_unchanged: ${Number(summary?.skipped_unchanged || 0)}`);
  lines.push(`- removed_files: ${Number(summary?.removed_files || 0)}`);
  lines.push('');
  const files = Array.isArray(summary?.mirrored_files) ? summary.mirrored_files : [];
  if (files.length > 0) {
    lines.push('## Mirrored Files');
    lines.push('');
    for (const relPath of files) {
      lines.push(`- ${relPath}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const syncVaultMirror = ({
  config,
  dryRun = false,
} = {}) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const vaultEnabled = config?.vault?.enabled === true;
  const vaultRoot = String(config?.vault?.path || '').trim();
  const subdir = String(config?.vault?.subdir || 'Gigabrain').trim() || 'Gigabrain';
  const clean = config?.vault?.clean !== false;
  const summary = {
    enabled: vaultEnabled,
    vault_root: vaultRoot,
    subdir,
    source_files: 0,
    copied_files: 0,
    skipped_unchanged: 0,
    removed_files: 0,
    mirrored_files: [],
  };

  if (!vaultEnabled || !vaultRoot) {
    return summary;
  }

  const sourcePaths = resolveNativeSourcePaths(config);
  summary.source_files = sourcePaths.length;

  const mirrorRoot = path.join(vaultRoot, subdir);
  const mirroredRelativePaths = [];

  for (const sourcePath of sourcePaths) {
    const rel = toPosix(path.relative(workspaceRoot, sourcePath));
    if (!rel || rel.startsWith('../')) continue;
    const targetPath = path.join(mirrorRoot, rel);
    mirroredRelativePaths.push(rel);
    if (dryRun) {
      summary.copied_files += 1;
      continue;
    }
    ensureFileDir(targetPath);
    if (sameFileContent(sourcePath, targetPath)) {
      summary.skipped_unchanged += 1;
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    summary.copied_files += 1;
  }

  const indexRelPath = 'vault-index.md';
  const indexPath = path.join(mirrorRoot, indexRelPath);
  const indexContent = renderVaultIndex({
    timestamp: new Date().toISOString(),
    subdir,
    files: [...mirroredRelativePaths].sort(),
  });
  summary.mirrored_files = [...mirroredRelativePaths, indexRelPath].sort();

  if (dryRun) {
    summary.copied_files += 1;
    return summary;
  }

  ensureDir(mirrorRoot);
  const previousIndex = readUtf8IfExists(indexPath);
  if (previousIndex === indexContent) {
    summary.skipped_unchanged += 1;
  } else {
    fs.writeFileSync(indexPath, indexContent, 'utf8');
    summary.copied_files += 1;
  }

  if (clean) {
    const keep = new Set(summary.mirrored_files.map((relPath) => toPosix(path.join(subdir, relPath))));
    for (const filePath of listFilesRecursively(vaultRoot)) {
      const relToVault = toPosix(path.relative(vaultRoot, filePath));
      if (!relToVault || relToVault.startsWith('../')) continue;
      if (isProtectedPath(relToVault)) continue;
      if (keep.has(relToVault)) continue;
      if (!relToVault.startsWith(`${toPosix(subdir)}/`)) continue;
      fs.unlinkSync(filePath);
      summary.removed_files += 1;
    }
  }

  return summary;
};

export {
  renderVaultMirrorMarkdown,
  syncVaultMirror,
};
