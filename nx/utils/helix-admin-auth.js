/* eslint-disable no-use-before-define */
// Alternate identity provider for DA, alongside IMS (./ims.js) — delegates entirely to
// whichever idp helix-admin has configured as primary (HLX_ADMIN_AUTH_PROVIDER), discovered
// via its existing /login endpoint. Never hardcodes a provider name, so this stays correct
// if a deployment's primary idp changes.
//
// Exports the same function names as ims.js (loadIms, handleSignIn, handleSignOut) plus
// isAvailable(), so the small set of top-level bootstrap choke points that gate sign-in
// (nx/utils/signin.js, nx/utils/daFetch.js, da-live's initIms()) can pick a provider without
// hardcoding one. resolveAuthProvider() below is the one, shared implementation of that pick —
// nx/utils/signin.js and daFetch.js both call it rather than each carrying their own copy,
// after daFetch.js's own copy went missing for a full review cycle before anyone noticed.
// da-live's initIms() (a separate repo/PR) has its own inline version of the same logic and
// could call this instead — it already imports this whole module — but consolidating a
// different repo's already-reviewed PR is out of scope here; worth doing as a fast-follow.
//
// loadIms()'s resolved value is intentionally NOT ims.js's shape, though: the transient
// site token this is built on (see helix-admin-ams's getTransientSiteTokenInfo) carries only
// `sub` (email) and `exp` — no org list, no adobe.io profile. Consumers that read ims.js's
// richer fields (getOrgs(), getIo(), profile data — see profile.js, chat-controller.js, etc.)
// still import ims.js directly and are unaffected by this file; wiring them up here is out
// of scope for now, since it would mean fabricating data the backend doesn't have. Don't add
// stub getOrgs()/getIo() methods that return placeholder data — leaving them absent means a
// caller fails loudly instead of rendering fake-looking org/profile info.
//
// Always popup, never a top-level redirect: DA is a static site with no server-side endpoint
// to receive the POST helix-admin's redirect flavor expects, in either iframe or top-level
// context. The popup delivers its result via postMessage instead (see handleSignIn).

import { HLX_ADMIN } from './utils.js';

const STORAGE_KEY = 'da-helix-admin-auth';
// Origin-validation only, matching helix-admin's CLIENTS['da-live'].isValidRedirectUri — no
// page is ever served at this path. Ties sign-in to the exact origin serving this script, so
// it only works on domains helix-admin has registered (production), not branch previews.
const REDIRECT_URI = `${window.location.origin}/.da/login/ack`;
const POPUP_CLOSED_POLL_MS = 500;

// window.location.reload is a non-configurable, non-writable own property in real browsers
// (confirmed empirically, not an assumption) — tests can't stub or reassign it directly.
// Indirecting through a plain, mutable object gives tests a seam without changing behavior.
export const testHooks = { reload: () => window.location.reload() };
function reload() {
  testHooks.reload();
}

function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// 'nx-ims' is ims.js's own flag for "a session might be active," read by consumers (e.g.
// da-live's getAuthToken()) as a fast, synchronous pre-check before ever calling loadIms() —
// not actually IMS-specific despite the name, just the only provider that existed when it was
// named. Set/cleared here too so those consumers work the same regardless of which provider
// is active; skipping this left the alternate provider's sessions invisible to them.
function readStoredToken() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    localStorage.removeItem('nx-ims');
    return null;
  }
  if (!stored?.token || !stored?.exp) {
    // Self-heals nx-ims regardless of prior state, matching ims.js's own loadIms(), rather
    // than only clearing it on the expiry transition below — this function only ever runs
    // when the alternate provider is this deployment's active one (isAvailable() already
    // gated on that upstream), so there is no other provider's nx-ims session to clobber.
    localStorage.removeItem('nx-ims');
    return null;
  }
  if (stored.exp * 1000 <= Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('nx-ims');
    return null;
  }
  return stored;
}

function storeToken(siteToken) {
  const payload = decodeJwtPayload(siteToken.replace(/^hlxtst_/, ''));
  if (!payload?.exp) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: siteToken, exp: payload.exp }));
  localStorage.setItem('nx-ims', true);
}

