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
// isAuthenticated() and getAccessToken() sit above the provider split too, for callers that
// just want a yes/no or a token and don't need useAlt/authModule at all.
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
// Embedded inline (Okta Sign-In Widget, Interaction Code flow), not a popup window or a
// top-level redirect: a popup can get silently orphaned/lost if the user navigates the main
// tab away before finishing, and this is a static site with no server-side endpoint to receive
// the POST a top-level redirect flavor expects. The widget authenticates directly against Okta
// from right inside the page (see openSignInWidget), handing back tokens with no navigation at
// all. See auth-migration/ for the Okta-side (Interaction Code grant + CORS) prerequisites this
// depends on.

import { HLX_ADMIN } from './utils.js';

const STORAGE_KEY = 'da-helix-admin-auth';
// Set on an explicit sign-out so the silent sign-in doesn't undo it; the Okta session outlives it.
const SIGNED_OUT_KEY = 'da-helix-admin-signed-out';
const SILENT_TRIED_KEY = 'da-helix-admin-silent-tried';

// window.location.reload is a non-configurable, non-writable own property in real browsers
// (confirmed empirically, not an assumption) — tests can't stub or reassign it directly.
// Indirecting through a plain, mutable object gives tests a seam without changing behavior.
// loadWidget is the same idea for the vendored widget bundle: a dynamic import() of a fixed
// relative path can't be swapped out per-test any other way without import-map plumbing this
// file otherwise has no need for.
export const testHooks = {
  reload: () => window.location.reload(),
  loadWidget: () => import('../deps/okta-signin-widget/dist/index.js'),
};
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
  localStorage.removeItem(SIGNED_OUT_KEY);
}

// Real IMS's handleSignOut (ims.js) redirects the whole page to IMS's own logout flow, which
// naturally refreshes every bit of UI reading auth state — this provider has no equivalent
// navigation, so nothing would otherwise prompt nx-profile (or anything else) to notice the
// session is gone until an unrelated reload happened to occur.
export function handleSignOut() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('nx-ims');
  localStorage.setItem(SIGNED_OUT_KEY, true);
  reload();
}

// Provider-agnostic on purpose — nx-ims is the shared flag (see readStoredToken above), so
// this doesn't need to know which provider is active. Exists so callers like daFetch's gate
// have a named check instead of reading localStorage themselves.
export function isAuthenticated() {
  return !!localStorage.getItem('nx-ims');
}

// helix-admin's /login returns every idp with real credentials configured — ALL of them
// (google, microsoft, adobe, ...), not just one, whenever HLX_ADMIN_AUTH_PROVIDER isn't set
// (confirmed against the real endpoint, not assumed: it returns five separate providers today).
// It only narrows to exactly one login_<name> link when that env var pins a single primary
// (isIdpAvailable() in helix-admin-ams). So the count itself is the signal: more than one link
// means nothing is pinned and IMS/Adobe should stay the default, same as before this file
// existed — picking whichever entry happens to sort first (the previous behavior here) would
// silently misroute to an arbitrary provider instead. The one name that does matter: a pin on
// an IMS-backed idp (IMS_IDPS) means "use ims.js", not this module, so it must not count.
const IMS_IDPS = new Set(['adobe', 'adobe-stage', 'ims-na1', 'ims-na1-stg1']);

async function discoverLoginUrl() {
  const resp = await fetch(`${HLX_ADMIN}/login`, { credentials: 'omit' });
  if (!resp.ok) return null;
  const { links } = await resp.json();
  const entries = Object.entries(links || {}).filter(
    ([key]) => key.startsWith('login_') && !key.endsWith('_sa'),
  );
  if (entries.length !== 1) return null;
  const [[key, url]] = entries;
  return IMS_IDPS.has(key.slice('login_'.length)) ? null : url;
}

// Called from top-level bootstrap choke points on every page load (unlike discoverLoginUrl's
// other caller, handleSignIn, which only runs on an actual sign-in click) — so unlike
// discoverLoginUrl, this must never reject. A deployment with no alternate idp configured
// (the common case today) has to fall back to ims.js cleanly, not break on a network hiccup.
export const isAvailable = (() => {
  let available;
  // One retry before caching a negative result — discoverLoginUrl() is a single network
  // round trip with no retry of its own, so a transient failure (slow/cold backend, one
  // dropped request) would otherwise be memoized as "no alt provider" for the rest of the
  // page's life, silently falling back to real IMS for reasons that have nothing to do with
  // whether the deployment actually has an alt provider configured.
  return () => {
    available ??= discoverLoginUrl().then((url) => !!url).catch(
      () => discoverLoginUrl().then((url) => !!url).catch(() => false),
    );
    return available;
  };
})();

