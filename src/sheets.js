// Google Sheets API wrapper using direct REST calls.
// All reads fall back to IndexedDB cache when offline.

import { getToken, tryRefreshToken } from './auth.js';
import { setCacheEntry, getCacheEntry } from './db.js';

let SHEET_ID = null;

export function initSheets(sheetId) {
  SHEET_ID = sheetId;
}

async function authFetch(url, options = {}) {
  let token = getToken();
  if (!token) {
    // Never show an interactive prompt from API code — just throw so callers
    // can fall back to cache or queue. tryRefreshToken() is silent and fast.
    if (!navigator.onLine) throw new Error('offline');
    token = await tryRefreshToken();
    if (!token) throw new Error('no valid token');
  }
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error ${res.status}: ${err}`);
  }
  return res.json();
}

function rangeUrl(range) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
}

async function getValues(range) {
  const data = await authFetch(rangeUrl(range));
  return data.values ?? [];
}

async function appendValues(range, rows) {
  return authFetch(
    `${rangeUrl(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
}

// Parse a sheet (array of arrays, first row = headers) into objects
function toObjects(rows) {
  if (rows.length < 2) return [];
  const [headers, ...data] = rows;
  return data.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])));
}

// --- Trips ---

export async function loadTrips() {
  try {
    const rows = await getValues('trips!A:E');
    const trips = toObjects(rows);
    await setCacheEntry('trips', trips);
    return trips;
  } catch {
    return (await getCacheEntry('trips')) ?? [];
  }
}

export async function addTrip({ id, name, location, startDate, endDate }) {
  return appendValues('trips!A:E', [[id, name, location, startDate, endDate]]);
}

// --- Dives ---

export async function loadDives() {
  try {
    const rows = await getValues('dives!A:G');
    const dives = toObjects(rows);
    await setCacheEntry('dives', dives);
    return dives;
  } catch {
    return (await getCacheEntry('dives')) ?? [];
  }
}

export async function addDive(dive) {
  return appendValues('dives!A:G', [[
    dive.dive_id, dive.trip_id, dive.trip_name, dive.dive_number, dive.site_name, dive.date, dive.participants ?? '',
  ]]);
}

export async function loadParticipantHistory() {
  try {
    const rows = await getValues('dives!G:G'); // participants column
    const participants = rows.slice(1)
      .flatMap(r => (r[0] ?? '').split(',').map(p => p.trim()).filter(Boolean));
    const unique = [...new Set(participants)];
    await setCacheEntry('participant_history', unique);
    return unique;
  } catch {
    return (await getCacheEntry('participant_history')) ?? [];
  }
}

// --- Tag history ---
// Derived by reading all tags from the clips sheet — no separate tab needed.

export async function loadTagHistory() {
  try {
    const rows = await getValues('clips!I:I'); // tags column
    const tags = rows.slice(1) // skip header
      .flatMap(r => (r[0] ?? '').split(',').map(t => t.trim()).filter(Boolean));
    const unique = [...new Set(tags)];
    await setCacheEntry('tag_history', unique);
    return unique;
  } catch {
    return (await getCacheEntry('tag_history')) ?? [];
  }
}

// --- Clips ---

export async function addClip(clip) {
  const row = [
    clip.id,
    clip.filename,
    clip.rawFile ?? '',
    clip.recordedAt ?? '',
    clip.tripId,
    clip.tripName,
    clip.diveId,
    clip.diveLabel,
    clip.tags,
    clip.notes ?? '',
    clip.taggedAt,
    clip.taggedBy,
  ];
  return appendValues('clips!A:L', [row]);
}

// --- Clips ---

export async function loadClips() {
  try {
    const rows = await getValues('clips!A:L');
    const clips = toObjects(rows);
    await setCacheEntry('clips', clips);
    return clips;
  } catch {
    return (await getCacheEntry('clips')) ?? [];
  }
}

// --- Albums ---

