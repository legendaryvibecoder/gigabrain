import fs from 'node:fs';
import path from 'node:path';

const FIELD_RE = (label) => new RegExp(`^-\\s*\\*\\*${String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*[ \t]*([^\\n\\r]+)$`, 'im');
const USER_SELF_QUERY_RE = /\b(?:who am i|wer bin ich|tell me about me|what do you know about me|about me)\b/i;
const AGENT_SELF_QUERY_RE = /\b(?:who are you|wer bist du|tell me about yourself|what do you know about yourself|about yourself|agent identity|your identity)\b/i;
const ENTITY_QUERY_RE = /\b(?:who is|who was|tell me about|what do you know about|wer ist|wer war|was weißt du über|was weisst du ueber|about|über|ueber)\b/i;

const cleanFieldValue = (value = '') => String(value || '')
  .trim()
  .replace(/^['"`]+|['"`]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeIdentityToken = (value = '') => cleanFieldValue(value)
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9'’._ -]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const parseMarkdownField = (content = '', label = '') => {
  const match = String(content || '').match(FIELD_RE(label));
  return cleanFieldValue(match?.[1] || '');
};

const readIfExists = (filePath = '') => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const buildIdentityAliasSet = (identity = {}) => {
  const aliases = new Set();
  const addTokens = (value = '') => {
    const normalized = normalizeIdentityToken(value);
    if (!normalized) return;
    aliases.add(normalized);
    for (const token of normalized.split(/\s+/).filter(Boolean)) {
      if (token.length >= 3) aliases.add(token);
    }
  };
  addTokens(identity?.agentName || '');
  addTokens(identity?.userName || '');
  return aliases;
};

const readWorkspaceIdentity = (workspaceRoot = '') => {
  const root = String(workspaceRoot || '').trim();
  if (!root) return { workspaceRoot: '', agentName: '', userName: '', aliases: new Set() };
  const identityMd = readIfExists(path.join(root, 'IDENTITY.md'));
  const userMd = readIfExists(path.join(root, 'USER.md'));
  const agentName = parseMarkdownField(identityMd, 'Name');
  const userName = parseMarkdownField(userMd, 'What to call them') || parseMarkdownField(userMd, 'Name');
  const identity = {
    workspaceRoot: root,
    agentName,
    userName,
  };
  return {
    ...identity,
    aliases: buildIdentityAliasSet(identity),
  };
};

const isWorkspaceIdentityAlias = (value = '', workspaceRoot = '') => {
  const normalized = normalizeIdentityToken(value);
  if (!normalized) return false;
  const identity = readWorkspaceIdentity(workspaceRoot);
  return identity.aliases.has(normalized);
};

const rewriteSelfReferenceQuery = (query = '', options = {}) => {
  const original = String(query || '').trim();
  if (!original) {
    return { query: '', rewritten: false, mode: '' };
  }
  if (ENTITY_QUERY_RE.test(original) && !USER_SELF_QUERY_RE.test(original) && !AGENT_SELF_QUERY_RE.test(original)) {
    return { query: original, rewritten: false, mode: '' };
  }
  const identity = options?.identity && typeof options.identity === 'object'
    ? options.identity
    : readWorkspaceIdentity(options?.workspaceRoot || '');
  const userName = cleanFieldValue(identity?.userName || '');
  const agentName = cleanFieldValue(identity?.agentName || '');

  if (USER_SELF_QUERY_RE.test(original) && userName) {
    return {
      query: `Who is ${userName}?`,
      rewritten: true,
      mode: 'user',
      resolvedName: userName,
    };
  }
  if (AGENT_SELF_QUERY_RE.test(original) && agentName) {
    return {
      query: `Who is ${agentName}?`,
      rewritten: true,
      mode: 'agent',
      resolvedName: agentName,
    };
  }
  return { query: original, rewritten: false, mode: '' };
};

export {
  isWorkspaceIdentityAlias,
  parseMarkdownField,
  readWorkspaceIdentity,
  rewriteSelfReferenceQuery,
};
