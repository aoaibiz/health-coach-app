// Downscale + recompress a user-selected photo before storing it in IndexedDB.
// Phone photos are often 3-8 MB; we cap the longest edge and re-encode as JPEG.

const MAX_EDGE = 1280;
const QUALITY = 0.82;

export async function compressImage(file: File): Promise<Blob> {
  // If it's already small and not a HEIC-ish type we can't decode, just keep it.
  const bitmap = await loadBitmap(file);

  let { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest > MAX_EDGE) {
    const scale = MAX_EDGE / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return file; // fall back to original
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", QUALITY),
  );
  return blob ?? file;
}

// ---- Avatar (small, SYNCED) -------------------------------------------------
//
// The profile avatar must survive a device switch, so — unlike meal photos which
// stay device-local in IndexedDB — it is embedded directly in the synced profile
// blob as a compact data: URL. We therefore downscale it HARD (small square-ish
// thumbnail) and bound the encoded size so it rides the existing profile sync
// without bloating it. A long edge of 512px @ JPEG 0.8 lands well under the
// AVATAR_MAX_DATA_URL_CHARS budget for a face photo.

/** Longest edge for the synced avatar thumbnail (smaller than MEAL photos). */
const AVATAR_MAX_EDGE = 512;
const AVATAR_QUALITY = 0.8;
/** Hard upper bound on the encoded avatar data: URL kept on the profile. A
 *  512px JPEG face photo is ~30-80KB; this caps it well below the per-section
 *  256KB sync budget so the avatar can never bloat the profile blob. Anything
 *  bigger is re-encoded at lower quality, then rejected if still over. */
export const AVATAR_MAX_DATA_URL_CHARS = 180_000;

const MEAL_GENERATED_ICON_EDGES = [192, 160, 128, 96] as const;
const MEAL_GENERATED_ICON_ENCODERS = [
  ["image/webp", 0.82],
  ["image/webp", 0.68],
  ["image/jpeg", 0.72],
  ["image/jpeg", 0.56],
  ["image/png", undefined],
] as const;
export const MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS = 120_000;
const MEAL_GENERATED_IMAGE_DATA_URL_RE =
  /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isValidGeneratedMealImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS) return false;
  return MEAL_GENERATED_IMAGE_DATA_URL_RE.test(value);
}

/**
 * Compress a user-selected image into a small JPEG **data: URL** suitable for
 * embedding in the synced profile (so the avatar follows the user across
 * devices). Returns null when the image can't be decoded/encoded or stays over
 * the size budget even after a quality retry (the caller then keeps no avatar
 * rather than bloating the synced blob). Browser-only.
 */
export async function compressAvatarToDataUrl(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch {
    return null;
  }

  let { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest > AVATAR_MAX_EDGE) {
    const scale = AVATAR_MAX_EDGE / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // First pass at the normal quality; if it's over budget, retry once lower.
  for (const q of [AVATAR_QUALITY, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url && url.startsWith("data:image/") && url.length <= AVATAR_MAX_DATA_URL_CHARS) {
      return url;
    }
  }
  return null; // still too big — better no avatar than a bloated synced blob.
}

/**
 * Compress a generated meal illustration into a small square data URL that can
 * be safely synced with the meal record. This is intentionally much smaller
 * than the local IndexedDB Blob: the list UI uses it as an icon-like thumbnail,
 * and cross-device sync needs a bounded JSON payload.
 */
export async function compressGeneratedMealImageToDataUrl(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await loadBitmap(blob);
  } catch {
    return null;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return null;
  }

  try {
    for (const edge of MEAL_GENERATED_ICON_EDGES) {
      canvas.width = edge;
      canvas.height = edge;
      const scale = Math.min(edge / bitmap.width, edge / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const x = Math.round((edge - width) / 2);
      const y = Math.round((edge - height) / 2);
      ctx.clearRect(0, 0, edge, edge);
      ctx.drawImage(bitmap, x, y, width, height);

      for (const [type, quality] of MEAL_GENERATED_ICON_ENCODERS) {
        const url = canvas.toDataURL(type, quality);
        if (isValidGeneratedMealImageDataUrl(url)) {
          return url;
        }
      }
    }
  } finally {
    bitmap.close?.();
  }

  return null;
}

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }
  // Fallback path for environments without createImageBitmap.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    // Wrap the HTMLImageElement to satisfy the ImageBitmap-ish usage above.
    return img as unknown as ImageBitmap;
  } finally {
    URL.revokeObjectURL(url);
  }
}
