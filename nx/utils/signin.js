import * as altAuth from './helix-admin-auth.js';

// IMS's handleSignIn() is a top-level redirect (window.adobeIMS.signIn()), which needs no
// user gesture — safe to fire automatically below. The alternate provider's handleSignIn()
// opens an embedded sign-in widget inside a <dialog>, which still needs a real click behind
// it (dialog.showModal() itself doesn't require one, but calling this automatically here, as
// this function used to, read as the page silently hijacking focus into a sign-in form with
// no user action at all) — render a plain prompt button instead and defer to its click.
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

  const { useAlt, authModule } = await altAuth.resolveAuthProvider();
  if (!authModule) {
    // ims.js failed to load and it's the one this page needs — the page stays hidden with
    // no other recourse, so at least leave a diagnostic trail rather than fail in total silence.
    // eslint-disable-next-line no-console
    console.error('signin: ims.js failed to load; page will stay hidden.');
    return;
  }
  const { loadIms, handleSignIn } = authModule;

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
