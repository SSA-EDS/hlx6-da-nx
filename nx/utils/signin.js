import * as altAuth from './helix-admin-auth.js';

// IMS's handleSignIn() is a top-level redirect (window.adobeIMS.signIn()), which needs no
// user gesture — safe to fire automatically below. The alternate provider's handleSignIn()
// opens a popup, which every browser blocks unless called from inside a real click; calling
// it automatically here (as this function used to, unconditionally) means it silently no-ops
// and the page stays hidden forever. Named window ('da-helix-admin-auth', set in
// helix-admin-auth.js) means repeat clicks refocus the same popup rather than opening more.
function renderSignInPrompt(onSignIn) {
  document.body.style.removeProperty('display');
  document.body.innerHTML = '';
  document.body.style.cssText = 'display:flex; align-items:center; justify-content:center; height:100vh;';
  const button = document.createElement('button');
  button.textContent = 'Sign in';
  button.addEventListener('click', onSignIn);
  document.body.append(button);
}

(async function signin() {
  document.body.style.display = 'none';

  // Run discovery and the (lazy, side-effecting) ims.js import in parallel so a deployment
  // with no alternate idp configured — the common case — doesn't pay a sequential round trip
  // before IMS setup even starts.
  const [useAlt, imsModule] = await Promise.all([
    altAuth.isAvailable(),
    import('./ims.js'),
  ]);
  const { loadIms, handleSignIn } = useAlt ? altAuth : imsModule;

  const imsDetails = await loadIms();
  if (!imsDetails.accessToken) {
    if (useAlt) {
      renderSignInPrompt(handleSignIn);
      return;
    }
    handleSignIn();
    return;
  }

  document.body.style.removeProperty('display');
}());
