// A small JPEG of what the viewer shows right now (thumbnails of saved effects, models and packs).
export function viewerShot(maxW = 320): string | null {
  const c = document.querySelector<HTMLCanvasElement>('.viewer .stage canvas');
  if (!c || !c.width || !c.height) return null;
  const k = Math.min(1, maxW / c.width);
  const out = document.createElement('canvas');
  out.width = Math.round(c.width * k);
  out.height = Math.round(c.height * k);
  out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height);
  try {
    return out.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
