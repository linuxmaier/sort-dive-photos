import CONFIG from '../config.js';
import { initAuth, signIn, signOut, isKnownUser, getToken, tryRefreshToken, getUserEmail } from './auth.js';
import { initSheets, loadTrips, loadDives, loadTagHistory, loadParticipantHistory, loadTagCategories, addTrip, addDive, addTagCategory, ensureHeaders, loadClips, loadAlbums, addAlbum, loadAlbumAssignments, addAlbumAssignment, createPhotosAlbum } from './sheets.js';
import { addPendingClip, getPendingClips, deletePendingClip, saveThumbnail, getThumbnail } from './db.js';
import { syncPending, setupConnectivitySync, getPendingCount } from './sync.js';
import { extractRawFilename, isOCRAvailable } from './ocr.js';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  trips: [],
  dives: [],
  tagHistory: [],
  participantHistory: [],
  tagCategories: {},   // tag → category
  categoryHistory: [], // unique categories
  currentTrip: null,
  currentDive: null,
  pendingFiles: [],   // { file, thumbnail, rawFile, recordedAt }
  currentTags: [],
  notes: '',
  albums: [],          // album objects with parsed .filters array
  albumAssignments: [], // { clip_id, album_id, added_at, added_by }
  clips: [],           // snake_case, mirrors Sheet schema
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
    const isNew = !state.tagHistory.includes(t);
    if (isNew) state.tagHistory.unshift(t);
    // Prompt for a category only if this tag has never been categorised before
    if (isNew && !state.tagCategories[t]) showCategoryPicker(t);
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

// ── Category picker ────────────────────────────────────────────────────────
let pickerTag = null;

function showCategoryPicker(tag) {
  pickerTag = tag;
  $('category-picker-tag').textContent = tag;

  const list = $('category-chips-list');
  list.innerHTML = '';
  state.categoryHistory.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small btn-secondary';
    btn.textContent = cat;
    btn.onmousedown = (e) => { e.preventDefault(); assignCategory(tag, cat); };
    list.appendChild(btn);
  });

  $('category-input').value = '';
  $('category-picker').classList.remove('hidden');
}

function hideCategoryPicker() {
  $('category-picker').classList.add('hidden');
  $('category-autocomplete').classList.remove('open');
  pickerTag = null;
}

async function assignCategory(tag, category) {
  const cat = category.trim();
  if (!cat) { hideCategoryPicker(); return; }
  state.tagCategories[tag] = cat;
  if (!state.categoryHistory.includes(cat)) state.categoryHistory.push(cat);
  hideCategoryPicker();
  try { await addTagCategory(tag, cat); } catch { /* offline — local state updated, sheet write skipped */ }
}

