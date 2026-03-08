// Syncs pending clips from IndexedDB to Google Sheets when online.

import { getPendingClips, deletePendingClip } from './db.js';
import { addClip } from './sheets.js';

let syncing = false;

export async function syncPending() {
  if (syncing || !navigator.onLine) return { synced: 0, failed: 0 };
  syncing = true;
  let synced = 0;
  let failed = 0;

  try {
    const pending = await getPendingClips();
    for (const clip of pending) {
      try {
        await addClip(clip);
        await deletePendingClip(clip.id);
        synced++;
      } catch (err) {
        console.warn('Failed to sync clip', clip.id, err);
        failed++;
      }
    }
  } finally {
    syncing = false;
  }

  return { synced, failed };
}

export function setupConnectivitySync(onComplete) {
  window.addEventListener('online', async () => {
    const result = await syncPending();
    if (onComplete) onComplete(result);
  });
}

export async function getPendingCount() {
  const pending = await getPendingClips();
  return pending.length;
}
