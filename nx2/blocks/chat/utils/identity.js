import { loadIms as loadNx2Ims } from '../../../utils/ims.js';

// Seam for tests: api.js does network discovery at import time.
export const testHooks = {
  loadApi: () => import('../../../utils/api.js'),
};

// nx2's ims.js only knows Adobe IMS, so with an alternate idp (Okta) the chat would have no
// session at all. IMS deployments keep going through it unchanged.
export async function loadIdentity() {
  const api = await testHooks.loadApi();
  if (!api.useAlt) return loadNx2Ims();
  const details = await api.loadIms();
  return { ...details, userId: details.userId ?? details.email };
}

// The agent forwards this token to da-admin, which rejects the alternate idp's account-level
// token on site paths. A failed exchange leaves the account-level token in use.
export async function getAgentToken(accessToken, { org, site } = {}) {
  const token = accessToken?.token ?? null;
  if (!token || !org || !site) return token;
  const api = await testHooks.loadApi();
  if (!api.useAlt) return token;
  const { siteToken } = await api.getAemSiteToken({ org, site });
  return siteToken ?? token;
}
