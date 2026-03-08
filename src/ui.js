import CONFIG from '../config.js';
import { initAuth, signIn, signOut, isKnownUser, getToken, tryRefreshToken, getUserEmail } from './auth.js';
import { initSheets, loadTrips, loadDives, loadTagHistory, loadParticipantHistory, addTrip, addDive, ensureHeaders } from './sheets.js';
import { addPendingClip, getPendingClips, deletePendingClip } from './db.js';
import { syncPending, setupConnectivitySync, getPendingCount } from './sync.js';
import { extractRawFilename, isOCRAvailable } from './ocr.js';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  trips: [],
  dives: [],
  tagHistory: [],
  participantHistory: [],
  currentTrip: null,
  currentDive: null,
  pendingFiles: [],   // { file, thumbnail, rawFile, recordedAt }
  currentTags: [],
  notes: '',
};

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
}

function setStatus(msg, isError = false) {
  const el = $('status-bar');
  el.textContent = msg;
  el.className = 'status-bar' + (isError ? ' error' : '');
  if (msg) { show('status-bar'); setTimeout(() => hide('status-bar'), 4000); }
}

async function generateThumbnail(file) {
  if (file.type.startsWith('image/')) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }
  // Video: grab frame at 1s
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;
    video.currentTime = 1;
    const cleanup = () => URL.revokeObjectURL(url);
    video.addEventListener('seeked', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 135;
      canvas.getContext('2d').drawImage(video, 0, 0, 240, 135);
      cleanup();
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    });
    video.addEventListener('error', () => { cleanup(); resolve(null); });
    video.load();
  });
}

