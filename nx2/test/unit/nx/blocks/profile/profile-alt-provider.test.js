import { expect } from '@esm-bundle/chai';
import { setConfig } from '../../../../../scripts/nx.js';
import { HLX_ADMIN } from '../../../../../../nx/utils/utils.js';

// Own file: resolveAuthProvider()'s isAvailable() memoizes at module scope, and
// customElements.define('nx-profile', ...) can only happen once per page — both
// constraints mean the alt-provider render path can only be observed from a
// fresh module graph/page, not a second describe block sharing profile.test.js's
// own. Mirrors the same reasoning already used for da-auth-status's split test
// files in hlx6-da-live.
const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function storeAltProviderToken({ sub = 'user@example.com', name } = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `hlxtst_header.${b64url({ sub, exp, ...(name ? { name } : {}) })}.sig`;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp }));
}

function stubDiscovery() {
  const saved = window.fetch;
  window.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr === `${HLX_ADMIN}/login`) {
      return new Response(JSON.stringify({
        links: { 'login_access-manager': `${HLX_ADMIN}/auth/access-manager` },
      }), { status: 200 });
    }
    return saved.call(window, url, opts);
  };
  return () => { window.fetch = saved; };
}

async function waitFor(predicate, { attempts = 50, interval = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, interval); });
  }
  return predicate();
}

await setConfig({ hostnames: [] });
await import('../../../../../blocks/profile/profile.js');

describe('nx-profile — alt provider (Okta/access-manager)', () => {
  let el;
  let restoreDiscovery;

  before(async () => {
    // Scoped to this describe block's own setup, not file-top-level — isAvailable()'s
    // discovery fetch and the stored token are both only read once, on connectedCallback
    // below, so there's no need to have either active any earlier than immediately before
    // that (minimizes the window localStorage is polluted for any other test file sharing
    // this origin).
    restoreDiscovery = stubDiscovery();
    storeAltProviderToken({ sub: 'user@example.com', name: 'Test User' });
    el = document.createElement('nx-profile');
    document.body.append(el);
    await waitFor(() => el._ims);
    await el.updateComplete;
  });

  after(() => {
    el?.remove();
    restoreDiscovery();
    localStorage.removeItem(STORAGE_KEY);
  });

  it('renders initials instead of a broken avatar image', () => {
    const initials = el.shadowRoot.querySelector('#profile-btn .nx-avatar-initials');
    const img = el.shadowRoot.querySelector('#profile-btn img');
    expect(img).to.be.null;
    expect(initials).to.not.be.null;
    expect(initials.textContent.trim()).to.equal('TU');
  });

  it('shows the display name and email in the details popover', () => {
    expect(el.shadowRoot.querySelector('.nx-display-name').textContent.trim()).to.equal('Test User');
    expect(el.shadowRoot.querySelector('.nx-email').textContent.trim()).to.equal('user@example.com');
  });

  it('hides Account, Preferences, and Admin Console links', () => {
    const links = [...el.shadowRoot.querySelectorAll('.nx-menu-links a')].map((a) => a.textContent.trim());
    expect(links).to.not.include('Account');
    expect(links).to.not.include('Preferences');
    expect(links).to.not.include('Admin Console');
  });

  it('keeps the Legal notices entry', () => {
    const legalBtn = el.shadowRoot.querySelector('.nx-menu-links .nx-menu-link-btn');
    expect(legalBtn).to.not.be.null;
    expect(legalBtn.textContent.trim()).to.equal('Legal notices');
  });

  it('does not render an Organization section (no org data for the alt provider)', () => {
    expect(el.shadowRoot.querySelector('.nx-menu-btn-org')).to.be.null;
  });
});
