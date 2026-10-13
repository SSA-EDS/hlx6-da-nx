import { expect } from '@esm-bundle/chai';
import { getAgentToken, loadIdentity, testHooks } from '../../../../nx2/blocks/chat/utils/identity.js';

describe('chat identity — alternate idp', () => {
  const realLoadApi = testHooks.loadApi;

  afterEach(() => {
    testHooks.loadApi = realLoadApi;
  });

  describe('getAgentToken', () => {
    const ctx = { org: 'myorg', site: 'mysite' };

    it('returns null when there is no session', async () => {
      testHooks.loadApi = async () => { throw new Error('should not load'); };
      expect(await getAgentToken(null, ctx)).to.equal(null);
    });

    it('returns the token untouched when org or site is unknown', async () => {
      testHooks.loadApi = async () => { throw new Error('should not load'); };
      expect(await getAgentToken({ token: 'hlxtst_account' }, { org: 'myorg' })).to.equal('hlxtst_account');
      expect(await getAgentToken({ token: 'hlxtst_account' })).to.equal('hlxtst_account');
    });

    it('returns the IMS token untouched when no alternate idp is active', async () => {
      testHooks.loadApi = async () => ({ useAlt: false, getAemSiteToken: () => { throw new Error('no'); } });
      expect(await getAgentToken({ token: 'ims-token' }, ctx)).to.equal('ims-token');
    });

    it('swaps in the site-scoped token under an alternate idp', async () => {
      let asked;
      testHooks.loadApi = async () => ({
        useAlt: true,
        getAemSiteToken: async (args) => {
          asked = args;
          return { siteToken: 'hlxtst_site' };
        },
      });
      expect(await getAgentToken({ token: 'hlxtst_account' }, ctx)).to.equal('hlxtst_site');
      expect(asked).to.deep.equal(ctx);
    });

    it('keeps the account-level token when the exchange yields none', async () => {
      testHooks.loadApi = async () => ({
        useAlt: true,
        getAemSiteToken: async () => ({ error: 'Error fetch AEM Site Token 403' }),
      });
      expect(await getAgentToken({ token: 'hlxtst_account' }, ctx)).to.equal('hlxtst_account');
    });
  });

  describe('loadIdentity', () => {
    it('uses the alternate idp session and derives a userId from the email', async () => {
      testHooks.loadApi = async () => ({
        useAlt: true,
        loadIms: async () => ({
          accessToken: { token: 'hlxtst_account' }, email: 'user@example.com', displayName: 'Test User',
        }),
      });
      const identity = await loadIdentity();
      expect(identity.userId).to.equal('user@example.com');
      expect(identity.displayName).to.equal('Test User');
      expect(identity.accessToken.token).to.equal('hlxtst_account');
    });

    it('does not invent a userId for an anonymous alternate idp session', async () => {
      testHooks.loadApi = async () => ({
        useAlt: true,
        loadIms: async () => ({ anonymous: true }),
      });
      const identity = await loadIdentity();
      expect(identity.anonymous).to.equal(true);
      expect(identity.userId).to.equal(undefined);
    });
  });
});