function parseFilenameDate(filename) {
  // Exported Insta360 filenames: 20260307_150828_550.mp4
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// ── Tag input ──────────────────────────────────────────────────────────────
function renderTags() {
  const container = $('tag-chips');
  container.innerHTML = '';
  state.currentTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${tag} <button aria-label="Remove ${tag}">×</button>`;
    chip.querySelector('button').onclick = () => removeTag(tag);
    container.appendChild(chip);
  });
}

function addTag(tag) {
  const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (t && !state.currentTags.includes(t)) {
    state.currentTags.push(t);
    renderTags();
    updateAutocomplete('');
    // Add to local history if new
    if (!state.tagHistory.includes(t)) state.tagHistory.unshift(t);
  }
}

function removeTag(tag) {
  state.currentTags = state.currentTags.filter(t => t !== tag);
  renderTags();
}

function updateAutocomplete(query) {
  const box = $('autocomplete');
  const q = query.toLowerCase();
  const matches = state.tagHistory
    .filter(t => !state.currentTags.includes(t) && (q === '' || t.includes(q)))
    .slice(0, 8);

  box.innerHTML = '';
  if (!matches.length) { box.classList.remove('open'); return; }
  matches.forEach(tag => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.textContent = tag;
    item.onmousedown = (e) => { e.preventDefault(); addTag(tag); $('tag-input').value = ''; };
    box.appendChild(item);
  });
  box.classList.add('open');
}

// ── File handling ──────────────────────────────────────────────────────────
async function handleFiles(files) {
  const arr = Array.from(files);
  if (!arr.length) return;

  if (arr.length > 1) show('batch-warning');
  else hide('batch-warning');

  for (const file of arr) {
    const thumbnail = await generateThumbnail(file);
    state.pendingFiles.push({ file, thumbnail, rawFile: null, recordedAt: null });
  }
  renderFilePreviews();
}

function renderFilePreviews() {
  const grid = $('file-grid');
  grid.innerHTML = '';
  state.pendingFiles.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'file-card';

    const img = document.createElement(item.file.type.startsWith('image/') ? 'img' : 'div');
    if (item.thumbnail) {
      const thumb = document.createElement('img');
      thumb.src = item.thumbnail;
      thumb.alt = item.file.name;
      card.appendChild(thumb);
    }

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.file.name;
    card.appendChild(name);

    const exportDate = parseFilenameDate(item.file.name);
    if (exportDate) {
      const date = document.createElement('div');
      date.className = 'file-meta';
      date.textContent = `Exported: ${exportDate}`;
      card.appendChild(date);
    }

    // Raw file info display
    const rawInfo = document.createElement('div');
    rawInfo.className = 'file-meta raw-info' + (item.rawFile ? ' has-data' : '');
    rawInfo.id = `raw-info-${i}`;
    rawInfo.textContent = item.rawFile
      ? `Raw: ${item.rawFile} (${item.recordedAt})`
      : 'No raw file linked';
    card.appendChild(rawInfo);

    // Screenshot upload button per file
    const screenshotLabel = document.createElement('label');
    screenshotLabel.className = 'btn btn-small btn-secondary';
    screenshotLabel.textContent = item.rawFile ? 'Re-link raw file' : '+ Link Insta360 source';
    const screenshotInput = document.createElement('input');
    screenshotInput.type = 'file';
    screenshotInput.accept = 'image/*';
    screenshotInput.className = 'hidden';
    screenshotInput.onchange = (e) => handleScreenshot(e.target.files[0], i);
    screenshotLabel.appendChild(screenshotInput);
    card.appendChild(screenshotLabel);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-small btn-ghost remove-file';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => { state.pendingFiles.splice(i, 1); renderFilePreviews(); };
    card.appendChild(removeBtn);

    grid.appendChild(card);
  });

  if (state.pendingFiles.length) show('file-grid');
  else hide('file-grid');

  updateOCRNag();
}

function updateOCRNag() {
  const unlinked = state.pendingFiles.filter(f => !f.rawFile).length;
  const nag = $('ocr-nag');
  if (unlinked > 0 && state.pendingFiles.length > 0) {
    nag.textContent = `${unlinked} clip${unlinked > 1 ? 's' : ''} not yet linked to a raw Insta360 file — this helps with archival traceability.`;
    show('ocr-nag');
  } else {
    hide('ocr-nag');
  }
}

async function handleScreenshot(file, fileIndex) {
  if (!file || !isOCRAvailable()) return;
  setStatus('Reading Insta360 file info…');
  const result = await extractRawFilename(file);
  if (!result) {
    setStatus('Could not find a VID_* filename in that screenshot. Try a cleaner crop.', true);
    return;
  }
  state.pendingFiles[fileIndex].rawFile = result.rawFile;
  state.pendingFiles[fileIndex].recordedAt = result.recordedAt;
  renderFilePreviews();
  setStatus(`Linked: ${result.rawFile}`);
}

// ── Shared files from service worker (Web Share Target) ────────────────────
async function checkForSharedFiles() {
  if (!location.search.includes('shared=true')) return;
  // Clear the query param without a reload
  history.replaceState({}, '', location.pathname);

  try {
    const cache = await caches.open('sdp-shares');
    const indexResp = await cache.match('/sdp-share-index');
    if (!indexResp) return;
    const names = await indexResp.json();
    const files = await Promise.all(names.map(async ({ name, type }) => {
      const resp = await cache.match(`/sdp-share/${encodeURIComponent(name)}`);
      if (!resp) return null;
      const blob = await resp.blob();
      return new File([blob], name, { type });
    }));
    // Clean up cache
    await cache.delete('/sdp-share-index');
    for (const { name } of names) await cache.delete(`/sdp-share/${encodeURIComponent(name)}`);

    const validFiles = files.filter(Boolean);
    if (validFiles.length) await handleFiles(validFiles);
  } catch (err) {
    console.warn('Could not read shared files:', err);
  }
}

// ── Context (trip / dive) selectors ───────────────────────────────────────
function renderTripSelect() {
  const sel = $('trip-select');
  sel.innerHTML = '<option value="">— select a trip —</option>';
  state.trips.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.trip_id;
    opt.textContent = t.name + (t.location ? ` · ${t.location}` : '');
    sel.appendChild(opt);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New trip…';
  sel.appendChild(newOpt);
}

function renderDiveSelect(tripId) {
  const sel = $('dive-select');
  sel.innerHTML = '<option value="">— select a dive —</option>';
  const dives = state.dives.filter(d => d.trip_id === tripId);
  dives.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.dive_id;
    opt.textContent = `Dive ${d.dive_number}${d.site_name ? ' — ' + d.site_name : ''}`;
    sel.appendChild(opt);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New dive…';
  sel.appendChild(newOpt);
}

function updateContextBadge() {
  const trip = state.currentTrip;
  const dive = state.currentDive;
  $('context-badge').textContent = trip
    ? `${trip.name}${dive ? ' · Dive ' + dive.dive_number : ' · no dive selected'}`
    : 'No context set';
}

// ── Queue page ─────────────────────────────────────────────────────────────
async function renderQueue() {
  const list = $('queue-list');
  list.innerHTML = '';
  const pending = await getPendingClips();
  if (!pending.length) {
    list.innerHTML = '<p class="empty-state">No pending clips.</p>';
    return;
  }
  pending.forEach(clip => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    row.innerHTML = `
      <div class="queue-filename">${clip.filename}</div>
      <div class="queue-meta">${clip.tripName} · ${clip.diveLabel} · <em>${clip.tags || 'no tags'}</em></div>
    `;
    list.appendChild(row);
  });
}

// ── Form submission ────────────────────────────────────────────────────────
async function submitTags() {
  if (!state.pendingFiles.length) { setStatus('No clips to save.', true); return; }
  if (!state.currentTrip) { setStatus('Please select a trip first.', true); return; }
  if (!state.currentDive) { setStatus('Please select a dive first.', true); return; }

  // Auto-commit any text still in the tag input so users don't have to press Enter
  const tagInput = $('tag-input');
  if (tagInput.value.trim()) {
    addTag(tagInput.value.trim());
    tagInput.value = '';
  }

  const unlinked = state.pendingFiles.filter(f => !f.rawFile).length;
  if (unlinked > 0) {
    const ok = confirm(
      `${unlinked} clip${unlinked > 1 ? 's are' : ' is'} not linked to a raw Insta360 file.\n\n` +
      `This means the recording time and source file won't be tracked. Continue anyway?`
    );
    if (!ok) return;
  }

  const email = await getUserEmail() ?? 'unknown';
  const taggedAt = new Date().toISOString();
  const clips = state.pendingFiles.map(item => ({
    id: crypto.randomUUID(),
    filename: item.file.name,
    rawFile: item.rawFile ?? '',
    recordedAt: item.recordedAt ?? '',
    tripId: state.currentTrip.trip_id,
    tripName: state.currentTrip.name,
    diveId: state.currentDive.dive_id,
    diveLabel: `Dive ${state.currentDive.dive_number}${state.currentDive.site_name ? ' — ' + state.currentDive.site_name : ''}`,
    tags: state.currentTags.join(', '),
    notes: state.notes,
    taggedAt,
    taggedBy: email,
  }));

  // Save to IndexedDB first (works offline)
  for (const clip of clips) await addPendingClip(clip);

  setStatus(`Saved ${clips.length} clip${clips.length > 1 ? 's' : ''}. Syncing…`);

  // Reset form
  state.pendingFiles = [];
  state.currentTags = [];
  state.notes = '';
  $('tag-input').value = '';
  $('notes-input').value = '';
  renderFilePreviews();
  renderTags();
  hide('file-grid');
  hide('batch-warning');

  // Attempt immediate sync
  if (navigator.onLine) {
    const result = await syncPending();
    setStatus(result.failed
      ? `Synced ${result.synced}, ${result.failed} failed — will retry when online.`
      : `Synced ${result.synced} clip${result.synced > 1 ? 's' : ''} to Google Sheets.`
    );
    await updatePendingBadge();
  }
}

