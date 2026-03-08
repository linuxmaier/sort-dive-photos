// IndexedDB wrapper for offline storage.
// Stores pending (unsynced) clips and cached data from Google Sheets.

const DB_NAME = 'sdp';
const DB_VERSION = 1;

let db = null;

export function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('pending_clips')) {
        d.createObjectStore('pending_clips', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('cache')) {
        d.createObjectStore('cache', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode, fn) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const transaction = d.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// --- Pending clips ---

export function addPendingClip(clip) {
  return tx('pending_clips', 'readwrite', s => s.put(clip));
}

export function getPendingClips() {
  return tx('pending_clips', 'readonly', s => s.getAll());
}

export function deletePendingClip(id) {
  return tx('pending_clips', 'readwrite', s => s.delete(id));
}

// --- Generic cache (trips, dives, tags) ---

export function setCacheEntry(key, data) {
  return tx('cache', 'readwrite', s => s.put({ key, data, updatedAt: Date.now() }));
}

export function getCacheEntry(key) {
  return tx('cache', 'readonly', s => s.get(key)).then(entry => entry?.data ?? null);
}
