import { expect } from '@esm-bundle/chai';
import { setConfig } from '../../../../nx/scripts/nexter.js';
import { HLX_ADMIN } from '../../../../nx/utils/utils.js';

// Own file: resolveAuthProvider()'s isAvailable() memoizes at module scope, and
// customElements.define('nx-profile', ...) can only happen once per page — both
// constraints mean the alt-provider render path can only be observed from a
// fresh module graph/page. Mirrors nx2's own profile-alt-provider.test.js.
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

setConfig({ nxBase: '/nx' });
await import('../../../../nx/blocks/profile/profile.js');

describe('nx-profile (nx1) — alt provider (Okta/access-manager)', () => {
  let el;
  let restoreDiscovery;

  before(async () => {
    restoreDiscovery = stubDiscovery();
    storeAltProviderToken({ sub: 'user@example.com', name: 'Test User' });
    el = document.createElement('nx-profile');
    document.body.append(el);
    await waitFor(() => el._details);
    await el.updateComplete;
  });

  after(() => {
    el?.remove();
    restoreDiscovery();
    localStorage.removeItem(STORAGE_KEY);
  });

  it('renders initials instead of a broken avatar image', () => {
    const initials = el.shadowRoot.querySelector('.nx-btn-profile .nx-avatar-initials');
    const img = el.shadowRoot.querySelector('.nx-btn-profile img');
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

  it('does not render an Organization section (no org data for the alt provider)', () => {
    expect(el.shadowRoot.querySelector('.nx-menu-btn-org')).to.be.null;
  });

  it('copies the email, not "undefined", when there is no adobe.io userId', async () => {
    let written;
    window.ClipboardItem = function ClipboardItem(data) { written = data; };
    navigator.clipboard.write = () => {};

    el.shadowRoot.querySelector('.nx-menu-btn-details').click();
    const blob = written['text/plain'];
    expect(await blob.text()).to.equal('user@example.com');
  });
});
