import assert from 'node:assert/strict';

import { checkRateLimit } from '../lib/core/http-routes.js';

const run = async () => {
  const baseEndpoint = `rate-limit-${Date.now()}`;
  for (let i = 0; i < 70; i += 1) {
    const allowed = checkRateLimit(`${baseEndpoint}-many-${i}`, 1);
    assert.equal(allowed, true, 'new endpoints should be admitted up to the cap');
  }
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), true, 'first request should pass');
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), false, 'second request in the same minute should be rate limited');
};

export { run };