async function updatePendingBadge() {
  const count = await getPendingCount();
  const badge = $('queue-badge');
  badge.textContent = count > 0 ? count : '';
  badge.classList.toggle('hidden', count === 0);
}

// ── Modal forms ────────────────────────────────────────────────────────────
let modalParticipants = [];

function closeModal() { $('modal-overlay').classList.add('hidden'); }

function showTripModal() {
  return new Promise((resolve) => {
    $('modal-title').textContent = 'New Trip';
    $('modal-body').innerHTML = `
      <div class="field">
        <label class="field-label" for="m-trip-name">Trip name *</label>
        <input type="text" id="m-trip-name" placeholder="e.g. Cozumel 2026" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label" for="m-trip-location">Location</label>
        <input type="text" id="m-trip-location" placeholder="e.g. Cozumel, Mexico" autocomplete="off">
      </div>
      <div class="flex-row">
        <div class="field">
          <label class="field-label" for="m-trip-start">Start date</label>
          <input type="date" id="m-trip-start">
        </div>
        <div class="field">
          <label class="field-label" for="m-trip-end">End date</label>
          <input type="date" id="m-trip-end">
        </div>
      </div>`;
    $('modal-overlay').classList.remove('hidden');
    $('m-trip-name').focus();

    // Enforce start ≤ end date order
    $('m-trip-start').onchange = () => { $('m-trip-end').min = $('m-trip-start').value; };
    $('m-trip-end').onchange = () => { $('m-trip-start').max = $('m-trip-end').value; };

    const done = (result) => { closeModal(); resolve(result); };
    $('modal-cancel').onclick = () => done(null);
    $('modal-overlay').onclick = (e) => { if (e.target === $('modal-overlay')) done(null); };
    $('modal-confirm').onclick = () => {
      const name = $('m-trip-name').value.trim();
      if (!name) { $('m-trip-name').focus(); return; }
      done({ name, location: $('m-trip-location').value.trim(), startDate: $('m-trip-start').value, endDate: $('m-trip-end').value });
    };
  });
}