function updateCategoryAutocomplete(query) {
  const box = $('category-autocomplete');
  const q = query.toLowerCase();
  const matches = state.categoryHistory.filter(c => q === '' || c.toLowerCase().includes(q)).slice(0, 6);
  box.innerHTML = '';
  if (!matches.length) { box.classList.remove('open'); return; }
  matches.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.textContent = cat;
    item.onmousedown = (e) => { e.preventDefault(); assignCategory(pickerTag, cat); };
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

  // Persist thumbnails for the Albums detail view
  for (let i = 0; i < clips.length; i++) {
    const thumb = state.pendingFiles[i]?.thumbnail;
    if (thumb) { try { await saveThumbnail(clips[i].id, thumb); } catch { /* non-critical */ } }
  }

  // Push normalized clips to state.clips for immediate album matching
  state.clips.push(...clips.map(c => ({
    clip_id: c.id, filename: c.filename, raw_file: c.rawFile,
    recorded_at: c.recordedAt, trip_id: c.tripId, trip_name: c.tripName,
    dive_id: c.diveId, dive_label: c.diveLabel, tags: c.tags,
    notes: c.notes, tagged_at: c.taggedAt, tagged_by: c.taggedBy,
  })));
  updateAlbumsBadge();

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

function resetModal() {
  $('modal-confirm').classList.remove('hidden');
  $('modal-confirm').textContent = 'Save';
  $('modal-cancel').textContent = 'Cancel';
  $('modal-footer').classList.remove('hidden');
}

function showTripModal() {
  return new Promise((resolve) => {
    resetModal();
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
    resetModal();
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

// ── Albums ─────────────────────────────────────────────────────────────────

function clipMatchesFilters(clip, filters) {
  if (!filters || !filters.length) return true;
  return filters.every(f => {
    const vals = f.values ?? [];
    if (!vals.length) return true;
    switch (f.type) {
      case 'trip': return vals.some(v => v === clip.trip_id);
      case 'dive': return vals.some(v => v === clip.dive_id);
      case 'tag': {
        const clipTags = (clip.tags ?? '').split(',').map(t => t.trim()).filter(Boolean);
        return vals.some(v => clipTags.includes(v));
      }
      case 'participant': {
        const dive = state.dives.find(d => d.dive_id === clip.dive_id);
        if (!dive) return false;
        const parts = (dive.participants ?? '').split(',').map(p => p.trim()).filter(Boolean);
        return vals.some(v => parts.includes(v));
      }
      default: return false;
    }
  });
}

function updateAlbumsBadge() {
  const assignedSet = new Set(state.albumAssignments.map(a => `${a.clip_id}:${a.album_id}`));
  let pending = 0;
  for (const album of state.albums) {
    for (const clip of state.clips) {
      if (clipMatchesFilters(clip, album.filters) && !assignedSet.has(`${clip.clip_id}:${album.album_id}`)) pending++;
    }
  }
  const badge = $('albums-badge');
  badge.textContent = pending > 0 ? pending : '';
  badge.classList.toggle('hidden', pending === 0);
}

function renderAlbumsList() {
  const assignedSet = new Set(state.albumAssignments.map(a => `${a.clip_id}:${a.album_id}`));

  // Suggested: trips with clips but no trip-only album
  const tripsWithClips = [...new Set(state.clips.map(c => c.trip_id))];
  const coveredTripIds = new Set(
    state.albums
      .filter(a => a.filters?.length === 1 && a.filters[0].type === 'trip' && a.filters[0].values?.length === 1)
      .map(a => a.filters[0].values[0])
  );
  const suggestedTrips = tripsWithClips
    .filter(tid => !coveredTripIds.has(tid))
    .map(tid => state.trips.find(t => t.trip_id === tid))
    .filter(Boolean);

  const suggestedEl = $('albums-suggested');
  suggestedEl.innerHTML = '';
  if (suggestedTrips.length) {
    const label = document.createElement('div');
    label.className = 'albums-section-label';
    label.textContent = 'Suggested';
    suggestedEl.appendChild(label);
    suggestedTrips.forEach(trip => {
      const count = state.clips.filter(c => c.trip_id === trip.trip_id).length;
      const card = document.createElement('div');
      card.className = 'album-card suggested';
      card.innerHTML = `
        <div class="album-card-name">${trip.name} — All clips</div>
        <div class="album-card-meta">${count} clip${count !== 1 ? 's' : ''} · suggested trip album</div>
      `;
      card.onclick = () => openAlbumCreationModal({
        name: `${trip.name} — All clips`,
        presetFilter: { type: 'trip', values: [trip.trip_id] },
      });
      suggestedEl.appendChild(card);
    });
  }

  const listEl = $('albums-list');
  listEl.innerHTML = '';
  if (!state.albums.length) {
    if (!suggestedTrips.length) {
      listEl.innerHTML = '<p class="empty-state">No albums yet. Tap + New album to create one.</p>';
    }
    return;
  }
  if (suggestedTrips.length) {
    const label = document.createElement('div');
    label.className = 'albums-section-label';
    label.textContent = 'Your albums';
    listEl.appendChild(label);
  }
  state.albums.forEach(album => {
    const matching = state.clips.filter(c => clipMatchesFilters(c, album.filters));
    const pending = matching.filter(c => !assignedSet.has(`${c.clip_id}:${album.album_id}`)).length;
    const card = document.createElement('div');
    card.className = 'album-card';
    const pendingHtml = pending > 0 ? ` · <span class="album-card-pending">${pending} pending</span>` : ' · all added';
    card.innerHTML = `
      <div class="album-card-name">${album.name}</div>
      <div class="album-card-meta">${matching.length} clip${matching.length !== 1 ? 's' : ''}${pendingHtml}</div>
      ${album.photos_product_url ? `<a class="album-card-link" href="${album.photos_product_url}" target="_blank" rel="noopener">Open in Google Photos ↗</a>` : ''}
    `;
    card.querySelector('a')?.addEventListener('click', e => e.stopPropagation());
    card.onclick = () => showAlbumDetail(album);
    listEl.appendChild(card);
  });
}

function showAlbumDetail(album) {
  hide('albums-list-view');
  show('albums-detail-view');

  $('albums-detail-name').textContent = album.name;

  const assignedSet = new Set(
    state.albumAssignments.filter(a => a.album_id === album.album_id).map(a => a.clip_id)
  );
  const matching = state.clips.filter(c => clipMatchesFilters(c, album.filters));
  const pending = matching.filter(c => !assignedSet.has(c.clip_id)).length;

  $('albums-detail-meta').textContent = `${pending} pending · ${matching.length} total${album.photos_product_url ? '' : ''}`;
  if (album.photos_product_url) {
    const link = document.createElement('a');
    link.href = album.photos_product_url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.cssText = 'color:var(--primary);font-size:13px;margin-left:8px';
    link.textContent = 'Open in Photos ↗';
    $('albums-detail-meta').appendChild(link);
  }

  $('albums-mark-all-btn').onclick = () => markAllAdded(album, matching, assignedSet);

  const grid = $('albums-detail-grid');
  grid.innerHTML = '';
  matching.forEach(clip => {
    const isAdded = assignedSet.has(clip.clip_id);
    const thumb = document.createElement('div');
    thumb.className = 'album-clip-thumb' + (isAdded ? ' added' : '');
    const img = document.createElement('img');
    img.alt = clip.filename;
    img.style.aspectRatio = '16/9';
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = clip.filename;
    thumb.appendChild(img);
    thumb.appendChild(label);
    getThumbnail(clip.clip_id).then(dataUrl => { if (dataUrl) img.src = dataUrl; else img.style.display = 'none'; });
    if (!isAdded) thumb.onclick = () => showClipAlbumsModal(clip);
    grid.appendChild(thumb);
  });
}

function backToAlbumsList() {
  hide('albums-detail-view');
  show('albums-list-view');
  renderAlbumsList();
}

function showClipAlbumsModal(clip) {
  const assignedIds = new Set(
    state.albumAssignments.filter(a => a.clip_id === clip.clip_id).map(a => a.album_id)
  );
  const pendingAlbums = state.albums.filter(a =>
    clipMatchesFilters(clip, a.filters) && !assignedIds.has(a.album_id)
  );

  resetModal();
  $('modal-title').textContent = clip.filename;
  $('modal-confirm').classList.add('hidden');
  $('modal-cancel').textContent = 'Close';

  const body = $('modal-body');
  body.innerHTML = '';

  if (!pendingAlbums.length) {
    body.innerHTML = '<p style="color:var(--text-dim);font-size:13px">This clip has been added to all matching albums.</p>';
  } else {
    const intro = document.createElement('div');
    intro.className = 'field-label';
    intro.style.marginBottom = '8px';
    intro.textContent = 'Still needs to be added to:';
    body.appendChild(intro);
    pendingAlbums.forEach(album => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';
      const nameEl = document.createElement('span');
      nameEl.textContent = album.name;
      const markBtn = document.createElement('button');
      markBtn.className = 'btn btn-small btn-secondary';
      markBtn.textContent = 'Mark added';
      markBtn.onclick = async () => {
        await markClipAdded(clip, album);
        markBtn.textContent = 'Done ✓';
        markBtn.disabled = true;
        markBtn.className = 'btn btn-small btn-ghost';
      };
      row.appendChild(nameEl);
      row.appendChild(markBtn);
      body.appendChild(row);
    });
  }

  const close = () => { closeModal(); resetModal(); };
  $('modal-cancel').onclick = close;
  $('modal-overlay').onclick = (e) => { if (e.target === $('modal-overlay')) close(); };
  $('modal-overlay').classList.remove('hidden');
}

async function markClipAdded(clip, album) {
  const email = localStorage.getItem('sdp_email') ?? 'unknown';
  const assignment = {
    clip_id: clip.clip_id,
    album_id: album.album_id,
    added_at: new Date().toISOString(),
    added_by: email,
  };
  state.albumAssignments.push(assignment);
  updateAlbumsBadge();
  try { await addAlbumAssignment(assignment); } catch { /* offline — will need to re-mark */ }
}

async function markAllAdded(album, clips, assignedSet) {
  const unassigned = clips.filter(c => !assignedSet.has(c.clip_id));
  if (!unassigned.length) { setStatus('All clips already marked.'); return; }
  for (const clip of unassigned) await markClipAdded(clip, album);
  setStatus(`Marked ${unassigned.length} clip${unassigned.length !== 1 ? 's' : ''} as added.`);
  showAlbumDetail(album);
}

// ── Album creation modal ────────────────────────────────────────────────────
let albumModalFilters = [];

function openAlbumCreationModal(opts = {}) {
  resetModal();
  albumModalFilters = opts.presetFilter ? [{ ...opts.presetFilter }] : [];
  $('modal-title').textContent = 'New Album';
  $('modal-confirm').textContent = 'Create';
  $('modal-body').innerHTML = `
    <div class="field">
      <label class="field-label" for="m-album-name">Album name *</label>
      <input type="text" id="m-album-name" placeholder="e.g. Cozumel 2026 — Sharks" autocomplete="off">
    </div>
    <div class="field">
      <div class="section-label" style="margin-bottom:6px">Filters</div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">AND between filter types · OR within a type</div>
      <div id="m-filter-rows" style="display:flex;flex-direction:column;gap:8px"></div>
      <button type="button" id="m-add-filter" class="btn btn-small btn-ghost" style="margin-top:8px">+ Add filter</button>
    </div>
    <div id="m-album-preview" class="album-preview-count"></div>
    <label class="album-photos-checkbox">
      <input type="checkbox" id="m-create-photos-album">
      Create album in Google Photos
    </label>
  `;
  if (opts.name) $('m-album-name').value = opts.name;

  renderFilterRows();
  updateAlbumPreview();

  $('m-add-filter').onclick = () => {
    albumModalFilters.push({ type: 'tag', values: [] });
    renderFilterRows();
    updateAlbumPreview();
  };

  $('modal-overlay').classList.remove('hidden');
  $('m-album-name').focus();

  const done = () => { closeModal(); resetModal(); };
  $('modal-cancel').onclick = done;
  $('modal-overlay').onclick = (e) => { if (e.target === $('modal-overlay')) done(); };
  $('modal-confirm').onclick = () => saveNewAlbum();
}

function renderFilterRows() {
  const container = $('m-filter-rows');
  container.innerHTML = '';
  albumModalFilters.forEach((filter, idx) => {
    const row = document.createElement('div');
    row.className = 'filter-row';

    const typeSelect = document.createElement('select');
    ['trip', 'dive', 'tag', 'participant'].forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      if (filter.type === type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.onchange = () => {
      albumModalFilters[idx] = { type: typeSelect.value, values: [] };
      renderFilterRows();
      updateAlbumPreview();
    };
    row.appendChild(typeSelect);

    const valueWrapper = document.createElement('div');
    valueWrapper.className = 'filter-value-wrapper';

    if (filter.type === 'trip' || filter.type === 'dive') {
      const sel = document.createElement('select');
      const items = filter.type === 'trip' ? state.trips : state.dives;
      sel.innerHTML = `<option value="">— select ${filter.type} —</option>`;
      items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = filter.type === 'trip' ? item.trip_id : item.dive_id;
        opt.textContent = filter.type === 'trip'
          ? item.name
          : `Dive ${item.dive_number}${item.site_name ? ' — ' + item.site_name : ''} (${item.trip_name ?? ''})`;
        if (filter.values[0] === opt.value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => { albumModalFilters[idx].values = sel.value ? [sel.value] : []; updateAlbumPreview(); };
      valueWrapper.appendChild(sel);
    } else {
      // Tag or Participant: chip input with autocomplete
      const history = filter.type === 'tag' ? state.tagHistory : state.participantHistory;
      const chipsEl = document.createElement('div');
      chipsEl.className = 'filter-chips';

      const renderChips = () => {
        chipsEl.innerHTML = '';
        albumModalFilters[idx].values.forEach(val => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.innerHTML = `${val} <button aria-label="Remove ${val}">×</button>`;
          chip.querySelector('button').onclick = () => {
            albumModalFilters[idx].values = albumModalFilters[idx].values.filter(v => v !== val);
            renderChips();
            updateAlbumPreview();
          };
          chipsEl.appendChild(chip);
        });
      };
      renderChips();

      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'tag-input-wrapper';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = `Add ${filter.type}…`;
      input.autocomplete = 'off';
      const acBox = document.createElement('div');
      acBox.className = 'filter-autocomplete';

      const addVal = (v) => {
        const trimmed = v.trim();
        if (trimmed && !albumModalFilters[idx].values.includes(trimmed)) {
          albumModalFilters[idx].values.push(trimmed);
          renderChips();
          updateAlbumPreview();
        }
        input.value = '';
        acBox.classList.remove('open');
      };
      const updateAC = (q) => {
        const matches = history.filter(h => !albumModalFilters[idx].values.includes(h) && (q === '' || h.includes(q))).slice(0, 6);
        acBox.innerHTML = '';
        if (!matches.length) { acBox.classList.remove('open'); return; }
        matches.forEach(m => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          item.textContent = m;
          item.onmousedown = (e) => { e.preventDefault(); addVal(m); };
          acBox.appendChild(item);
        });
        acBox.classList.add('open');
      };
      input.oninput = () => {
        if (input.value.includes(',')) {
          input.value.split(',').slice(0, -1).forEach(v => { if (v.trim()) addVal(v.trim()); });
          input.value = input.value.split(',').pop();
        }
        updateAC(input.value);
      };
      input.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.value.trim()) addVal(input.value.trim()); } };
      input.onfocus = () => updateAC(input.value);
      input.onblur = () => setTimeout(() => { if (input.value.trim()) addVal(input.value.trim()); acBox.classList.remove('open'); }, 150);

      inputWrapper.appendChild(input);
      inputWrapper.appendChild(acBox);
      valueWrapper.appendChild(chipsEl);
      valueWrapper.appendChild(inputWrapper);
    }
    row.appendChild(valueWrapper);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-small btn-ghost';
    removeBtn.textContent = '✕';
    removeBtn.style.flexShrink = '0';
    removeBtn.onclick = () => { albumModalFilters.splice(idx, 1); renderFilterRows(); updateAlbumPreview(); };
    row.appendChild(removeBtn);

    container.appendChild(row);
  });
}