export function handleSignOut() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('nx-ims');
}

// helix-admin's /login already applies isIdpAvailable()/HLX_ADMIN_AUTH_PROVIDER (see
// helix-admin-ams src/login/login.js) and returns exactly one login_<name> link when a
// deployment has a primary idp set. Read whichever one comes back — never the idp's name.
async function discoverLoginUrl() {
  const resp = await fetch(`${HLX_ADMIN}/login`, { credentials: 'omit' });
  if (!resp.ok) return null;
  const { links } = await resp.json();
  const entry = Object.entries(links || {}).find(
    ([key]) => key.startsWith('login_') && !key.endsWith('_sa'),
  );
  return entry?.[1] || null;
}

// Called from top-level bootstrap choke points on every page load (unlike discoverLoginUrl's
// other caller, handleSignIn, which only runs on an actual sign-in click) — so unlike
// discoverLoginUrl, this must never reject. A deployment with no alternate idp configured
// (the common case today) has to fall back to ims.js cleanly, not break on a network hiccup.
export const isAvailable = (() => {
  let available;
  return () => {
    available ??= discoverLoginUrl().then((url) => !!url).catch(() => false);
    return available;
  };
})();

export function handleSignIn() {
  // Opened synchronously, in the same task as the caller's click — popup blockers reject
  // window.open() called after an await, so discovery has to happen after opening, not before.
  const popup = window.open('', 'da-helix-admin-auth', 'width=500,height=650');
  if (!popup) return;

  (async () => {
    let url;
    try {
      const loginUrl = await discoverLoginUrl();
      url = loginUrl && new URL(loginUrl);
    } catch {
      url = null;
    }
    // /login only ever returns a same-deployment helix-admin URL (see discoverLoginUrl) —
    // the protocol check guards against a misconfigured or compromised backend response
    // navigating the popup somewhere unexpected (e.g. a javascript: URI, which would run in
    // this same-origin popup). A rejected discovery fetch (network blip, bad JSON, etc.) hits
    // the same close-and-give-up path as "no idp configured" — leaving the popup open and
    // blank forever on a transient error would be worse than closing it.
    if (!url || url.protocol !== 'https:') {
      popup.close();
      return;
    }

    url.searchParams.set('client_id', 'da-live');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_mode', 'popup');
    popup.location = url.href;

    const targetOrigin = new URL(HLX_ADMIN).origin;
    let settled = false;
    const finish = () => {
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
    };

    function onMessage(event) {
      if (settled || event.origin !== targetOrigin || event.source !== popup) return;
      finish();
      if (event.data?.siteToken) {
        storeToken(event.data.siteToken);
        reload();
      } else {
        // A correctly-originated message with no token (e.g. an explicit error payload)
        // still needs the popup closed — finish() only stops watching it, it doesn't close it.
        popup.close();
      }
    }
    window.addEventListener('message', onMessage);

    const poll = setInterval(() => {
      if (popup.closed && !settled) finish();
    }, POPUP_CLOSED_POLL_MS);
  })();
}

export const loadIms = (() => {
  let auth;
  const setup = () => Promise.resolve().then(() => {
    const stored = readStoredToken();
    return stored ? { accessToken: { token: stored.token } } : { anonymous: true };
  });
  return () => {
    auth ??= setup();
    return auth;
  };
})();

// The one, shared "which provider" decision — see the file header for why this exists as a
// single function rather than each caller reimplementing it. Races isAvailable() against the
// (lazy, side-effecting) ims.js import so a deployment with no alternate idp configured — the
// common case — doesn't pay a sequential round trip before IMS setup even starts; ims.js's own
// promise is caught here rather than left to reject the whole Promise.all, so a hiccup loading
// the module the alt-provider path doesn't even need can't take down the path that does.
export async function resolveAuthProvider() {
  const [useAlt, imsModule] = await Promise.all([
    isAvailable(),
    import('./ims.js').catch(() => null),
  ]);
  return {
    useAlt,
    authModule: useAlt ? { loadIms, handleSignIn, handleSignOut } : imsModule,
  };
}