export async function loadAlbums() {
  const parse = (json) => { try { return JSON.parse(json || '[]'); } catch { return []; } };
  try {
    const rows = await getValues('albums!A:G');
    const albums = toObjects(rows).map(a => ({ ...a, filters: parse(a.filters_json) }));
    await setCacheEntry('albums', albums);
    return albums;
  } catch {
    const cached = (await getCacheEntry('albums')) ?? [];
    return cached.map(a => ({ ...a, filters: a.filters ?? parse(a.filters_json) }));
  }
}

export async function addAlbum(album) {
  return appendValues('albums!A:G', [[
    album.album_id, album.name, JSON.stringify(album.filters ?? []),
    album.photos_album_id ?? '', album.photos_product_url ?? '',
    album.created_at, album.created_by,
  ]]);
}

// --- Album assignments ---

export async function loadAlbumAssignments() {
  try {
    const rows = await getValues('album_assignments!A:D');
    const assignments = toObjects(rows);
    await setCacheEntry('album_assignments', assignments);
    return assignments;
  } catch {
    return (await getCacheEntry('album_assignments')) ?? [];
  }
}

export async function addAlbumAssignment(assignment) {
  return appendValues('album_assignments!A:D', [[
    assignment.clip_id, assignment.album_id, assignment.added_at, assignment.added_by,
  ]]);
}

// --- Google Photos ---

export async function createPhotosAlbum(name) {
  const data = await authFetch('https://photoslibrary.googleapis.com/v1/albums', {
    method: 'POST',
    body: JSON.stringify({ album: { title: name } }),
  });
  return { id: data.id ?? '', productUrl: data.productUrl ?? '' };
}

// --- Tag categories ---

export async function loadTagCategories() {
  try {
    const rows = await getValues('tag_categories!A:B');
    const items = toObjects(rows); // [{tag, category}, ...]
    const map = Object.fromEntries(items.map(c => [c.tag, c.category]).filter(([t]) => t));
    await setCacheEntry('tag_categories', map);
    return map;
  } catch {
    return (await getCacheEntry('tag_categories')) ?? {};
  }
}

export async function addTagCategory(tag, category) {
  return appendValues('tag_categories!A:B', [[tag, category]]);
}

// --- Sheet initialisation (creates headers if sheets are empty) ---

export async function ensureHeaders() {
  const checks = [
    { range: 'trips!A1:E1', values: [['trip_id', 'name', 'location', 'start_date', 'end_date']] },
    { range: 'dives!A1:G1', values: [['dive_id', 'trip_id', 'trip_name', 'dive_number', 'site_name', 'date', 'participants']] },
    { range: 'clips!A1:L1', values: [['clip_id', 'filename', 'raw_file', 'recorded_at', 'trip_id', 'trip_name', 'dive_id', 'dive_label', 'tags', 'notes', 'tagged_at', 'tagged_by']] },
    { range: 'album_mapping!A1:C1', values: [['tag', 'album_name', 'album_id']] },
    { range: 'tag_categories!A1:B1', values: [['tag', 'category']] },
    { range: 'albums!A1:G1', values: [['album_id', 'name', 'filters_json', 'photos_album_id', 'photos_product_url', 'created_at', 'created_by']] },
    { range: 'album_assignments!A1:D1', values: [['clip_id', 'album_id', 'added_at', 'added_by']] },
  ];

  for (const { range, values } of checks) {
    const tabName = range.split('!')[0];
    try {
      const existing = await getValues(range);
      if (!existing.length || !existing[0].length) {
        await authFetch(
          `${rangeUrl(range)}?valueInputOption=USER_ENTERED`,
          { method: 'PUT', body: JSON.stringify({ values }) }
        );
      }
    } catch {
      // Tab likely doesn't exist yet — create it, then write headers
      try {
        await authFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
          { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }) }
        );
        await authFetch(
          `${rangeUrl(range)}?valueInputOption=USER_ENTERED`,
          { method: 'PUT', body: JSON.stringify({ values }) }
        );
      } catch {
        // Already exists or insufficient permissions — not fatal, continue
        console.warn(`ensureHeaders: could not initialize tab "${tabName}"`);
      }
    }
  }
}
