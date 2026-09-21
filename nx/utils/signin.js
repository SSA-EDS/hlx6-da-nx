import * as altAuth from './helix-admin-auth.js';

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
    handleSignIn();
    return;
  }

  document.body.style.removeProperty('display');
}());
