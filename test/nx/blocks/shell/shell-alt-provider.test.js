import { expect } from '@esm-bundle/chai';
import { HLX_ADMIN } from '../../../../nx/utils/utils.js';

// Own file: loadIms()/isAvailable() (nx/utils/helix-admin-auth.js) memoize at module scope —
// a fresh module graph is the only way to observe the alt provider resolving for the first
// time. Regression for /app/* (the custom-app iframe shell) always posting token: undefined
// into embedded third-party apps for alt-provider users, a guaranteed 401 on their end —
// shell.js was hardcoded to ims.js alone, never going through resolveAuthProvider() like
// every other auth entry point in this codebase.
const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('nx/blocks/shell/shell.js — alt provider (Okta/access-manager)', () => {
  let origFetch;
  let shell;

  before(async () => {
    origFetch = window.fetch;
    window.fetch = async (url) => {
      const u = url.toString();
      if (u === `${HLX_ADMIN}/login`) {
        return new Response(JSON.stringify({
          links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `hlxtst_header.${b64url({ sub: 'user@example.com', exp, name: 'Test User' })}.sig`;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp }));

    shell = await import('../../../../nx/blocks/shell/shell.js');
  });

  after(() => {
    window.fetch = origFetch;
    localStorage.removeItem(STORAGE_KEY);
  });

  it('resolves the alt provider\'s token instead of silently carrying an undefined one', () => {
    expect(shell.IMS_DETAILS.accessToken.token).to.match(/^hlxtst_/);
  });

  it('resolves the alt provider\'s email', () => {
    expect(shell.IMS_DETAILS.email).to.equal('user@example.com');
  });
});
