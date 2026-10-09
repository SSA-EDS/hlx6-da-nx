import { expect } from '@esm-bundle/chai';
import { HLX_ADMIN } from '../../../../nx/utils/utils.js';

// Own file: isAvailable()/loadIms() memoize at module scope, so the alt provider can only be
// observed resolving from a fresh module graph. Regression: secure-org called nx2's IMS
// loader directly, so an Okta user never got past "Email has not been verified" (emailVerified
// is an IMS-only field) and could not secure an org.
const STORAGE_KEY = 'da-helix-admin-auth';

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('nx/blocks/secure-org — alt provider (Okta)', () => {
  let origFetch;
  let configBody;

  before(async () => {
    origFetch = window.fetch;
    configBody = { data: { total: 1, data: [{}] } };
    window.fetch = async (url) => {
      const u = url.toString();
      if (u === `${HLX_ADMIN}/login`) {
        return new Response(JSON.stringify({
          links: { login_okta: `${HLX_ADMIN}/auth/okta` },
        }), { status: 200 });
      }
      if (u.includes('/config/myorg/')) {
        return new Response(JSON.stringify(configBody), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `hlxtst_header.${b64url({ sub: 'user@example.com', exp })}.sig`;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp }));

    await import('../../../../nx/blocks/secure-org/secure-org.js');
  });

  afterEach(() => {
    document.querySelectorAll('nx-secure-org').forEach((el) => el.remove());
  });

  after(() => {
    window.fetch = origFetch;
    localStorage.removeItem(STORAGE_KEY);
  });

  async function loadOrg(org) {
    const el = document.createElement('nx-secure-org');
    document.body.append(el);
    await el.updateComplete;
    await el.handleDetail({ detail: { org } });
    return el;
  }

  it('lets an Okta user secure an org without an IMS emailVerified flag', async () => {
    const el = await loadOrg('myorg');

    expect(el._alert).to.equal(undefined);
    expect(el._user.email).to.equal('user@example.com');
  });

  it('reports an org that already has permissions as secured', async () => {
    configBody = { data: { data: [{}] }, permissions: { data: [] } };
    const el = await loadOrg('myorg');

    expect(el._alert.type).to.equal('success');
    expect(el._user).to.equal(undefined);
  });
});
