// Recorte (Cropping, as in Resolve's Inspector): cuts the edges of a clip's picture.
// It is kept as ONE rectangle mask in "cut" mode with a fixed id, so the preview, the export and
// the live link already draw it (they only know masks). Sides are fractions of the frame (0..1,
// left 0.25 = the left quarter is gone); soft is 0..1 (the mask's feather, 0..0.2 of the short side).
export const CROP_ID = 'crop';
const MAX_FEATHER = 0.2;
/** What is left of the picture is never thinner than this. */
const MIN_SIZE = 0.02;
const SIDES = ['left', 'right', 'top', 'bottom'];
const r3 = (n) => Math.round(n * 1000) / 1000;
const c01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** The crop of a clip: { left, right, top, bottom, soft }, all 0 when it has none. */
export function cropOf(clip) {
  const m = (clip?.masks ?? []).find((x) => x.id === CROP_ID);
  if (!m) return { left: 0, right: 0, top: 0, bottom: 0, soft: 0 };
  return {
    left: r3(c01(m.x - m.w / 2)),
    right: r3(c01(1 - (m.x + m.w / 2))),
    top: r3(c01(m.y - m.h / 2)),
    bottom: r3(c01(1 - (m.y + m.h / 2))),
    soft: r3(c01(m.feather / MAX_FEATHER)),
  };
}

export const hasCrop = (clip) => (clip?.masks ?? []).some((x) => x.id === CROP_ID);

/**
 * Changes the crop of a clip in place (only the keys given in `patch`) and returns the new crop.
 * Two opposite sides can never meet: the side being changed stops before the other one.
 * With everything at 0 the crop mask is removed.
 */
export function setCrop(clip, patch = {}) {
  const v = cropOf(clip);
  const given = (k) => patch[k] !== undefined && patch[k] !== null;
  for (const k of [...SIDES, 'soft']) if (given(k)) v[k] = c01(Number(patch[k]));
  const fit = (a, b) => {
    const over = v[a] + v[b] - (1 - MIN_SIZE);
    if (over <= 0) return;
    // The side that was not touched keeps its value; when both (or none) were given, `a` keeps it.
    const move = given(b) || !given(a) ? b : a;
    const keep = move === a ? b : a;
    v[keep] = Math.min(v[keep], 1 - MIN_SIZE);
    v[move] = Math.max(0, 1 - MIN_SIZE - v[keep]);
  };
  fit('left', 'right');
  fit('top', 'bottom');
  for (const k of [...SIDES, 'soft']) v[k] = r3(v[k]);
  const rest = (clip.masks ?? []).filter((x) => x.id !== CROP_ID);
  if (SIDES.every((k) => v[k] === 0) && v.soft === 0) {
    if (rest.length) clip.masks = rest;
    else delete clip.masks;
    return v;
  }
  const w = 1 - v.left - v.right;
  const h = 1 - v.top - v.bottom;
  // First in the list: the picture is cropped before the other masks work on it.
  clip.masks = [{ id: CROP_ID, shape: 'rect', x: r3(v.left + w / 2), y: r3(v.top + h / 2), w: r3(w), h: r3(h), feather: r3(v.soft * MAX_FEATHER), invert: false, mode: 'cut', amount: 1 }, ...rest];
  return v;
}
