import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { HLX_ADMIN } from '../../../nx/utils/utils.js';
import {
  handleSignIn, handleSignOut, loadIms, testHooks, isAvailable,
} from '../../../nx/utils/helix-admin-auth.js';

const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeSiteToken(exp) {
  return `hlxtst_header.${b64url({ exp })}.sig`;
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
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });
      expect(await isAvailable()).to.equal(true);
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
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });
      window.fetch = fetchStub;
      const fresh = await import(`../../../nx/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      await fresh.isAvailable();
      await fresh.isAvailable();
      expect(fetchStub.callCount).to.equal(1);
    });
  });

  describe('resolveAuthProvider', () => {
    it('returns useAlt: true with this module\'s own functions when the alt provider is available', async () => {
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
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

  describe('handleSignOut', () => {
    it('clears the stored token and the shared nx-ims flag', () => {
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      localStorage.setItem('nx-ims', true);
      handleSignOut();
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
      expect(localStorage.getItem('nx-ims')).to.equal(null);
    });
  });

  describe('handleSignIn', () => {
    function makePopupStub() {
      return { location: '', closed: false, close: sinon.stub() };
    }

    it('opens the popup synchronously, before any fetch resolves', () => {
      const popup = makePopupStub();
      const openStub = sinon.stub().returns(popup);
      window.open = openStub;
      window.fetch = sinon.stub().returns(new Promise(() => {})); // never resolves

      handleSignIn();

      expect(openStub.calledOnce).to.equal(true);
      expect(openStub.firstCall.args[0]).to.equal('');
    });

    it('does nothing further if the popup was blocked', async () => {
      window.open = sinon.stub().returns(null);
      const fetchStub = sinon.stub();
      window.fetch = fetchStub;

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(fetchStub.called).to.equal(false);
    });

    it('discovers the login url and navigates the popup with client_id/redirect_uri/response_mode=popup', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      const url = new URL(popup.location);
      const expected = new URL(`${HLX_ADMIN}/auth/access-manager`);
      expect(`${url.origin}${url.pathname}`).to.equal(`${expected.origin}${expected.pathname}`);
      expect(url.searchParams.get('client_id')).to.equal('da-live');
      expect(url.searchParams.get('response_mode')).to.equal('popup');
      expect(url.searchParams.get('redirect_uri')).to.equal(`${window.location.origin}/.da/login/ack`);
    });

    it('never hardcodes a provider name — follows whichever single login_ link comes back', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { login_google: `${HLX_ADMIN}/auth/google` } }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      const url = new URL(popup.location);
      const expected = new URL(`${HLX_ADMIN}/auth/google`);
      expect(`${url.origin}${url.pathname}`).to.equal(`${expected.origin}${expected.pathname}`);
    });

    it('ignores the _sa (select-account) link variant when picking a provider', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({
          links: {
            'login_access-manager_sa': `${HLX_ADMIN}/auth/access-manager?select_account=true`,
            'login_access-manager': `${HLX_ADMIN}/auth/access-manager`,
          },
        }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(popup.location).to.include('/auth/access-manager');
      expect(popup.location).to.not.include('select_account');
    });

    it('closes the popup if discovery fails (e.g. no idp configured)', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({ ok: false });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(popup.close.calledOnce).to.equal(true);
    });

    it('closes the popup if the discovery fetch itself throws', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().rejects(new Error('network down'));

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(popup.close.calledOnce).to.equal(true);
    });

    it('closes the popup rather than navigating it to a non-https login URL', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        // eslint-disable-next-line no-script-url -- asserting this exact string is rejected
        json: async () => ({ links: { 'login_access-manager': 'javascript:alert(1)' } }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(popup.close.calledOnce).to.equal(true);
      expect(popup.location).to.equal('');
    });

    it('stores the token and reloads on a valid postMessage from the popup', async () => {
      // A real window, not the plain-object stub: MessageEvent's `source` field only
      // accepts an actual Window/MessagePort/ServiceWorker (confirmed empirically — even a
      // bare EventTarget is rejected), and this test needs event.source === popup to hold
      // for the message to be accepted at all.
      const popup = window.open('', '_blank');
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });
      const reloadStub = sinon.stub(testHooks, 'reload');

      try {
        handleSignIn();
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        const token = makeSiteToken(Math.floor(Date.now() / 1000) + 3600);
        window.dispatchEvent(new MessageEvent('message', {
          origin: new URL(HLX_ADMIN).origin,
          source: popup,
          data: { siteToken: token },
        }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        expect(reloadStub.calledOnce).to.equal(true);
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(stored.token).to.equal(token);
        // Consumers like da-live's getAuthToken() gate on this shared flag before ever
        // calling loadIms() — without it, a signed-in alt-provider session was invisible to
        // them. ims.js sets the same key on its own sign-in.
        expect(localStorage.getItem('nx-ims')).to.equal('true');
      } finally {
        popup.close();
      }
    });

    it('ignores a postMessage from the wrong origin', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // source only needs to be a real, constructor-valid EventTarget here (Window/
      // MessagePort) — the origin check short-circuits before source is ever compared, so
      // it doesn't need to be popup itself. See the "stores the token" test for that case.
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://evil.example.com',
        source: window,
        data: { siteToken: makeSiteToken(Math.floor(Date.now() / 1000) + 3600) },
      }));
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    });

    it('ignores a postMessage from a source other than the opened popup', async () => {
      const popup = makePopupStub();
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });

      handleSignIn();
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      window.dispatchEvent(new MessageEvent('message', {
        origin: new URL(HLX_ADMIN).origin,
        source: window,
        data: { siteToken: makeSiteToken(Math.floor(Date.now() / 1000) + 3600) },
      }));
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    });

    it('closes the popup on a correctly-originated message that carries no siteToken', async () => {
      // A real window, same reason as the "stores the token" test above: event.source must
      // be the actual popup for the message to be accepted at all.
      const popup = window.open('', '_blank');
      window.open = sinon.stub().returns(popup);
      window.fetch = sinon.stub().resolves({
        ok: true,
        json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
      });
      const closeSpy = sinon.spy(popup, 'close');

      try {
        handleSignIn();
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        window.dispatchEvent(new MessageEvent('message', {
          origin: new URL(HLX_ADMIN).origin,
          source: popup,
          data: { error: 'access_denied' },
        }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });

        expect(closeSpy.calledOnce).to.equal(true);
      } finally {
        if (!popup.closed) popup.close();
      }
    });
  });
});
