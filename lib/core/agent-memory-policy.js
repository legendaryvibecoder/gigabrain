const createAgentMemoryPolicyBody = ({
  projectScope = '',
  storeMode = 'global',
  storePath = '',
  userStorePath = '',
} = {}) => {
  const projectTarget = projectScope
    ? `Use \`target: "project"\` with exact scope \`${projectScope}\`.`
    : 'Use `target: "project"` with the exact generated project scope.';
  return `## Gigabrain Memory (on demand)

- Canonical repo memory uses the ${storeMode === 'project_local' ? 'repo-local' : 'shared'} Gigabrain store${storePath ? ` at \`${storePath}\`` : ''}.
- Personal memory uses the isolated user store${userStorePath ? ` at \`${userStorePath}\`` : ''}.
- Do not inject or recall memory automatically. Call \`gigabrain_recall\` only when the task depends on prior decisions, continuity, or an explicit user preference.
- ${projectTarget} Use \`target: "user"\` only for an explicitly personal question. Use \`target: "both"\` only when the question intentionally spans project and personal context.
- Treat recalled rows as candidate evidence. Use \`gigabrain_provenance\` before relying on a consequential or potentially stale claim.
- Use \`gigabrain_remember\` only for an explicit durable save requested by the user or required by a documented workflow.
- Write at most one \`gigabrain_checkpoint\` for a completed substantial session. Pass a stable \`session_id\`; skip trivial, aborted, read-only audit, and planning-only sessions.${projectScope ? ` Use scope \`${projectScope}\`.` : ''}
- Never copy profile/private memory into public artifacts. Run the repository PII scanner before any public commit, tag, package, or release.
- Do not grep Gigabrain store files directly unless the MCP server is unavailable.
- Prefer Gigabrain MCP tools over direct CLI writes whenever the MCP server is available.
- If the MCP server is unavailable, use the generated helper scripts or pinned package CLI. Never use transient npm-cache paths such as \`node ~/.npm/_npx/.../scripts/gigabrainctl.js\`.
`;
};

export { createAgentMemoryPolicyBody };
