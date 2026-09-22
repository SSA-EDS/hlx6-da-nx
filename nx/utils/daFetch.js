import { DA_ORIGIN, AEM_ORIGIN } from '../public/utils/constants.js';

let imsDetails;

export function setImsDetails(token) {
  imsDetails = { accessToken: { token } };
}

// Delegates to helix-admin-auth.js's resolveAuthProvider() — the one, shared "which provider"
// decision (see that file's header for why it's a single function rather than a copy here and
// in nx/utils/signin.js; this file's own previous copy is what motivated pulling it out).
// This wrapper is just the dynamic-import indirection daFetch's two call sites below share.
async function importAuthProvider() {
  const { resolveAuthProvider } = await import('./helix-admin-auth.js');
  return resolveAuthProvider();
}

export async function initIms() {
  if (imsDetails) return imsDetails;
  const { authModule } = await importAuthProvider();
  if (!authModule) return null;
  try {
    imsDetails = await authModule.loadIms();
    return imsDetails;
  } catch {
    return null;
  }
}

export const daFetch = async (url, opts = {}) => {
  opts.headers ||= {};
  if (localStorage.getItem('nx-ims') || imsDetails) {
    // initIms() legitimately resolves null (no provider available, or the active one's
    // loadIms() failed) — destructuring that directly throws instead of just skipping the
    // auth header, which is the correct degrade-gracefully behavior here.
    const accessToken = (await initIms())?.accessToken;
    if (accessToken) {
      opts.headers.Authorization = `Bearer ${accessToken.token}`;

      if (url.startsWith(AEM_ORIGIN)) {
        opts.headers['x-content-source-authorization'] = `Bearer ${accessToken.token}`;
      }
    }
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (err) {
    resp = new Response(null, { status: 500, statusText: err.message });
  }
  if (resp.status === 401) {
    const { useAlt, authModule } = await importAuthProvider();
    if (useAlt) {
      // The alternate provider's handleSignIn() opens a popup, which needs a real user
      // gesture behind it — this reactive, post-fetch continuation never has one (unlike
      // ims.js's handleSignIn() below, a gesture-free top-level redirect in the common
      // case). Clear the now-invalid session instead; the next real sign-in prompt (e.g.
      // nx/utils/signin.js's gate, which does require a click) picks it up correctly.
      authModule?.handleSignOut();
    } else if (authModule) {
      await authModule.loadIms();
      authModule.handleSignIn();
    }
  }
  resp.permissions = resp.headers.get('x-da-actions')?.split('=').pop().split(',');
  return resp;
};

export function replaceHtml(text, fromOrg, fromRepo, options = {}) {
  const { daMetadata = {}, replaceRelative = true } = options;
  let inner = text;

  if (fromOrg && fromRepo && replaceRelative) {
    const fromOrigin = `https://main--${fromRepo}--${fromOrg}.entmseds.live`;
    inner = text
      .replaceAll('./media', `${fromOrigin}/media`)
      .replaceAll('href="/', `href="${fromOrigin}/`);
  }

  let metadataHTML = '';
  if (Object.keys(daMetadata).length > 0) {
    // Values may be { content, text } from getElementMetadata or plain strings.
    const daRows = Object.entries(daMetadata)
      .map(([key, value]) => {
        const textContent = value?.text ?? value ?? '';
        return `<div><div>${key}</div><div>${textContent}</div></div>`;
      })
      .join('');
    metadataHTML = `\n  <div class="da-metadata">${daRows}</div>\n`;
  }

  return `
    <body>
      <header></header>
      <main>${inner}</main>
      ${metadataHTML}<footer></footer>
    </body>
  `;
}

export async function saveToDa(text, url, options = {}) {
  const { daMetadata = {}, replaceRelative = true } = options;
  const { org, repo, pathname } = url;
  const daPath = `/${org}/${repo}${pathname}`;
  const daHref = `https://entmseds-da.live/edit#${daPath}`;

  const body = replaceHtml(text, org, repo, { daMetadata, replaceRelative });

  const blob = new Blob([body], { type: 'text/html' });
  const formData = new FormData();
  formData.append('data', blob);
  const opts = { method: 'PUT', body: formData };
  try {
    const daResp = await daFetch(`${DA_ORIGIN}/source${daPath}.html`, opts);
    return { daHref, daStatus: daResp.status, daResp, ok: daResp.ok };
  } catch {
    // eslint-disable-next-line no-console
    console.log(`Couldn't save ${url.daUrl}`);
    return null;
  }
}

function getBlob(url, content) {
  const body = url.type === 'json'
    ? content : replaceHtml(content, url.fromOrg, url.fromRepo);

  const type = url.type === 'json' ? 'application/json' : 'text/html';

  return new Blob([body], { type });
}

export async function saveAllToDa(url, content) {
  const { toOrg, toRepo, destPath, editPath, type } = url;

  const route = type === 'json' ? '/sheet' : '/edit';
  url.daHref = `https://entmseds-da.live${route}#/${toOrg}/${toRepo}${editPath}`;

  const blob = getBlob(url, content);
  const body = new FormData();
  body.append('data', blob);
  const opts = { method: 'PUT', body };

  try {
    const resp = await daFetch(`${DA_ORIGIN}/source/${toOrg}/${toRepo}${destPath}`, opts);
    return resp.status;
  } catch {
    // eslint-disable-next-line no-console
    console.log(`Couldn't save ${destPath}`);
    return 500;
  }
}