// Public, non-secret OIDC client details (issuer + client_id) — see /auth/okta/config
// in helix-admin-ams for why this is a separate call from discoverLoginUrl() above: the widget
// authenticates directly against Okta from inside the page, so it needs these to initialize
// itself, unlike the popup/redirect flow (now gone) where helix-admin constructed the real
// Okta authorize URL server-side and the browser never needed to see them.
async function fetchWidgetConfig() {
  try {
    const resp = await fetch(`${HLX_ADMIN}/auth/okta/config`, { credentials: 'omit' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const WIDGET_CSS_HREF = new URL('../deps/okta-signin-widget/dist/css/okta-sign-in.min.css', import.meta.url).href;
const DIALOG_STYLE_ID = 'da-helix-admin-auth-widget-dialog-style';

function ensureWidgetStyle() {
  if (document.querySelector(`link[href="${WIDGET_CSS_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = WIDGET_CSS_HREF;
  document.head.append(link);

  if (document.getElementById(DIALOG_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = DIALOG_STYLE_ID;
  // Sizing/backdrop only — the widget's own CSS (above) handles everything inside it.
  style.textContent = `
    .da-helix-admin-auth-widget-dialog {
      padding: 16px 0;
      border: none;
      border-radius: 8px;
      max-width: 480px;
      width: 90vw;
    }
    .da-helix-admin-auth-widget-dialog::backdrop {
      background: rgb(0 0 0 / 50%);
    }
    /* EDS's own "progressive section appearance" rule (nexter.css/styles.css) hides any
       main > div / main > div[data-status] site-wide until a section is decorated — it has
       no scoping against unrelated <main> elements, so it also catches the widget's own
       internal <main id="okta-sign-in"> and hides its content. nx2's variant nests this under
       html:has(...), which outranks a plain extra class on specificity alone, so !important
       is needed here rather than relying on specificity to restore the widget's own display. */
    .da-helix-admin-auth-widget-dialog main > div,
    .da-helix-admin-auth-widget-dialog main > div[data-status] {
      display: revert !important;
    }
    /* da-live's browse.css styles every page-wide img as width:100% plus a fade mask, which
       stretches and fades the brand logo; the widget's own max-width/max-height still apply. */
    .da-helix-admin-auth-widget-dialog .auth-org-logo {
      width: auto;
      height: auto;
      mask-image: none;
    }
    /* The widget assumes a full-page login and adds margin-top: 100px (dropped only on short
       screens) plus a bottom margin; the dialog's own padding sets the even spacing instead. */
    .da-helix-admin-auth-widget-dialog #okta-sign-in {
      margin-top: 0;
      margin-bottom: 0;
    }
  `;
  document.head.append(style);
}

// Plain <dialog> on purpose — this module is shared by nx1 and nx2 (see file header), which
// have no common dialog/modal component between them, and a native element needs neither.
function createSignInDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'da-helix-admin-auth-widget-dialog';
  const container = document.createElement('div');
  // The widget's el option takes a CSS selector, not an element reference — id has to be
  // unique enough that a stray leftover dialog from a previous, not-yet-cleaned-up attempt
  // can't collide with it.
  container.id = `da-helix-admin-auth-widget-${Date.now()}`;
  dialog.append(container);
  document.body.append(dialog);
  return { dialog, container };
}

// A user whose Okta account federates to an upstream IdP leaves the page mid-flow, then comes
// back to the widget's redirectUri with the outcome in the query string.
function isRedirectReturn() {
  const params = new URLSearchParams(window.location.search);
  return params.has('state')
    && (params.has('interaction_code') || params.get('error') === 'interaction_required');
}

function buildWidget(OktaSignIn, config) {
  return new OktaSignIn({
    baseUrl: new URL(config.issuer).origin,
    clientId: config.clientId,
    // Where Okta sends the tab back after an upstream-IdP hop; must be registered on the
    // widget's Okta app. The widget's saved transaction lives in this origin's storage, so
    // the resume has to happen here, not on helix-admin.
    redirectUri: `${window.location.origin}/`,
    useInteractionCodeFlow: true,
    // The /oie export's constructor throws unless this is explicitly false — undefined
    // isn't good enough, it only ever checks for the exact opposite value (true).
    useClassicEngine: false,
    authParams: {
      issuer: config.issuer,
      scopes: ['openid', 'profile', 'email'],
    },
    // The customer's own Okta brand logo, from helix-admin; omitted entirely when there is none.
    ...(config.logo ? { logo: config.logo, logoText: 'Logo' } : {}),
    i18n: { en: { 'primaryauth.title': 'Sign In to Author' } },
  });
}

async function exchangeIdToken(idToken) {
  const resp = await fetch(`${HLX_ADMIN}/auth/okta/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!resp.ok) return null;
  const { siteToken } = await resp.json();
  return siteToken || null;
}

async function openSignInWidget({ resume = false } = {}) {
  const config = await fetchWidgetConfig();
  // No gesture-free fallback here (matching the old popup flow's same silent no-op on a
  // discovery failure) — this click is the only gesture available, and there's nothing
  // sensible to retry into without one.
  if (!config) return;

  ensureWidgetStyle();
  const { dialog, container } = createSignInDialog();

  let widget;
  const cleanup = () => {
    widget?.remove();
    dialog.close();
    dialog.remove();
    // reload() reuses the current URL, so leaving the redirect params would loop back here.
    if (resume) window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  };
  dialog.addEventListener('cancel', cleanup);

  try {
    const { default: OktaSignIn } = await testHooks.loadWidget();
    widget = buildWidget(OktaSignIn, config);
    let idToken;
    if (resume && new URLSearchParams(window.location.search).has('interaction_code')) {
      const { authClient } = widget;
      await authClient.idx.handleInteractionCodeRedirect(window.location.href);
      ({ idToken: { idToken } = {} } = await authClient.tokenManager.getTokens());
    } else {
      dialog.showModal();
      const tokens = await widget.showSignInToGetTokens({ el: `#${container.id}` });
      idToken = tokens?.idToken?.idToken;
    }
    if (!idToken) {
      cleanup();
      return;
    }

    const siteToken = await exchangeIdToken(idToken);
    cleanup();
    if (!siteToken) return;
    storeToken(siteToken);
    reload();
  } catch {
    cleanup();
  }
}

// The session is per-origin, so a user already signed in elsewhere (e.g. via the sidekick on
// the preview site) looks anonymous here although their Okta session is live. Ask Okta once,
// without UI; if that needs user input, stay anonymous and leave it to the sign-in button.
async function trySilentSignIn() {
  if (localStorage.getItem(SIGNED_OUT_KEY) || sessionStorage.getItem(SILENT_TRIED_KEY)) return;
  sessionStorage.setItem(SILENT_TRIED_KEY, true);
  let widget;
  try {
    const config = await fetchWidgetConfig();
    if (!config) return;
    const { default: OktaSignIn } = await testHooks.loadWidget();
    widget = buildWidget(OktaSignIn, config);
    const { authClient } = widget;
    // start() never exchanges the code itself; it hands back the interaction code only.
    const { status, interactionCode, meta } = await authClient.idx.start();
    if (status !== 'SUCCESS' || !interactionCode) return;
    const codeVerifier = meta?.codeVerifier ?? authClient.transactionManager.load()?.codeVerifier;
    const { tokens } = await authClient.token.exchangeCodeForTokens({
      interactionCode, codeVerifier,
    });
    const siteToken = tokens?.idToken ? await exchangeIdToken(tokens.idToken.idToken) : null;
    if (!siteToken) return;
    storeToken(siteToken);
    reload();
  } catch {
    // no usable session; manual sign-in still works
  } finally {
    widget?.remove();
  }
}

export function handleSignIn() {
  return openSignInWidget();
}

export const loadIms = (() => {
  let auth;
  const setup = () => Promise.resolve().then(() => {
    // Not awaited: it may need UI (MFA), which must not hold up the page's own startup.
    const redirectReturn = isRedirectReturn();
    if (redirectReturn) openSignInWidget({ resume: true });
    const stored = readStoredToken();
    if (!stored) {
      if (!redirectReturn) trySilentSignIn();
      return { anonymous: true };
    }
    // The transient site token's only real profile data (see file header) — `sub` is the
    // signed-in user's email (helix-admin-ams's getTransientSiteTokenInfo/
    // getTransientAccountTokenInfo both set it as the subject), and `name` (when present) is
    // threaded through from whatever the idp's own id_token provided at sign-in time. Surfaced
    // as `displayName`, not `name` — matches nx2/blocks/profile/profile.js's existing IMS
    // contract (`this._ims.displayName`), so that component doesn't need a second field name
    // for the same concept. Decode failure (or missing fields) falls back to omitting them
    // rather than throwing, same as storeToken's own handling.
    const payload = decodeJwtPayload(stored.token.replace(/^hlxtst_/, ''));
    return {
      accessToken: { token: stored.token },
      ...(payload?.sub ? { email: payload.sub } : {}),
      ...(payload?.name ? { displayName: payload.name } : {}),
    };
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

// The token half of the adapter surface — callers that just want something to put in an
// Authorization header don't need resolveAuthProvider()'s useAlt/authModule split at all.
export async function getAccessToken() {
  const { authModule } = await resolveAuthProvider();
  try {
    const details = await authModule?.loadIms();
    return details?.accessToken ?? null;
  } catch {
    return null;
  }
}
