import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { HLX_ADMIN } from '../../../nx/utils/utils.js';
import {
  handleSignIn, handleSignOut, loadIms, testHooks, isAvailable, isAuthenticated,
} from '../../../nx/utils/helix-admin-auth.js';

const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeSiteToken(exp, sub, name) {
  return `hlxtst_header.${b64url({ exp, sub, ...(name ? { name } : {}) })}.sig`;
}

function storeRawToken(token, exp) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp }));
}

describe('helix-admin-auth', () => {
  let origOpen;
  let origFetch;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('nx-ims');
    origOpen = window.open;
    origFetch = window.fetch;
  });

  afterEach(() => {
    window.open = origOpen;
    window.fetch = origFetch;
    sinon.restore();
  });

  describe('loadIms', () => {
    it('reports anonymous when nothing is stored', async () => {
      const result = await loadIms();
      expect(result).to.deep.equal({ anonymous: true });
    });

    it('returns the stored token when still valid', async () => {
      // loadIms is a memoized singleton (matches ims.js's own pattern) — the shared import
      // was likely already resolved by an earlier test. Import a fresh module instance
      // (cache-busted) so this test observes its own localStorage state, not a stale result.
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      storeRawToken('hlxtst_abc.def.ghi', futureExp);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result).to.deep.equal({ accessToken: { token: 'hlxtst_abc.def.ghi' } });
    });

    it('surfaces the token payload\'s sub claim as email', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      storeRawToken(makeSiteToken(futureExp, 'user@example.com'), futureExp);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result.email).to.equal('user@example.com');
    });

    it('surfaces the token payload\'s name claim as displayName when present', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      storeRawToken(makeSiteToken(futureExp, 'user@example.com', 'Test User'), futureExp);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result.displayName).to.equal('Test User');
    });

    it('omits displayName when the token payload has no name claim', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      storeRawToken(makeSiteToken(futureExp, 'user@example.com'), futureExp);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result.displayName).to.equal(undefined);
    });

    it('treats an expired stored token as anonymous and clears it', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      storeRawToken('hlxtst_abc.def.ghi', pastExp);
      localStorage.setItem('nx-ims', true);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result).to.deep.equal({ anonymous: true });
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
      expect(localStorage.getItem('nx-ims')).to.equal(null);
    });

    it('memoizes — a second call does not re-read storage', async () => {
      const first = await loadIms();
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      const second = await loadIms();
      expect(second).to.deep.equal(first);
    });
  });

  describe('isAvailable', () => {
    it('resolves true when a login link is discovered', async () => {
      // First touch of this file's isAvailable singleton — safe to use the shared import
      // directly, matching the loadIms block's own first test above.
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      expect(await isAvailable()).to.equal(true);
    });

    ['adobe', 'adobe-stage', 'ims-na1', 'ims-na1-stg1'].forEach((name) => {
      it(`resolves false when the pinned primary is the IMS-backed "${name}" idp`, async () => {
        window.fetch = sinon.stub().resolves({
          ok: true,
          json: async () => ({
            links: {
              [`login_${name}`]: `${HLX_ADMIN}/auth/${name}`,
              [`login_${name}_sa`]: `${HLX_ADMIN}/auth/${name}?selectAccount=true`,
            },
          }),
        });
        const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
        expect(await fresh.isAvailable()).to.equal(false);
      });
    });

    it('resolves false when several idps are listed (nothing pinned)', async () => {
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({
          links: { login_adobe: 'https://a', login_okta: 'https://b' },
        }),
      });
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.isAvailable()).to.equal(false);
    });

    it('resolves false when no idp is configured', async () => {
      window.fetch = sinon.stub().resolves({ ok: false });
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.isAvailable()).to.equal(false);
    });

    it('resolves false rather than rejecting when the discovery fetch itself fails', async () => {
      // Called from top-level page bootstrap on every load, unlike handleSignIn's use of the
      // same discovery call — a network blip here must fall back to ims.js, not break the page.
      window.fetch = sinon.stub().rejects(new Error('network down'));
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.isAvailable()).to.equal(false);
    });

    it('memoizes — a second call does not re-fetch', async () => {
      const fetchStub = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      window.fetch = fetchStub;
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      await fresh.isAvailable();
      await fresh.isAvailable();
      expect(fetchStub.callCount).to.equal(1);
    });

    it('retries once on a transient discovery failure instead of memoizing it', async () => {
      const fetchStub = sinon.stub();
      fetchStub.onFirstCall().rejects(new Error('network down'));
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      window.fetch = fetchStub;
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.isAvailable()).to.equal(true);
      expect(fetchStub.callCount).to.equal(2);
    });
  });

  describe('resolveAuthProvider', () => {
    it('returns useAlt: true with this module\'s own functions when the alt provider is available', async () => {
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const { useAlt, authModule } = await fresh.resolveAuthProvider();

      expect(useAlt).to.equal(true);
      // Same functions this fresh module instance itself exports — not a copy/reimplementation.
      expect(authModule.loadIms).to.equal(fresh.loadIms);
      expect(authModule.handleSignIn).to.equal(fresh.handleSignIn);
      expect(authModule.handleSignOut).to.equal(fresh.handleSignOut);
    });

    it('returns useAlt: false with the real ims.js module when no idp is configured', async () => {
      window.fetch = sinon.stub().resolves({ ok: false });
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const { useAlt, authModule } = await fresh.resolveAuthProvider();

      expect(useAlt).to.equal(false);
      // IMS_ORIGIN is real ims.js's own field, not one of this file's exports — checking for
      // it (rather than just loadIms/handleSignIn, which both modules have) is what actually
      // distinguishes "really ims.js" from "the false branch accidentally returning the alt
      // provider's hand-built stub too." (A same-instance reference check would be a stronger
      // signal still, but doesn't hold reliably here — this test runner's dev-server import-map
      // rewriting can load ims.js as two separate module instances depending on how it's
      // reached, confirmed empirically, so identity isn't a safe assertion across that split.)
      expect(authModule).to.have.property('IMS_ORIGIN');
      expect(authModule.loadIms).to.be.a('function');
      expect(authModule.handleSignIn).to.be.a('function');
    });
  });

  describe('getAccessToken', () => {
    it('returns the alt provider\'s token when a valid session is stored', async () => {
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.getAccessToken()).to.deep.equal({ token: 'hlxtst_abc.def.ghi' });
    });

    it('returns null when the alt provider has no session', async () => {
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_okta: `${HLX_ADMIN}/auth/okta` } }),
      });
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      expect(await fresh.getAccessToken()).to.equal(null);
    });
  });

  describe('handleSignOut', () => {
    it('clears the stored token and the shared nx-ims flag, then reloads', () => {
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      localStorage.setItem('nx-ims', true);
      const reloadStub = sinon.stub(testHooks, 'reload');

      try {
        handleSignOut();
        expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
        expect(localStorage.getItem('nx-ims')).to.equal(null);
        expect(reloadStub.calledOnce).to.equal(true);
      } finally {
        reloadStub.restore();
      }
    });
  });

  describe('isAuthenticated', () => {
    it('returns false when nx-ims is not set', () => {
      expect(isAuthenticated()).to.equal(false);
    });

    it('returns true when nx-ims is set', () => {
      localStorage.setItem('nx-ims', true);
      expect(isAuthenticated()).to.equal(true);
    });
  });

  describe('handleSignIn', () => {
    const WIDGET_CONFIG = {
      issuer: `${new URL(HLX_ADMIN).origin.replace('admin', 'aemgovus-stub')}/oauth2/aus123`,
      clientId: 'widget-client-id',
    };
    let origLoadWidget;

    beforeEach(() => {
      origLoadWidget = testHooks.loadWidget;
    });

    afterEach(() => {
      testHooks.loadWidget = origLoadWidget;
      document.querySelectorAll('dialog.da-helix-admin-auth-widget-dialog').forEach((d) => d.remove());
    });

    function makeFetchStub({ config = WIDGET_CONFIG, exchangeOk = true, siteToken = 'hlxtst_abc' } = {}) {
      return async (url) => {
        const u = url.toString();
        if (u === `${HLX_ADMIN}/auth/okta/config`) {
          return config
            ? { ok: true, json: async () => config }
            : { ok: false };
        }
        if (u === `${HLX_ADMIN}/auth/okta/exchange`) {
          return exchangeOk
            ? { ok: true, json: async () => ({ siteToken }) }
            : { ok: false };
        }
        throw new Error(`unexpected fetch: ${u}`);
      };
    }

    function stubWidget({ tokens = { idToken: { idToken: 'raw-id-token' } } } = {}) {
      const instance = {
        showSignInToGetTokens: sinon.stub().resolves(tokens),
        remove: sinon.stub(),
      };
      const OktaSignInStub = sinon.stub().returns(instance);
      testHooks.loadWidget = async () => ({ default: OktaSignInStub });
      return { OktaSignInStub, instance };
    }

    it('does nothing if the widget config endpoint is unavailable', async () => {
      window.fetch = makeFetchStub({ config: null });
      const { OktaSignInStub } = stubWidget();

      await handleSignIn();

      expect(OktaSignInStub.called).to.equal(false);
      expect(document.querySelector('dialog.da-helix-admin-auth-widget-dialog')).to.equal(null);
    });

    it('initializes the widget with the discovered issuer/client_id and the interaction code flow', async () => {
      window.fetch = makeFetchStub();
      const { OktaSignInStub } = stubWidget();
      sinon.stub(testHooks, 'reload');

      try {
        await handleSignIn();

        expect(OktaSignInStub.calledOnce).to.equal(true);
        const config = OktaSignInStub.firstCall.args[0];
        expect(config.clientId).to.equal(WIDGET_CONFIG.clientId);
        expect(config.authParams.issuer).to.equal(WIDGET_CONFIG.issuer);
        expect(config.baseUrl).to.equal(new URL(WIDGET_CONFIG.issuer).origin);
        expect(config.useInteractionCodeFlow).to.equal(true);
        // The /oie export's real constructor throws unless this is exactly false (confirmed
        // against the vendored widget directly, not just asserted here) — the stubbed widget
        // in this test doesn't enforce that itself, so this only guards the value we pass,
        // not the real widget's validation.
        expect(config.useClassicEngine).to.equal(false);
      } finally {
        testHooks.reload.restore();
      }
    });

    it('exchanges the widget-obtained id_token, stores the resulting site token, and reloads', async () => {
      const siteToken = makeSiteToken(Math.floor(Date.now() / 1000) + 3600);
      window.fetch = makeFetchStub({ siteToken });
      stubWidget();
      const reloadStub = sinon.stub(testHooks, 'reload');

      try {
        await handleSignIn();

        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(stored.token).to.equal(siteToken);
        expect(reloadStub.calledOnce).to.equal(true);
      } finally {
        reloadStub.restore();
      }
    });

    it('removes the widget and the dialog once signed in', async () => {
      window.fetch = makeFetchStub();
      const { instance } = stubWidget();
      sinon.stub(testHooks, 'reload');

      try {
        await handleSignIn();

        expect(instance.remove.calledOnce).to.equal(true);
        expect(document.querySelector('dialog.da-helix-admin-auth-widget-dialog')).to.equal(null);
      } finally {
        testHooks.reload.restore();
      }
    });

    it('cleans up without storing a token when the widget resolves no id_token', async () => {
      window.fetch = makeFetchStub();
      const { instance } = stubWidget({ tokens: {} });

      await handleSignIn();

      expect(instance.remove.calledOnce).to.equal(true);
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    });

    it('cleans up without storing a token when the exchange endpoint fails', async () => {
      window.fetch = makeFetchStub({ exchangeOk: false });
      const { instance } = stubWidget();

      await handleSignIn();

      expect(instance.remove.calledOnce).to.equal(true);
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    });

    it('cleans up if the widget itself throws', async () => {
      window.fetch = makeFetchStub();
      const instance = {
        showSignInToGetTokens: sinon.stub().rejects(new Error('widget blew up')),
        remove: sinon.stub(),
      };
      testHooks.loadWidget = async () => ({ default: sinon.stub().returns(instance) });

      await handleSignIn();

      expect(instance.remove.calledOnce).to.equal(true);
      expect(document.querySelector('dialog.da-helix-admin-auth-widget-dialog')).to.equal(null);
    });

    it('uses the page origin as the redirectUri, so an upstream-IdP hop returns here', async () => {
      window.fetch = makeFetchStub();
      const { OktaSignInStub } = stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      expect(OktaSignInStub.firstCall.args[0].redirectUri).to.equal(`${window.location.origin}/`);
    });

    it('passes the backend-provided logo to the widget', async () => {
      window.fetch = makeFetchStub({ config: { ...WIDGET_CONFIG, logo: 'https://cdn.example/logo.png' } });
      const { OktaSignInStub } = stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      const options = OktaSignInStub.firstCall.args[0];
      expect(options.logo).to.equal('https://cdn.example/logo.png');
      expect(options.logoText).to.be.a('string');
    });

    it('leaves the logo options out when the backend provides none', async () => {
      window.fetch = makeFetchStub();
      const { OktaSignInStub } = stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      const options = OktaSignInStub.firstCall.args[0];
      expect(options).to.not.have.property('logo');
      expect(options).to.not.have.property('logoText');
    });

    it('keeps page-wide img styles from distorting the brand logo', async () => {
      window.fetch = makeFetchStub();
      stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      const css = document.getElementById('da-helix-admin-auth-widget-dialog-style').textContent;
      expect(css).to.match(/\.auth-org-logo\s*\{[^}]*width:\s*auto[^}]*mask-image:\s*none/);
    });

    it('drops the widget\'s full-page top margin inside the dialog', async () => {
      window.fetch = makeFetchStub();
      stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      const css = document.getElementById('da-helix-admin-auth-widget-dialog-style').textContent;
      expect(css).to.match(/#okta-sign-in\s*\{[^}]*margin-top:\s*0[^}]*margin-bottom:\s*0/);
      expect(css).to.match(/\.da-helix-admin-auth-widget-dialog\s*\{[^}]*padding:\s*16px 0/);
    });

    it('titles the dialog "Sign In to Author"', async () => {
      window.fetch = makeFetchStub();
      const { OktaSignInStub } = stubWidget();
      sinon.stub(testHooks, 'reload');

      await handleSignIn();

      expect(OktaSignInStub.firstCall.args[0].i18n.en['primaryauth.title']).to.equal('Sign In to Author');
    });
  });

  describe('returning from an upstream-IdP hop', () => {
    const WIDGET_CONFIG = { issuer: 'https://okta.example/oauth2/aus123', clientId: 'widget-client-id' };
    let origUrl;

    beforeEach(() => {
      origUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    });

    afterEach(() => {
      window.history.replaceState(null, '', origUrl);
      document.querySelectorAll('dialog.da-helix-admin-auth-widget-dialog').forEach((d) => d.remove());
    });

    async function freshModule() {
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const reloadStub = sinon.stub(fresh.testHooks, 'reload');
      return { fresh, reloadStub };
    }

    function stubFetch() {
      window.fetch = async (url) => {
        const u = url.toString();
        if (u === `${HLX_ADMIN}/auth/okta/config`) return { ok: true, json: async () => WIDGET_CONFIG };
        if (u === `${HLX_ADMIN}/auth/okta/exchange`) {
          const siteToken = makeSiteToken(Math.floor(Date.now() / 1000) + 3600);
          return { ok: true, json: async () => ({ siteToken }) };
        }
        throw new Error(`unexpected fetch: ${u}`);
      };
    }

    const until = async (fn) => {
      for (let i = 0; i < 50 && !fn(); i += 1) await new Promise((r) => { setTimeout(r, 10); });
    };

    it('does not start the widget on an ordinary page load', async () => {
      window.fetch = async () => { throw new Error('no fetch expected'); };
      const { fresh } = await freshModule();
      const loadWidget = sinon.stub(fresh.testHooks, 'loadWidget');

      await fresh.loadIms();

      expect(loadWidget.called).to.equal(false);
    });

    it('completes a returned interaction_code, stores the token, and clears the redirect params', async () => {
      window.history.replaceState(null, '', '/?state=s1&interaction_code=c1');
      stubFetch();
      const { fresh, reloadStub } = await freshModule();
      const instance = {
        authClient: {
          idx: { handleInteractionCodeRedirect: sinon.stub().resolves() },
          tokenManager: { getTokens: sinon.stub().resolves({ idToken: { idToken: 'raw-id-token' } }) },
        },
        showSignInToGetTokens: sinon.stub(),
        remove: sinon.stub(),
      };
      sinon.stub(fresh.testHooks, 'loadWidget').resolves({ default: sinon.stub().returns(instance) });

      const result = await fresh.loadIms();
      await until(() => reloadStub.called);

      expect(result).to.deep.equal({ anonymous: true });
      expect(instance.authClient.idx.handleInteractionCodeRedirect.firstCall.args[0])
        .to.contain('interaction_code=c1');
      expect(instance.showSignInToGetTokens.called).to.equal(false);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).token).to.match(/^hlxtst_/);
      expect(window.location.search).to.equal('');
      expect(reloadStub.calledOnce).to.equal(true);
    });

    it('resumes the widget in a dialog on interaction_required', async () => {
      window.history.replaceState(null, '', '/?state=s1&error=interaction_required');
      stubFetch();
      const { fresh, reloadStub } = await freshModule();
      const instance = {
        showSignInToGetTokens: sinon.stub().resolves({ idToken: { idToken: 'raw-id-token' } }),
        remove: sinon.stub(),
      };
      sinon.stub(fresh.testHooks, 'loadWidget').resolves({ default: sinon.stub().returns(instance) });

      await fresh.loadIms();
      await until(() => reloadStub.called);

      expect(instance.showSignInToGetTokens.calledOnce).to.equal(true);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).token).to.match(/^hlxtst_/);
      expect(window.location.search).to.equal('');
    });

    it('cleans up and clears the params when there is no saved transaction to resume', async () => {
      window.history.replaceState(null, '', '/?state=s1&interaction_code=c1');
      stubFetch();
      const { fresh, reloadStub } = await freshModule();
      const instance = {
        authClient: {
          idx: { handleInteractionCodeRedirect: sinon.stub().rejects(new Error('No transaction data')) },
        },
        remove: sinon.stub(),
      };
      sinon.stub(fresh.testHooks, 'loadWidget').resolves({ default: sinon.stub().returns(instance) });

      await fresh.loadIms();
      await until(() => instance.remove.called);

      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
      expect(reloadStub.called).to.equal(false);
      expect(window.location.search).to.equal('');
    });
  });
});
