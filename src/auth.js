// Google OAuth via Google Identity Services (token model).
// No backend required — tokens are short-lived and stored in localStorage.
//
// Two separate concepts:
//   isKnownUser()     — has this person ever signed in on this device? (persistent, no expiry)
//   getToken()        — is there a live API token right now? (expires after ~1 hour)
//
// The UI only requires isKnownUser(). A live token is only needed for Sheets API calls,
// which queue to IndexedDB when unavailable. This means the app works fully offline
// even if the token expired mid-flight.

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
].join(' ');

let tokenClient = null;
let pendingResolve = null;

function onTokenResponse(response) {
  if (response.error || !response.access_token) {
    if (pendingResolve) { pendingResolve(null); pendingResolve = null; }
    return;
  }
  const expiry = Date.now() + (response.expires_in - 60) * 1000;
  localStorage.setItem('sdp_token', response.access_token);
  localStorage.setItem('sdp_token_expiry', expiry);
  if (pendingResolve) { pendingResolve(response.access_token); pendingResolve = null; }
}

function onTokenError() {
  if (pendingResolve) { pendingResolve(null); pendingResolve = null; }
}

export function initAuth(clientId) {
  return new Promise((resolve) => {
    const wait = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(wait);
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPES,
          callback: onTokenResponse,
          error_callback: onTokenError,
        });
        resolve();
      }
    }, 100);
  });
}

export function getToken() {
  const token = localStorage.getItem('sdp_token');
  const expiry = parseInt(localStorage.getItem('sdp_token_expiry') ?? '0', 10);
  if (token && Date.now() < expiry) return token;
  return null;
}

// Has this person ever signed in on this device?
export function isKnownUser() {
  return !!localStorage.getItem('sdp_email');
}

// Try to get a token silently — no UI popup.
// Returns the token string, or null if offline or refresh fails.
export function tryRefreshToken() {
  return new Promise((resolve) => {
    const existing = getToken();
    if (existing) { resolve(existing); return; }
    if (!navigator.onLine || !tokenClient) { resolve(null); return; }

    pendingResolve = resolve;
    tokenClient.requestAccessToken({ prompt: '' });

    // Give up after 5s in case GIS doesn't respond (network issues)
    setTimeout(() => {
      if (pendingResolve === resolve) { pendingResolve = null; resolve(null); }
    }, 5000);
  });
}

// Interactive sign-in — shows the Google account picker UI.
export function signIn() {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });
}

export function signOut() {
  const token = getToken();
  if (token) google.accounts.oauth2.revoke(token, () => {});
  localStorage.removeItem('sdp_token');
  localStorage.removeItem('sdp_token_expiry');
  localStorage.removeItem('sdp_email');
}

export async function getUserEmail() {
  const cached = localStorage.getItem('sdp_email');
  if (cached) return cached;
  const token = getToken();
  if (!token) return null;
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  localStorage.setItem('sdp_email', data.email);
  return data.email;
}
