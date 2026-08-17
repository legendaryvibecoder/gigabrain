import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';

import {
  createAccessTokenVerifier,
  resolveEnabledRemoteTools,
  resolveRemoteMcpOptions,
} from '../lib/core/remote-mcp.js';

const listen = (server) => new Promise((resolve, reject) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

const run = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'fixture-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const jwksServer = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const address = await listen(jwksServer);
  const issuer = `http://127.0.0.1:${address.port}`;
  const resourceUrl = 'http://127.0.0.1:8788';

  try {
    const resolved = resolveRemoteMcpOptions({
      host: '127.0.0.1',
      port: 8788,
      resourceUrl,
      authorizationServer: issuer,
      issuer,
      jwksUrl: `${issuer}/jwks.json`,
      allowedScopes: ['project:alpha', 'project:beta'],
      enableWrites: true,
    });
    const trailingIssuer = resolveRemoteMcpOptions({
      host: '127.0.0.1',
      port: 8788,
      resourceUrl,
      authorizationServer: `${issuer}/`,
      issuer: `${issuer}/`,
      jwksUrl: `${issuer}/jwks.json`,
      allowedScopes: ['project:alpha'],
    });
    assert.equal(trailingIssuer.issuer, `${issuer}/`, 'issuer identifiers must preserve an exact trailing slash');
    assert.equal(
      trailingIssuer.authorizationServer,
      `${issuer}/`,
      'authorization-server metadata must preserve its configured identifier',
    );
    assert.throws(
      () => resolveRemoteMcpOptions({
        host: '127.0.0.1',
        port: 8788,
        resourceUrl,
        issuer,
        jwksUrl: `${issuer}/jwks.json`,
        allowedScopes: ['project:alpha'],
      }),
      /requires authorization server, token issuer, and JWKS URL/,
      'OAuth mode must not publish protected-resource metadata without an authorization server',
    );
    const verify = createAccessTokenVerifier(resolved);

    const validToken = await new SignJWT({
      scope: 'gigabrain:read gigabrain:checkpoint gigabrain:scope:project:alpha gigabrain:scope:project:gamma',
      client_id: 'chatgpt-fixture',
      gigabrain_authority: 'reviewer',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience(resourceUrl)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const auth = await verify(validToken);
    assert.equal(auth.subject, 'fixture-user', 'verified subject should be propagated');
    assert.equal(auth.clientId, 'chatgpt-fixture', 'verified client id should be propagated');
    assert.deepEqual(
      auth.memoryScopes,
      ['project:alpha'],
      'token memory scopes should be intersected with the server-side exact allowlist',
    );
    assert.equal(auth.oauthScopes.includes('gigabrain:checkpoint'), true, 'OAuth permissions should be preserved');
    assert.equal(
      resolveEnabledRemoteTools(auth, resolved).includes('gigabrain_checkpoint'),
      true,
      'a write tool should be exposed only when server and token both grant it',
    );
    assert.equal(
      resolveEnabledRemoteTools({ ...auth, oauthScopes: ['gigabrain:read'] }, resolved).includes('gigabrain_checkpoint'),
      false,
      'server write enablement must not override a missing token permission',
    );

    const genericAuthorityToken = await new SignJWT({
      scope: 'gigabrain:read gigabrain:scope:project:alpha',
      client_id: 'chatgpt-fixture',
      authority: 'owner',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience(resourceUrl)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    assert.equal(
      (await verify(genericAuthorityToken)).authority,
      '',
      'generic JWT authority claims must not grant Gigabrain decision authority',
    );

    const badAudience = await new SignJWT({
      scope: 'gigabrain:read gigabrain:scope:project:alpha',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience('https://wrong-resource.example')
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(
      () => verify(badAudience),
      /audience does not match/,
      'tokens for another resource must be rejected',
    );

    const noExpiry = await new SignJWT({
      scope: 'gigabrain:read gigabrain:scope:project:alpha',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience(resourceUrl)
      .setSubject('fixture-user')
      .setIssuedAt()
      .sign(privateKey);
    await assert.rejects(
      () => verify(noExpiry),
      /must include exp/,
      'non-expiring bearer tokens must be rejected',
    );

    const wildcardScope = await new SignJWT({
      scope: 'gigabrain:read gigabrain:scope:project:*',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(issuer)
      .setAudience(resourceUrl)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(
      () => verify(wildcardScope),
      /wildcard memory scopes are not accepted/,
      'wildcard claims must be rejected rather than expanded',
    );

    const wrongIssuer = await new SignJWT({
      scope: 'gigabrain:read gigabrain:scope:project:alpha',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer('https://wrong-issuer.example')
      .setAudience(resourceUrl)
      .setSubject('fixture-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(
      () => verify(wrongIssuer),
      /unexpected "iss" claim value|unexpected iss claim value|issuer/i,
      'issuer verification should happen before tool selection',
    );
  } finally {
    await close(jwksServer);
  }
};

export { run };
