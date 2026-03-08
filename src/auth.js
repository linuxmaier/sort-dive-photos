// Google OAuth via Google Identity Services (token model).
// No backend required — tokens are short-lived and stored in localStorage.

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

let tokenClient = null;
let resolveSignIn = null;

export function initAuth(clientId) {
  return new Promise((resolve) => {
    // GIS library loads async; poll until ready
    const wait = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(wait);
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPES,
          callback: (response) => {
            if (response.error || !response.access_token) return;
            const expiry = Date.now() + (response.expires_in - 60) * 1000;
            localStorage.setItem('sdp_token', response.access_token);
            localStorage.setItem('sdp_token_expiry', expiry);
            if (resolveSignIn) { resolveSignIn(response.access_token); resolveSignIn = null; }
          },
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

export function signIn() {
  return new Promise((resolve) => {
    resolveSignIn = resolve;
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  const token = getToken();
  if (token) google.accounts.oauth2.revoke(token, () => {});
  localStorage.removeItem('sdp_token');
  localStorage.removeItem('sdp_token_expiry');
  localStorage.removeItem('sdp_email');
}

export function isSignedIn() {
  return !!getToken();
}

// Fetch the user's email for display purposes
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
