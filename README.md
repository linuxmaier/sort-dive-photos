# Sort Dive Photos

A PWA for tagging and organizing Insta360 scuba diving footage. Works offline (useful for editing on the plane home). Steady-state data lives in Google Sheets and Google Photos — the app is just a helper.

**Live app:** https://linuxmaier.github.io/sort-dive-photos/

---

## Setup (one-time, ~20 minutes)

### 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet named **Sort Dive Photos** (or anything you like).
2. Create four tabs named exactly:
   - `trips`
   - `dives`
   - `clips`
   - `album_mapping`
3. The app will write the header rows automatically on first use.
4. Share the sheet with all 2–3 team members (Editor access).
5. Copy the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`

### 2. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project (name it anything, e.g. "Sort Dive Photos").
3. A billing account is required to create a project — add a card, but you will not be charged. All APIs used here are free at this scale.

### 3. Enable APIs

In the Google Cloud Console for your project, enable:
- **Google Sheets API** — search "Sheets API" in the API library
- **Google People API** (for user email display) — search "People API"

### 4. Create OAuth credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
2. Application type: **Web application**.
3. Add to **Authorized JavaScript origins**:
   - `https://linuxmaier.github.io`
   - `http://localhost` (for local testing)
4. Click Create. Copy the **Client ID** (looks like `123456789-abc.apps.googleusercontent.com`).
5. Go to **APIs & Services → OAuth consent screen**. Add each team member's Google account under **Test users** (required while the app is in "Testing" mode).

### 5. Configure the app

Each person who uses the app needs a local `config.js`:

```bash
cp config.example.js config.js
```

Edit `config.js` and fill in:
- `GOOGLE_CLIENT_ID` — from step 4
- `SHEET_ID` — from step 1

`config.js` is in `.gitignore` and will not be committed.

### 6. Enable GitHub Pages

In the repo settings on GitHub:
- Go to **Settings → Pages**
- Source: **Deploy from a branch**, branch: `main`, folder: `/ (root)`
- Save. The app will be live at `https://linuxmaier.github.io/sort-dive-photos/` within a minute.

---

## Usage

### On Android
1. Open the app in Chrome and use **Add to Home Screen** to install it as a PWA.
2. After exporting a clip from the Insta360 app, use the native **Share** button and select **Sort Dive Photos** from the share sheet. Multiple clips can be shared at once — they will share tags, so group clips from the same raw footage.
3. In the app: select trip and dive, add tags, optionally attach a screenshot of the Insta360 file info page to link the raw source file.
4. Tap **Save tags**. If offline, the data is queued locally and syncs automatically when you reconnect.

### On iOS
1. Open the app in Safari and use **Add to Home Screen**.
2. After exporting, tap the share button in the Photos app → scroll to find **Sort Dive Photos** (if Web Share Target is supported) or open the app directly and tap **Add clips** to pick from your library.

### Linking to raw Insta360 footage (recommended)
For each clip, the app encourages you to attach a screenshot of the Insta360 app's file info pane. This captures the raw file name (e.g. `VID_20260130_113606_00_535`) and the original recording time, enabling you to trace any exported clip back to the raw source for re-editing. Tesseract.js reads the filename directly from the screenshot — no copy-paste required.

### Offline use
Before a trip (while online), open the app once to cache data. During the trip, everything works offline — clips are queued in your browser's IndexedDB and sync to Google Sheets when you reconnect.

---

## Google Sheet structure

| Tab | Columns |
|-----|---------|
| `trips` | trip_id, name, location, start_date, end_date |
| `dives` | dive_id, trip_id, trip_name, dive_number, site_name, date |
| `clips` | clip_id, filename, raw_file, recorded_at, trip_id, trip_name, dive_id, dive_label, tags, notes, tagged_at, tagged_by |
| `album_mapping` | tag, album_name, album_id _(for future Google Photos integration)_ |

All data is plain text — readable and editable directly in Sheets without the app.

---

## Updating tags after the fact

Open the Google Sheet and edit the `tags` column directly. The app reads tag history from the sheet, so any tags you add there will appear as autocomplete suggestions next time.
