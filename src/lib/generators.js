// Generators (Efeitos > Geradores, as in DaVinci Resolve): clips made by the app instead of a file.
//   adjustment  Adjustment Layer: draws nothing; its colour grade is applied to everything under it
//               for as long as the clip lasts (grade it on the Cor page, place it on the Editar page)
//   solid       a solid colour (fade to black, backgrounds)
//   fusion      Fusion Composition: an empty picture whose node graph is built on the Fusion page
// The preview (src/engine/player.ts) and the export (electron/render.cjs) treat a solid and a Fusion
// composition as a picture the size of the canvas, so transform, opacity, transitions, masks,
// effects and Fusion work on them like on any image.

export const GEN_KINDS = ['adjustment', 'solid', 'fusion'];

export const GENERATORS = {
  adjustment: { label: 'Adjustment Layer', hint: 'A cor desta camada aplica-se a tudo o que está por baixo, enquanto ela durar.' },
  solid: { label: 'Cor sólida', hint: 'Um plano de uma cor só: fade a preto, fundos.' },
  fusion: { label: 'Composição Fusion', hint: 'Uma composição vazia para construir com nós na página Fusion (animações, títulos).' },
};

/** Default length of a generator dropped on the timeline, seconds (Resolve's standard generator duration). */
export const GEN_DURATION = 5;

export const isGen = (c) => Boolean(c && c.gen && !c.mediaId && GENERATORS[c.gen]);
/** Generators that draw a picture of their own (the adjustment layer only changes what is under it). */
export const hasPicture = (c) => isGen(c) && c.gen !== 'adjustment';
export const genLabel = (c) => (isGen(c) ? GENERATORS[c.gen].label : '');
export const genColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c?.genColor ?? '')) ? String(c.genColor).toUpperCase() : '#000000');

/** A solid or a Fusion composition as a picture the size of the canvas (null for anything else). */
export function genMedia(c, canvas) {
  if (!hasPicture(c)) return null;
  return { id: `gen:${c.id}`, name: genLabel(c), path: '', kind: 'image', duration: 3600, width: canvas.w, height: canvas.h, fps: canvas.fps, hasAudio: false, thumb: null, gen: c.gen, color: genColor(c) };
}

/** The same picture for ffmpeg: a lavfi source (a Fusion composition starts transparent). */
export function genSource(c, W, H, FPS) {
  if (c.gen === 'solid') return `color=c=0x${genColor(c).slice(1)}:s=${W}x${H}:r=${FPS}`;
  return `color=c=black@0.0:s=${W}x${H}:r=${FPS},format=rgba`;
}

/** A new Fusion composition has only its output, like Resolve's (MediaOut). */
export const newComp = () => ({ nodes: [{ id: 'out', type: 'mediaOut', x: 560, y: 90, p: {} }], links: [] });
