// Tesseract.js OCR for extracting the Insta360 raw filename from a screenshot.
// Expects the global Tesseract object loaded via CDN.

// Matches: VID_20260130_113606_00_535 (with optional .insv extension)
const RAW_FILENAME_RE = /VID_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d{2}_\d{3}/i;

let worker = null;

async function getWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker('eng');
  return worker;
}

/**
 * Run OCR on an image file and extract the Insta360 raw filename.
 * Returns { rawFile, recordedAt } on success, or null if no match found.
 */
export async function extractRawFilename(imageFile) {
  const w = await getWorker();
  const url = URL.createObjectURL(imageFile);
  try {
    const { data } = await w.recognize(url);
    const text = data.text;
    const match = text.match(RAW_FILENAME_RE);
    if (!match) return null;

    const rawFile = match[0].toUpperCase();
    const [, year, month, day, hour, min, sec] = match;
    const recordedAt = `${year}-${month}-${day} ${hour}:${min}:${sec}`;
    return { rawFile, recordedAt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isOCRAvailable() {
  return typeof Tesseract !== 'undefined';
}
