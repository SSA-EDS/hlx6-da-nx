import { expect } from '@esm-bundle/chai';
import { HLX_ADMIN } from '../../../../nx/utils/utils.js';

// Own file for the same memoization reason as secure-org-alt-provider.test.js. Regression:
// the 401/403 check was `=== 403 && === 401`, which can never be true, so a rejected request
// produced no message at all.
const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('nx/blocks/secure-org/utils.js — loadConfig', () => {
  let origFetch;
  let status;
  let loadConfig;

  before(async () => {
    origFetch = window.fetch;
    status = 200;
    window.fetch = async (url) => {
      const u = url.toString();
      if (u === `${HLX_ADMIN}/login`) {
        return new Response(JSON.stringify({
          links: { login_okta: `${HLX_ADMIN}/auth/okta` },
        }), { status: 200 });
      }
      return new Response(status === 200 ? '{"data":{}}' : '{}', { status });
    };

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `hlxtst_header.${b64url({ sub: 'user@example.com', exp })}.sig`;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp }));

    ({ loadConfig } = await import('../../../../nx/blocks/secure-org/utils.js'));
  });

  after(() => {
    window.fetch = origFetch;
    localStorage.removeItem(STORAGE_KEY);
  });

  it('returns the config json on success', async () => {
    status = 200;
    const { json, message } = await loadConfig('myorg');

    expect(json).to.deep.equal({ data: {} });
    expect(message).to.equal(undefined);
  });

  [401, 403].forEach((code) => {
    it(`explains a ${code} instead of failing silently`, async () => {
      status = code;
      const { message, status: result } = await loadConfig('myorg');

      expect(result).to.equal(code);
      expect(message).to.equal('You are not authorized to change this organization.');
    });
  });

  it('gives no message for other failures', async () => {
    status = 500;
    const { message } = await loadConfig('myorg');

    expect(message).to.equal(undefined);
  });
});
