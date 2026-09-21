import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { HLX_ADMIN } from '../../../nx2/utils/utils.js';
import {
  handleSignIn, handleSignOut, loadIms, testHooks,
} from '../../../nx2/utils/helix-admin-auth.js';

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
      const fresh = await import(`../../../nx2/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result).to.deep.equal({ accessToken: { token: 'hlxtst_abc.def.ghi' } });
    });

    it('treats an expired stored token as anonymous and clears it', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      storeRawToken('hlxtst_abc.def.ghi', pastExp);
      const fresh = await import(`../../../nx2/utils/helix-admin-auth.js?fresh=${Math.random()}`);
      const result = await fresh.loadIms();
      expect(result).to.deep.equal({ anonymous: true });
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    });

    it('memoizes — a second call does not re-read storage', async () => {
      const first = await loadIms();
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      const second = await loadIms();
      expect(second).to.deep.equal(first);
    });
  });

  describe('handleSignOut', () => {
    it('clears the stored token', () => {
      storeRawToken('hlxtst_abc.def.ghi', Math.floor(Date.now() / 1000) + 3600);
      handleSignOut();
      expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
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
          'login_access-manager_sa': `${HLX_ADMIN}/auth/access-manager?select_account=true`,
          links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` },
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
  });
});
