import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { HLX_ADMIN, DA_ADMIN } from '../../../nx2/utils/utils.js';

const STORAGE_KEY = 'da-helix-admin-auth';

// Own file, same reason as api-alt-provider.test.js: api.js's top-level IIFE (useAlt/loadIms)
// and the alt provider's own loadIms() (helix-admin-auth.js) both memoize on first call —
// localStorage has to be seeded, and window.fetch stubbed, before api.js is ever imported
// here, or a token-less/anonymous result from another test's ordering would stick for the
// whole file.
localStorage.setItem(STORAGE_KEY, JSON.stringify({
  token: 'hlxtst_account.level.token',
  exp: Math.floor(Date.now() / 1000) + 3600,
}));

describe('nx2/utils/api — alt provider site-token exchange', () => {
  let origFetch;

  beforeEach(() => {
    origFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = origFetch;
    sinon.restore();
  });

  it('upgrades an account-level token to a site-scoped one on 401, then retries once', async () => {
    const calls = [];
    window.fetch = sinon.stub().callsFake(async (url, opts = {}) => {
      const u = url.toString();
      // Snapshot headers now — daFetch reuses and mutates the same opts.headers object across
      // its own retry, so pushing a live reference here would have every recorded call reflect
      // whatever the header ends up as by the time the retry happens, not what it was at call time.
      calls.push({ url: u, headers: { ...(opts.headers || {}) } });
      if (u.endsWith('/login')) {
        return {
          ok: true,
          json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
        };
      }
      if (u === `${HLX_ADMIN}/auth/site/exchange`) {
        return { ok: true, json: async () => ({ siteToken: 'hlxtst_site.scoped.token' }) };
      }
      if (u.startsWith(`${DA_ADMIN}/source/`)) {
        const usedSiteToken = opts.headers?.Authorization === 'Bearer hlxtst_site.scoped.token';
        return new Response('{}', { status: usedSiteToken ? 200 : 401 });
      }
      return new Response('{}', { status: 200 });
    });

    const api = await import('../../../nx2/utils/api.js');
    const resp = await api.daFetch({
      url: `${DA_ADMIN}/source/myorg/mysite/index.html`,
      org: 'myorg',
      site: 'mysite',
    });

    expect(resp.status).to.equal(200);
    expect(calls.some((c) => c.url === `${HLX_ADMIN}/auth/site/exchange`)).to.equal(true);
    const sourceCalls = calls.filter((c) => c.url.startsWith(`${DA_ADMIN}/source/`));
    expect(sourceCalls).to.have.length(2);
    expect(sourceCalls[0].headers.Authorization).to.equal('Bearer hlxtst_account.level.token');
    expect(sourceCalls[1].headers.Authorization).to.equal('Bearer hlxtst_site.scoped.token');
  });

  it('does not attempt the site-token exchange when org/site are not known', async () => {
    const calls = [];
    window.fetch = sinon.stub().callsFake(async (url, opts = {}) => {
      const u = url.toString();
      calls.push({ url: u });
      if (u.endsWith('/login')) {
        return {
          ok: true,
          json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
        };
      }
      return new Response('{}', { status: 401, headers: opts.headers });
    });

    const api = await import('../../../nx2/utils/api.js');
    const resp = await api.daFetch({ url: `${DA_ADMIN}/source/myorg/mysite/index.html` });

    expect(resp.status).to.equal(401);
    expect(calls.some((c) => c.url === `${HLX_ADMIN}/auth/site/exchange`)).to.equal(false);
  });
});
