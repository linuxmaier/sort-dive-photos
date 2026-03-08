# Sort Dive Photos

A PWA for tagging and organizing Insta360 scuba diving footage. Works offline (useful for editing on the plane home). Steady-state data lives in Google Sheets — the app is just a helper.

**Live app:** https://linuxmaier.github.io/sort-dive-photos/

---

## Setup (one-time, ~20 minutes)

### 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet (name it anything you like).
2. Create four tabs named exactly:
   - `trips`
   - `dives`
   - `clips`
   - `album_mapping`
3. The app will write the header rows automatically on first use.
4. Share the sheet with all team members (Editor access).
5. Copy the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`

### 2. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project (name it anything, e.g. "Sort Dive Photos").
3. A billing account is required — add a card, but you will not be charged. All APIs used here are free at this scale.

### 3. Enable APIs

In the Google Cloud Console for your project, enable:
- **Google Sheets API**
- **Google People API** (for user email display)

### 4. Create OAuth credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
2. Application type: **Web application**.
3. Add to **Authorized JavaScript origins**:
   - `https://linuxmaier.github.io`
   - `http://localhost` (for local testing)
4. Click Create and copy the **Client ID** (ends in `.apps.googleusercontent.com`).
5. Go to **APIs & Services → OAuth consent screen**. Set User Type to **External**. Fill in an app name. Under **Test users**, add the Google account of every person who will use the app — they cannot sign in until listed here.

### 5. Configure the app

`config.js` is committed to the repo with the shared credentials. If the credentials ever need to change, update it and commit. To check the current values:

```bash
cat config.js
```

### 6. Enable GitHub Pages

In the repo settings on GitHub:
- Go to **Settings → Pages**
- Source: **Deploy from a branch**, branch: `main`, folder: `/ (root)`
- The app will be live at `https://linuxmaier.github.io/sort-dive-photos/` within a minute.

---

## Usage

### On Android
1. Open the app in Chrome and use **Add to Home Screen** to install it as a PWA.
2. After exporting a clip from the Insta360 app, use the native **Share** button and select **Sort Dive Photos**. Multiple clips can be shared at once — they will share all tags, so only group clips from the same raw footage segment.
3. In the app: select a trip and dive (create new ones if needed), add tags, and tap **Save tags**.
4. If offline, data is queued locally and syncs automatically when you reconnect.

### On iOS
1. Open the app in Safari and use **Add to Home Screen**.
2. After exporting, tap the share button in the Photos app and select **Sort Dive Photos**, or open the app directly and tap the clip area to pick files from your library.

### Setting up trips and dives
- Tap the trip dropdown and select **+ New trip…** to open a form with name, location, and date fields.
- Once a trip is selected, tap the dive dropdown and select **+ New dive…** to add a dive with site name, date, and participants.
- Participant names autocomplete from previous dives and are stored on the dive record in the Sheet.

### Linking to raw Insta360 footage (strongly recommended)
For each clip, tap **+ Link Insta360 source** and take a screenshot of the Insta360 app's file info pane showing the raw filename (e.g. `VID_20260130_113606_00_535`). The app reads the filename using on-device OCR — no copy-paste required. This links the exported clip back to its raw source for future re-editing and records the original recording time.

### Offline use
Open the app once while online before a trip to cache trips, dives, and tag history. Everything then works offline — clips queue to IndexedDB and sync to the Sheet when you reconnect. If your session token expires mid-trip, an amber banner will appear; tagging continues to work normally and will sync once you re-authenticate.

---

## Google Sheet structure

| Tab | Columns |
|-----|---------|
| `trips` | trip_id, name, location, start_date, end_date |
| `dives` | dive_id, trip_id, trip_name, dive_number, site_name, date, participants |
| `clips` | clip_id, filename, raw_file, recorded_at, trip_id, trip_name, dive_id, dive_label, tags, notes, tagged_at, tagged_by |
| `album_mapping` | tag, album_name, album_id _(reserved for future album integration)_ |

All data is plain text — readable and editable directly in Sheets without the app.

---

## Editing data after the fact

All Sheet data can be edited directly in Google Sheets:
- **Tags**: edit the `tags` cell for any clip; changes appear as autocomplete suggestions in the app on next load
- **Participants**: edit the `participants` cell on any dive row
- **Dive/trip details**: edit any field directly

---

## Open issues

See [GitHub Issues](https://github.com/linuxmaier/sort-dive-photos/issues) for known limitations and planned features, including the album/folder organization workflow (#5).
