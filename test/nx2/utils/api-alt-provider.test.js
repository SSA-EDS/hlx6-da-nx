import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { HLX_ADMIN } from '../../../nx2/utils/utils.js';

// Separate file from api.test.js on purpose: that file statically imports api.js at the top,
// which resolves isAvailable() (memoized) against the real, unstubbed fetch before any test
// runs — locking useAlt to false for that whole file. A fresh page/module registry here lets
// window.fetch be stubbed before api.js is ever imported, so useAlt can be forced true.
describe('nx2/utils/api — alt provider awareness', () => {
  let origFetch;
  let origOpen;

  beforeEach(() => {
    origFetch = window.fetch;
    origOpen = window.open;
  });

  afterEach(() => {
    window.fetch = origFetch;
    window.open = origOpen;
    sinon.restore();
  });

  it('uses the alt provider when helix-admin has one configured', async () => {
    window.fetch = sinon.stub().resolves({
      ok: true,
      json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
    });
    const api = await import('../../../nx2/utils/api.js');
    expect(api.useAlt).to.equal(true);
  });

  it('does not call handleSignIn reactively on a missing token — no gesture behind this path, would just silently no-op', async () => {
    window.fetch = sinon.stub().resolves({
      ok: true,
      json: async () => ({ links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` } }),
    });
    const api = await import('../../../nx2/utils/api.js');
    const openStub = sinon.stub();
    window.open = openStub;

    await api.daFetch({ url: 'https://example.com/x' });

    expect(openStub.called).to.equal(false);
  });
});