function updateAlbumPreview() {
  const el = $('m-album-preview');
  if (!el) return;
  const active = albumModalFilters.filter(f => f.values.length > 0);
  const count = state.clips.filter(c => clipMatchesFilters(c, active)).length;
  el.textContent = active.length ? `${count} clip${count !== 1 ? 's' : ''} match these filters` : '';
}

async function saveNewAlbum() {
  const name = $('m-album-name')?.value.trim();
  if (!name) { $('m-album-name').focus(); return; }

  const filters = albumModalFilters.filter(f => f.values.length > 0);
  const createInPhotos = $('m-create-photos-album')?.checked;

  let photosAlbumId = '';
  let photosProductUrl = '';
  if (createInPhotos) {
    try {
      const result = await createPhotosAlbum(name);
      photosAlbumId = result.id;
      photosProductUrl = result.productUrl;
    } catch {
      setStatus('Could not create Google Photos album. Re-authenticate and ensure Photos access is granted.', true);
      return;
    }
  }

  const email = localStorage.getItem('sdp_email') ?? 'unknown';
  const album = {
    album_id: crypto.randomUUID(),
    name,
    filters,
    filters_json: JSON.stringify(filters),
    photos_album_id: photosAlbumId,
    photos_product_url: photosProductUrl,
    created_at: new Date().toISOString(),
    created_by: email,
  };

  state.albums.push(album);
  closeModal();
  resetModal();
  updateAlbumsBadge();
  renderAlbumsList();

  try { await addAlbum(album); } catch { setStatus('Album saved locally — will sync when online.', false); }
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
        [state.trips, state.dives, state.tagHistory, state.tagCategories,
         state.albums, state.albumAssignments, state.clips] = await Promise.all([
          loadTrips(), loadDives(), loadTagHistory(), loadTagCategories(),
          loadAlbums(), loadAlbumAssignments(), loadClips(),
        ]);
        state.categoryHistory = [...new Set(Object.values(state.tagCategories).filter(Boolean))];
        updateAlbumsBadge();
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
    [state.trips, state.dives, state.tagHistory, state.participantHistory, state.tagCategories,
     state.albums, state.albumAssignments, state.clips] = await Promise.all([
      loadTrips(), loadDives(), loadTagHistory(), loadParticipantHistory(), loadTagCategories(),
      loadAlbums(), loadAlbumAssignments(), loadClips(),
    ]);
    state.categoryHistory = [...new Set(Object.values(state.tagCategories).filter(Boolean))];
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
  updateAlbumsBadge();
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

function setNavActive(id) {
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
  $(id).classList.add('active');
}

function bindEvents() {
  // Nav
  $('nav-tag').onclick = () => { showPage('page-tag'); setNavActive('nav-tag'); };
  $('nav-albums').onclick = () => {
    showPage('page-albums');
    setNavActive('nav-albums');
    show('albums-list-view');
    hide('albums-detail-view');
    renderAlbumsList();
  };
  $('nav-queue').onclick = async () => { showPage('page-queue'); setNavActive('nav-queue'); await renderQueue(); };

  // Albums page
  $('albums-back-btn').onclick = backToAlbumsList;
  $('album-create-btn').onclick = () => openAlbumCreationModal();

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

  tagInput.onfocus = () => { hideCategoryPicker(); updateAutocomplete(tagInput.value); };
  // On blur, commit whatever is in the field (e.g. tapping away on mobile).
  // The 150ms delay is kept so autocomplete item taps still register first.
  tagInput.onblur = () => setTimeout(() => {
    commitTagInput();
    $('autocomplete').classList.remove('open');
  }, 150);

  // Category picker
  const categoryInput = $('category-input');
  categoryInput.oninput = () => updateCategoryAutocomplete(categoryInput.value);
  categoryInput.onfocus = () => updateCategoryAutocomplete(categoryInput.value);
  categoryInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); assignCategory(pickerTag, categoryInput.value); }
    if (e.key === 'Escape') hideCategoryPicker();
  };
  categoryInput.onblur = () => setTimeout(() => $('category-autocomplete').classList.remove('open'), 150);
  $('category-skip').onclick = hideCategoryPicker;

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
