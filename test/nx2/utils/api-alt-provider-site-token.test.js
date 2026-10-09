import { expect } from '@esm-bundle/chai';
import { HLX_ADMIN, DA_ADMIN } from '../../../nx2/utils/utils.js';

// Own file: loadIms() (nx/utils/helix-admin-auth.js) memoizes at module scope just like
// isAvailable() — reusing api-alt-provider.test.js would reuse whatever anonymous/signed-in
// state its earlier tests already settled loadIms() into there. A fresh module graph is the
// only way to observe loadIms() resolving a real, stored token for the first time.
//
// Regression for a real-world 401 (loc's project dashboard, /apps/loc#/dashboard/{org}/{site}):
// the account-level token minted at sign-in can't satisfy da-admin's per-site audience check
// until upgraded via getAemSiteToken — but the vast majority of daFetch call sites across the
// codebase (loc included) never pass `org`/`site` explicitly. Without deriving them from the
// URL itself, that upgrade silently never triggers and every such request 401s forever.
const STORAGE_KEY = 'da-helix-admin-auth';

function storeAltProviderToken() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'hlxtst_account.token.sig', exp }));
}

describe('nx2/utils/api — alt provider site-token upgrade', () => {
  let origFetch;
  let calls;
  let api;

  before(async () => {
    origFetch = window.fetch;
    calls = [];
    window.fetch = async (url, opts = {}) => {
      const u = url.toString();
      calls.push({ url: u, opts: { ...opts, headers: { ...opts.headers } } });
      if (u === `${HLX_ADMIN}/login`) {
        return new Response(JSON.stringify({
          links: { login_okta: `${HLX_ADMIN}/auth/okta` },
        }), { status: 200 });
      }
      if (u === `${HLX_ADMIN}/auth/site/exchange`) {
        return new Response(JSON.stringify({ siteToken: 'hlxtst_site.token.sig' }), { status: 200 });
      }
      if (u === `${DA_ADMIN}/source/myorg/mysite/index.html`) {
        // First call (account-level token) 401s; the retry (site token) succeeds.
        const usedSiteToken = opts.headers?.Authorization === 'Bearer hlxtst_site.token.sig';
        return new Response('{}', { status: usedSiteToken ? 200 : 401 });
      }
      return new Response('{}', { status: 200 });
    };

    storeAltProviderToken();
    api = await import('../../../nx2/utils/api.js');
  });

  after(() => {
    window.fetch = origFetch;
    localStorage.removeItem(STORAGE_KEY);
  });

  it('derives org/site from the URL and uses a site token up front when the caller omits them', async () => {
    await api.daFetch({ url: `${DA_ADMIN}/source/myorg/mysite/index.html` });

    const exchangeCall = calls.find((c) => c.url === `${HLX_ADMIN}/auth/site/exchange`);
    expect(JSON.parse(exchangeCall.opts.body)).to.include({ org: 'myorg', site: 'mysite' });

    const sourceCalls = calls.filter((c) => c.url === `${DA_ADMIN}/source/myorg/mysite/index.html`);
    expect(sourceCalls).to.have.lengthOf(1);
    expect(sourceCalls[0].opts.headers.Authorization).to.equal('Bearer hlxtst_site.token.sig');
  });
});
