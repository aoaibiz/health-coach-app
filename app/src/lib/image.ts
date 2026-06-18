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

async function loadBitmap(file: File): Promise<ImageBitmap> {
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
