# CLAUDE.md — Sort Dive Photos

Developer notes for working with this codebase.

---

## What this is

A PWA for tagging Insta360 scuba diving footage exports with trip, dive, and species/content tags. Designed for 2–3 people editing footage together. Offline-first. No backend — all persistent data lives in Google Sheets. Built with vanilla JS ES modules, no build step.

---

## Architecture

```
index.html          App shell, loads all modules via <script type="module">
manifest.json       PWA manifest, declares Web Share Target for direct clip sharing
sw.js               Service worker: offline asset cache + share target handler
config.js           Google credentials (committed; values are not secrets)
src/
  auth.js           Google OAuth via GIS token model. Two concepts: isKnownUser()
                    (persistent, gates the UI) vs getToken() (short-lived, needed
                    for API calls). Never block the UI on token availability.
  db.js             IndexedDB wrapper. Stores pending clips (offline queue) and
                    cached Sheet data (trips, dives, tags, participants).
  sheets.js         Google Sheets REST API. All reads fall back to IndexedDB cache.
                    Never calls interactive signIn() — throws on no token so callers
                    can handle gracefully.
  sync.js           Flushes pending clips from IndexedDB to Sheets. Called on the
                    online event and after successful sign-in.
  ocr.js            Tesseract.js wrapper. Extracts VID_YYYYMMDD_HHMMSS_NN_NNN from
                    a screenshot of the Insta360 file info pane.
  ui.js             All app logic: page navigation, tag/participant chip inputs,
                    file handling, thumbnail generation, modal forms, sync status.
css/style.css       Mobile-first dark ocean theme. All layout via CSS custom props.
icons/              Minimal PNG icons required for PWA installability.
```

---

## Key patterns

### Service worker cache versioning
**Every push that changes any static asset must bump the cache version in `sw.js`.**

```js
const CACHE_NAME = 'sdp-vN'; // increment N on every deploy
```

Without this, installed PWAs serve stale files. Users have to uninstall and reinstall to get updates.

### Auth separation
`isKnownUser()` checks for a stored email in localStorage (no expiry). `getToken()` checks for a live OAuth access token (expires after ~1 hour). The UI gates on `isKnownUser()`. API calls gate on `getToken()`. This keeps the app usable offline when the token has expired (e.g. mid-flight).

When connectivity returns, `tryRefreshToken()` attempts a silent refresh. If it succeeds, the amber token banner hides automatically.

### Offline queue
Clips are always written to IndexedDB first (`addPendingClip`), then synced to Sheets when online (`syncPending`). The queue is flushed on: submit (if online), the `online` event, explicit sync button tap, and re-authentication.

### Tag/participant input on mobile
Mobile virtual keyboards don't reliably fire `keydown` for Enter or comma. The tag input handles all three cases:
- `keydown`/`keyup` for Enter (physical keyboards)
- `oninput` watching for commas (mobile keyboards insert them as text)
- `onblur` auto-commits whatever is in the field (tapping away)

### Modal forms
Trip and dive creation use a modal bottom sheet (`#modal-overlay`) populated dynamically. `showTripModal()` and `showDiveModal()` return promises that resolve with form data or `null` (cancelled). The dive modal includes a participant chip input that reuses the same pattern as the tag input.

### Sheet fallback
Every `loadX()` function in `sheets.js` wraps the API call in try/catch and falls back to `getCacheEntry()`. This means stale data is always available offline rather than an empty state.

---

## Google Sheet schema

**trips** (A:E): `trip_id | name | location | start_date | end_date`

**dives** (A:G): `dive_id | trip_id | trip_name | dive_number | site_name | date | participants`

**clips** (A:L): `clip_id | filename | raw_file | recorded_at | trip_id | trip_name | dive_id | dive_label | tags | notes | tagged_at | tagged_by`

**album_mapping** (A:C): `tag | album_name | album_id` _(reserved for future use)_

Headers are written automatically by `ensureHeaders()` on first load if the row is empty. If a tab's header row needs resetting, clear the row contents (don't delete the row) and reload the app.

---

## Google OAuth notes

- **Scope**: `spreadsheets` (full Sheets access) and `userinfo.email`. The broad Sheets scope is intentional — the code only ever constructs URLs using the single hardcoded `SHEET_ID`. This is verifiable in `src/sheets.js`.
- **Client ID** is safe to commit — it identifies the app, not a user. Security comes from authorized origins in Google Cloud Console.
- **Test users**: all team members must be added to the OAuth consent screen under Test Users. The app stays in Testing mode indefinitely (no Google verification needed for a private tool).
- **Token expiry**: GIS tokens last ~1 hour. `tryRefreshToken()` attempts silent refresh on reconnect. If it fails (e.g. offline), the app shows a banner and continues in offline mode.

---

## Tesseract OCR

Loaded from CDN (`tesseract.js@5`). Runs entirely in-browser — no network call, works offline. Validates extracted text against `/VID_\d{8}_\d{6}_\d{2}_\d{3}/i` before accepting. If validation fails, shows an error asking the user to try a cleaner screenshot. The worker is reused across calls (initialized once, stored in module scope).

---

## Web Share Target

Declared in `manifest.json`. The service worker handles the POST to `/share-target`, stores files in the `sdp-shares` cache keyed by filename, then redirects to `/?shared=true`. On load, `checkForSharedFiles()` in `ui.js` detects this param, reads from the cache, and presents the files for tagging. The cache is cleared after reading.

iOS Web Share Target support for files is less reliable than Android. The file picker fallback (tap the drop zone) works universally.

---

## Known limitations / open issues

- **Album integration** (#5): Google Photos Library API cannot add existing photos to albums if uploaded via the native app. Options (Drive folders, manual population, Sheet-only reference) are under discussion.
- **Comma tags on mobile**: Fixed via `oninput` splitting — but if regressions appear, check that the `oninput` handler runs before `onblur`.
- **New trip/dive offline**: Creating trips/dives while offline writes to `state` immediately but the Sheet write fails silently. On reconnect, the data exists in the dropdowns for the session but the Sheet row was never written. A future improvement would be to queue trip/dive writes the same way clips are queued.

---

## Development

No build step. Open `index.html` directly or serve with any static file server:

```bash
python3 -m http.server 8000
# or
npx serve .
```

For Google OAuth to work locally, `http://localhost` must be in the authorized JavaScript origins in Google Cloud Console (already added).

Bump `CACHE_NAME` in `sw.js` before every commit that changes static files.