// ── Participant chip input (used inside dive modal) ─────────────────────────
function renderParticipantChips() {
  const container = $('m-participant-chips');
  if (!container) return;
  container.innerHTML = '';
  modalParticipants.forEach(p => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${p} <button aria-label="Remove ${p}">×</button>`;
    chip.querySelector('button').onclick = () => {
      modalParticipants = modalParticipants.filter(x => x !== p);
      renderParticipantChips();
    };
    container.appendChild(chip);
  });
}

function addParticipant(name) {
  const n = name.trim();
  if (n && !modalParticipants.includes(n)) {
    modalParticipants.push(n);
    renderParticipantChips();
    updateParticipantAutocomplete('');
    if (!state.participantHistory.includes(n)) state.participantHistory.unshift(n);
  }
}

function updateParticipantAutocomplete(query) {
  const box = $('m-participant-autocomplete');
  if (!box) return;
  const q = query.toLowerCase();
  const matches = state.participantHistory
    .filter(p => !modalParticipants.includes(p) && (q === '' || p.toLowerCase().includes(q)))
    .slice(0, 6);
  box.innerHTML = '';
  if (!matches.length) { box.classList.remove('open'); return; }
  matches.forEach(p => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.textContent = p;
    item.onmousedown = (e) => { e.preventDefault(); addParticipant(p); $('m-participant-input').value = ''; };
    box.appendChild(item);
  });
  box.classList.add('open');
}

function setupParticipantInput() {
  const input = $('m-participant-input');
  if (!input) return;
  const commit = () => { if (input.value.trim()) { addParticipant(input.value.trim()); input.value = ''; return true; } return false; };
  input.oninput = () => {
    if (input.value.includes(',')) {
      input.value.split(',').slice(0, -1).forEach(p => { if (p.trim()) addParticipant(p.trim()); });
      input.value = input.value.split(',').pop();
    }
    updateParticipantAutocomplete(input.value);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } };
  input.onkeyup = (e) => { if (e.key === 'Enter') commit(); };
  input.onfocus = () => updateParticipantAutocomplete(input.value);
  input.onblur = () => setTimeout(() => { commit(); const box = $('m-participant-autocomplete'); if (box) box.classList.remove('open'); }, 150);
}

function showDiveModal() {
  return new Promise((resolve) => {
    modalParticipants = [];
    $('modal-title').textContent = 'New Dive';
    $('modal-body').innerHTML = `
      <div class="flex-row">
        <div class="field">
          <label class="field-label" for="m-dive-number">Dive #</label>
          <input type="number" id="m-dive-number" min="1" placeholder="1">
        </div>
        <div class="field">
          <label class="field-label" for="m-dive-date">Date</label>
          <input type="date" id="m-dive-date">
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="m-dive-site">Site name</label>
        <input type="text" id="m-dive-site" placeholder="e.g. Palancar Reef" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label">Participants</label>
        <div id="m-participant-chips" style="margin-bottom:8px"></div>
        <div class="tag-input-wrapper">
          <input type="text" id="m-participant-input" placeholder="Add people and press Enter…" autocomplete="off" autocorrect="off">
          <div id="m-participant-autocomplete" class="autocomplete"></div>
        </div>
      </div>`;
    $('modal-overlay').classList.remove('hidden');

    // Set date constraints and default from the current trip's date range
    const dateInput = $('m-dive-date');
    const trip = state.currentTrip;
    if (trip?.start_date) { dateInput.min = trip.start_date; dateInput.value = trip.start_date; }
    if (trip?.end_date) { dateInput.max = trip.end_date; }

    // Auto-populate dive number: count existing dives on the selected date (per-day)
    function suggestDiveNumber(date) {
      if (!date || !trip) return;
      const count = state.dives.filter(d => d.trip_id === trip.trip_id && d.date === date).length;
      $('m-dive-number').value = count + 1;
    }
    suggestDiveNumber(dateInput.value);
    dateInput.onchange = () => suggestDiveNumber(dateInput.value);

    setupParticipantInput();
    dateInput.focus();

    const done = (result) => { closeModal(); resolve(result); };
    $('modal-cancel').onclick = () => done(null);
    $('modal-overlay').onclick = (e) => { if (e.target === $('modal-overlay')) done(null); };
    $('modal-confirm').onclick = () => {
      const diveNumber = $('m-dive-number').value.trim();
      if (!diveNumber) { $('m-dive-number').focus(); return; }
      const input = $('m-participant-input');
      if (input?.value.trim()) addParticipant(input.value.trim());
      done({ diveNumber, siteName: $('m-dive-site').value.trim(), date: $('m-dive-date').value, participants: modalParticipants.join(', ') });
    };
  });
}

async function handleNewTrip() {
  const data = await showTripModal();
  if (!data) return;
  const trip = { trip_id: crypto.randomUUID(), name: data.name, location: data.location, start_date: data.startDate, end_date: data.endDate };
  try {
    await addTrip({ id: trip.trip_id, name: data.name, location: data.location, startDate: data.startDate, endDate: data.endDate });
  } catch {
    setStatus('Saved locally — will write to Sheet when online.', false);
  }
  state.trips.unshift(trip);
  renderTripSelect();
  $('trip-select').value = trip.trip_id;
  state.currentTrip = trip;
  renderDiveSelect(trip.trip_id);
  updateContextBadge();
}

async function handleNewDive() {
  if (!state.currentTrip) { setStatus('Select a trip first.', true); return; }
  const data = await showDiveModal();
  if (!data) return;
  const dive = {
    dive_id: crypto.randomUUID(),
    trip_id: state.currentTrip.trip_id,
    trip_name: state.currentTrip.name,
    dive_number: data.diveNumber,
    site_name: data.siteName,
    date: data.date,
    participants: data.participants,
  };
  try {
    await addDive(dive);
  } catch {
    setStatus('Saved locally — will write to Sheet when online.', false);
  }
  state.dives.push(dive);
  renderDiveSelect(state.currentTrip.trip_id);
  $('dive-select').value = dive.dive_id;
  state.currentDive = dive;
  updateContextBadge();
}

// ── Init ───────────────────────────────────────────────────────────────────
export async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  await initAuth(CONFIG.GOOGLE_CLIENT_ID);
  initSheets(CONFIG.SHEET_ID);

  // Auth gate: only block on whether the user has ever signed in on this device.
  // A missing/expired token is handled gracefully inside afterSignIn().
  if (!isKnownUser()) {
    showPage('page-auth');
    $('sign-in-btn').onclick = async () => {
      await signIn();
      await getUserEmail(); // persist email to localStorage
      await afterSignIn();
    };
    return;
  }
  await afterSignIn();
}

function showTokenBanner(show) {
  const banner = $('token-banner');
  if (show) {
    banner.classList.remove('hidden');
    $('token-signin-btn').onclick = async () => {
      await signIn();
      await getUserEmail();
      banner.classList.add('hidden');
      // Now that we have a token, sync anything pending and reload data
      await syncPending();
      try {
        await ensureHeaders();
        [state.trips, state.dives, state.tagHistory] = await Promise.all([
          loadTrips(), loadDives(), loadTagHistory(),
        ]);
        renderTripSelect();
      } catch {}
      await updatePendingBadge();
    };
  } else {
    banner.classList.add('hidden');
  }
}

async function afterSignIn() {
  showPage('page-tag');
  // Show stored email immediately — no network call needed
  $('user-email').textContent = localStorage.getItem('sdp_email') ?? '';

  // Try a silent token refresh. This is fast and non-blocking when online,
  // and returns null immediately when offline.
  if (navigator.onLine) await tryRefreshToken();

  // Show a persistent banner if we still have no token (e.g. mid-flight with
  // an expired token). The app is fully usable; tagging queues to IndexedDB.
  showTokenBanner(!getToken());

  // Load data (with offline fallback built into sheets.js)
  try {
    await ensureHeaders();
    [state.trips, state.dives, state.tagHistory, state.participantHistory] = await Promise.all([
      loadTrips(), loadDives(), loadTagHistory(), loadParticipantHistory(),
    ]);
  } catch (err) {
    console.warn('Failed to load from Sheets, using cache:', err);
    if (!getToken()) {
      setStatus('Using cached data — will sync when you re-authenticate.', false);
    } else {
      setStatus('Offline — using cached data.', false);
    }
  }

  renderTripSelect();
  updateContextBadge();
  await updatePendingBadge();
  await checkForSharedFiles();

  // Connectivity sync — also attempt silent token refresh when we come online
  setupConnectivitySync(async (result) => {
    await tryRefreshToken();
    showTokenBanner(!getToken());
    if (result.synced) setStatus(`Synced ${result.synced} pending clip${result.synced > 1 ? 's' : ''}.`);
    await updatePendingBadge();
  });

  bindEvents();
}

function bindEvents() {
  // Nav
  $('nav-tag').onclick = () => { showPage('page-tag'); };
  $('nav-queue').onclick = async () => { showPage('page-queue'); await renderQueue(); };

  // Sign out
  $('sign-out-btn').onclick = () => { signOut(); location.reload(); };

  // Trip/dive selectors
  $('trip-select').onchange = async (e) => {
    if (e.target.value === '__new__') { await handleNewTrip(); return; }
    state.currentTrip = state.trips.find(t => t.trip_id === e.target.value) ?? null;
    state.currentDive = null;
    if (state.currentTrip) renderDiveSelect(state.currentTrip.trip_id);
    updateContextBadge();
  };
  $('dive-select').onchange = (e) => {
    if (e.target.value === '__new__') { handleNewDive(); return; }
    state.currentDive = state.dives.find(d => d.dive_id === e.target.value) ?? null;
    updateContextBadge();
  };

  // File drop zone
  const dropZone = $('drop-zone');
  $('file-input').onchange = (e) => handleFiles(e.target.files);
  dropZone.onclick = () => $('file-input').click();
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
  dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  };

  // Tag input
  const tagInput = $('tag-input');
  tagInput.oninput = () => {
    // On mobile, comma fires as an input event rather than a keydown.
    // Split on commas immediately, commit all complete parts.
    if (tagInput.value.includes(',')) {
      const parts = tagInput.value.split(',');
      parts.slice(0, -1).forEach(t => { if (t.trim()) addTag(t.trim()); });
      tagInput.value = parts[parts.length - 1]; // keep any text after the last comma
    }
    updateAutocomplete(tagInput.value);
  };

  // Commit a tag from the input field
  function commitTagInput() {
    if (tagInput.value.trim()) {
      addTag(tagInput.value.trim());
      tagInput.value = '';
      return true;
    }
    return false;
  }

  // keydown handles physical keyboards; keyup catches mobile virtual keyboards
  // which often don't fire keydown reliably for Enter
  tagInput.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTagInput(); }
    if (e.key === 'Escape') { $('autocomplete').classList.remove('open'); }
  };
  tagInput.onkeyup = (e) => {
    if (e.key === 'Enter') commitTagInput();
  };

  tagInput.onfocus = () => updateAutocomplete(tagInput.value);
  // On blur, commit whatever is in the field (e.g. tapping away on mobile).
  // The 150ms delay is kept so autocomplete item taps still register first.
  tagInput.onblur = () => setTimeout(() => {
    commitTagInput();
    $('autocomplete').classList.remove('open');
  }, 150);

  // Notes
  $('notes-input').oninput = (e) => { state.notes = e.target.value; };

  // Submit
  $('submit-btn').onclick = submitTags;

  // Queue sync button
  $('sync-btn').onclick = async () => {
    setStatus('Syncing…');
    const result = await syncPending();
    setStatus(result.failed
      ? `Synced ${result.synced}, ${result.failed} failed.`
      : `Synced ${result.synced} clip${result.synced > 1 ? 's' : ''}.`
    );
    await updatePendingBadge();
    await renderQueue();
  };
}
