import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const appPath = path.join(repoRoot, 'memory_api', 'app.py');
  const source = fs.readFileSync(appPath, 'utf8');
  const uiPath = path.join(repoRoot, 'memory_api', 'static', 'index.html');
  const uiSource = fs.readFileSync(uiPath, 'utf8');

  assert.match(
    source,
    /def _resolve_single_scope\(scope: Optional\[str\], auth: dict\) -> str:/,
    'memory API should provide a helper for reducing scoped recall requests to an authorized single scope before proxying',
  );
  assert.match(
    source,
    /effective_scope = _resolve_single_scope\(payload\.scope, auth\)/,
    'recall_explain should authorize or derive the effective scope before using the proxy token',
  );
  assert.match(
    source,
    /json=\{"query": query, "scope": effective_scope\}/,
    'recall_explain should forward only the authorized effective scope to the plugin proxy',
  );
  assert.doesNotMatch(
    source,
    /json=\{"query": query, "scope": payload\.scope or ""\}/,
    'recall_explain must not forward raw unvalidated scope values to the plugin proxy',
  );

  assert.match(
    source,
    /def _yaml_scalar\(value: Optional\[str\]\) -> str:/,
    'document serialization should sanitize scalar front-matter values',
  );
  assert.match(
    source,
    /f"source: \{_yaml_scalar\(source\)\}"/,
    'document front matter should sanitize source values before writing markdown files',
  );
  assert.match(
    source,
    /f"url: \{_yaml_scalar\(url\)\}"/,
    'document front matter should sanitize url values before writing markdown files',
  );
  assert.match(
    source,
    /replace\("\\n", " "\)/,
    'front-matter sanitization should strip newline injection from scalar values',
  );

  assert.match(
    uiSource,
    /id="recall-scope"/,
    'the web console should expose a recall scope field so scoped tokens can use /recall/explain safely',
  );
  assert.match(
    uiSource,
    /JSON\.stringify\(\{ query: q, \.\.\.\(scope \? \{ scope \} : \{\}\) \}\)/,
    'the web console should send an explicit recall scope when the operator provides one',
  );
};

export { run };
