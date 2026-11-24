// The Google sign-in page shown during the OAuth authorize step.
// Served by the Function App itself (same origin as /oauth/complete).
//
// The page uses the Firebase Auth JS SDK (same versions as the tracker app)
// and the tracker's own Google sign-in. After sign-in it sends the Firebase
// ID token to /oauth/complete, which verifies it server-side and redirects
// the browser back to the MCP client (Claude / ChatGPT) with the auth code.
// The ID token never leaves this origin except in that one POST.

function escJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function authorizePageHtml({
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod,
  state,
  scopes,
  firebaseWeb,
}) {
  const oauthParams = {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state: state || "",
    scopes: scopes || [],
  };
  const firebaseConfig = {
    apiKey: firebaseWeb.apiKey,
    authDomain: firebaseWeb.authDomain,
    projectId: firebaseWeb.projectId,
    appId: firebaseWeb.appId,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Application Tracker</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0c3830; color: #f4f1ea; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; box-sizing: border-box; }
  .card { background: #fff; color: #17251f; border-radius: 16px; padding: 28px 26px; max-width: 420px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { font-size: 14px; line-height: 1.5; color: #44514b; margin: 0 0 16px; }
  button { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; border-radius: 10px; border: 1px solid #d8d2c4; background: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; }
  button:hover { background: #f6f3ec; }
  button:disabled { opacity: .6; cursor: default; }
  #status { font-size: 13px; color: #44514b; margin-top: 14px; min-height: 18px; }
  #error { font-size: 13px; color: #a33; margin-top: 10px; display: none; white-space: pre-wrap; }
  .fine { font-size: 12px; color: #7a857f; margin-top: 18px; }
</style>
</head>
<body>
<div class="card">
  <h1>Connect to Application Tracker</h1>
  <p>Sign in with Google to let your AI assistant manage your job applications. It can read them and add, update, or delete them at your direction. You will only ever see your own applications.</p>
  <button id="googleBtn" type="button">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
    Sign in with Google
  </button>
  <div id="status"></div>
  <div id="error"></div>
  <p class="fine">Application Tracker &middot; applicationtracker.app</p>
</div>
<script type="application/json" id="oauth-params">${escJson(oauthParams)}</script>
<script type="application/json" id="firebase-config">${escJson(firebaseConfig)}</script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
<script>
(function () {
  var params = JSON.parse(document.getElementById('oauth-params').textContent);
  var fbConfig = JSON.parse(document.getElementById('firebase-config').textContent);
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var btn = document.getElementById('googleBtn');

  function setStatus(t) { statusEl.textContent = t || ''; }
  function showError(e) {
    var msg = (e && e.message) || String(e || 'Sign-in failed.');
    errorEl.style.display = 'block';
    errorEl.textContent = msg;
    btn.disabled = false;
    setStatus('');
  }

  firebase.initializeApp(fbConfig);
  var auth = firebase.auth();
  var provider = new firebase.auth.GoogleAuthProvider();

  function completeSignIn(user) {
    setStatus('Verifying sign-in…');
    return user.getIdToken().then(function (idToken) {
      return fetch('/oauth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: idToken,
          clientId: params.clientId,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          codeChallengeMethod: params.codeChallengeMethod,
          state: params.state,
          scopes: params.scopes
        })
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && (data.error_description || data.error)) || 'Authorization failed.');
        if (!data.redirect) throw new Error('Authorization failed: no redirect returned.');
        setStatus('Signed in — returning you to your assistant…');
        window.location.href = data.redirect;
      });
    });
  }

  function signIn() {
    btn.disabled = true;
    setStatus('Opening Google sign-in…');
    errorEl.style.display = 'none';
    auth.signInWithPopup(provider).then(function (result) {
      return completeSignIn(result.user);
    }).catch(function (e) {
      // Popups are often blocked in embedded browsers; fall back to redirect.
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) {
        setStatus('Popup was blocked — switching to redirect sign-in…');
        return auth.signInWithRedirect(provider);
      }
      showError(e);
    }).catch(showError);
  }

  // Returning from a redirect sign-in: finish the flow automatically.
  auth.getRedirectResult().then(function (result) {
    if (result && result.user) {
      btn.disabled = true;
      return completeSignIn(result.user);
    }
  }).catch(function (e) {
    if (e && e.code !== 'auth/no-auth-event') showError(e);
  });

  btn.addEventListener('click', signIn);
})();
</script>
</body>
</html>`;
}
