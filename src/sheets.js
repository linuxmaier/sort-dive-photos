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

// --- Sheet initialisation (creates headers if sheets are empty) ---

export async function ensureHeaders() {
  const checks = [
    { range: 'trips!A1:E1', values: [['trip_id', 'name', 'location', 'start_date', 'end_date']] },
    { range: 'dives!A1:G1', values: [['dive_id', 'trip_id', 'trip_name', 'dive_number', 'site_name', 'date', 'participants']] },
    { range: 'clips!A1:L1', values: [['clip_id', 'filename', 'raw_file', 'recorded_at', 'trip_id', 'trip_name', 'dive_id', 'dive_label', 'tags', 'notes', 'tagged_at', 'tagged_by']] },
    { range: 'album_mapping!A1:C1', values: [['tag', 'album_name', 'album_id']] },
  ];

  for (const { range, values } of checks) {
    const existing = await getValues(range);
    if (!existing.length || !existing[0].length) {
      await authFetch(
        `${rangeUrl(range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values }) }
      );
    }
  }
}
