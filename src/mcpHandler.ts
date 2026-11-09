// What each MCP tool does in the editor (electron/mcp.cjs lists the tools and their schemas).
import { useEditor } from './store';
import { addSfx, autoCaptions, autoSfx, cutSilences, describeProject, detectBeats, exportVideo, freezeFrame, importCapcut, importPaths, openProject, personMatte, saveProject, sfxLibrary } from './actions';
import { MOTION_PRESETS, TRANSITION_TYPES } from './lib/fx.js';
import type { MotionPreset } from './lib/fx.js';
import { GRAPHIC_KINDS } from './lib/graphics.js';
import type { Graphic, GraphicKind, TransitionType } from './types';
import { projectDuration } from './lib/project';
import { EASES } from './lib/anim.js';
import { BLEND_MODES, EFFECT_TYPES } from './lib/layerfx.js';
import type { BlendMode, Ease, Effect, KeyProp, Modifier } from './types';
import type { AutoCaptionOptions } from './actions';
import type { CanvasPreset } from './types';
import { LOOKS, PRESETS, STYLES, findClip, parseSrt, toSrt } from './lib/project';
import type { CaptionStyle, FNodeType, Grade, Mask, MaskMode } from './types';
import { MY_STYLE_ID, applyOverride, cleanOverride, validateStyle } from './lib/capstyle.js';
import { cleanLines } from './lib/emphasis.js';

const S = () => useEditor.getState();

/** Only plain numbers, strings and booleans go into node settings. */
function cleanParams(v: unknown): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') out[k] = x;
  return out;
}
const findClipFusion = (id: string) => findClip(S().project, id)?.clip.fusion;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function handleMcp(name: string, a: Record<string, unknown>): Promise<unknown> {
  S().setStatus(`Claude: ${name}`);
  switch (name) {
    case 'get_project':
      return describeProject();
    case 'import_media': {
      const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
      const r = await importPaths(paths);
      return { imported: r.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration })), errors: r.errors };
    }
    case 'add_clip': {
      const track = s(a.track) === 'audio' ? 'a1' : undefined;
      const id = S().addClip(String(a.media_id), { start: n(a.start), in: n(a.in), out: n(a.out), trackId: track });
      return { clip_id: id };
    }
    case 'move_clip':
      S().moveClip(String(a.clip_id), n(a.start) ?? 0);
      return { ok: true };
    case 'trim_clip':
      S().trimClip(String(a.clip_id), { in: n(a.in), out: n(a.out) });
      return { ok: true };
    case 'split_clip':
      return { cuts: S().splitAt(n(a.time) ?? S().playhead, s(a.clip_id) ?? null) };
    case 'delete_clip':
      S().deleteClip(String(a.clip_id), a.ripple === true);
      return { ok: true };
    case 'add_text':
      return { clip_id: S().addText(String(a.text ?? ''), n(a.start) ?? S().playhead, n(a.duration) ?? 3, s(a.style) ?? 'title', n(a.y)) };
    case 'update_clip': {
      const patch: Record<string, unknown> = {};
      for (const k of ['volume', 'y', 'size'] as const) if (n(a[k]) !== undefined) patch[k] = n(a[k]);
      if (n(a.orient) !== undefined) {
        const o = (((Math.round(n(a.orient)! / 90) * 90) % 360) + 360) % 360;
        patch.orient = o || undefined;
      }
      for (const k of ['fit', 'text', 'style'] as const) if (s(a[k]) !== undefined) patch[k] = s(a[k]);
      // New text must not keep the old word timings (the export draws the words, not the text):
      // same word count keeps the timings with the new words, otherwise the caption shows whole.
      if (patch.text !== undefined) {
        const old = findClip(S().project, String(a.clip_id))?.clip.words;
        const next = String(patch.text).split(/\s+/).filter(Boolean);
        patch.words = old?.length === next.length ? old.map((w, i) => ({ ...w, w: next[i] })) : undefined;
      }
      // Keyword of a Felipe/Marta caption: word index, -1 none, null back to automatic.
      if (a.keyword === null) patch.keyword = undefined;
      else if (n(a.keyword) !== undefined) patch.keyword = Math.round(n(a.keyword)!);
      // This caption's own look (over its style); override null clears it.
      const look: Record<string, unknown> = {};
      const keys = [['color', 'color'], ['highlight', 'highlight'], ['font', 'font'], ['keyword_color', 'keywordColor'], ['keyword_font', 'keywordFont'], ['outline_color', 'outlineColor']] as const;
      for (const [k, key] of keys) if (s(a[k]) !== undefined) look[key] = s(a[k]);
      if (a.override === null) patch.override = undefined;
      else if (a.override && typeof a.override === 'object') Object.assign(look, a.override);
      if (Object.keys(look).length) {
        const clean = cleanOverride({ ...findClip(S().project, String(a.clip_id))?.clip.override, ...look });
        if (!clean) throw new Error('Cores em #RRGGBB e fontes pelo nome (ex. "Inter Black")');
        patch.override = clean;
      }
      if (a.lines === null) patch.lines = undefined;
      else if (a.lines && typeof a.lines === 'object') patch.lines = cleanLines(a.lines);
      S().updateClip(String(a.clip_id), patch);
      return { ok: true };
    }
    case 'auto_captions':
      return autoCaptions({
        clipId: s(a.clip_id),
        style: s(a.style),
        maxWords: n(a.max_words),
        model: s(a.model),
        language: s(a.language),
        translate: a.translate === true,
        prompt: s(a.prompt),
        density: s(a.density) as AutoCaptionOptions['density'],
        maxChars: n(a.max_chars),
        maxLines: n(a.max_lines),
        textCase: s(a.text_case) as AutoCaptionOptions['textCase'],
        stripPunct: a.remove_punctuation === true,
        censor: Array.isArray(a.censor) ? a.censor.map(String) : s(a.censor)?.split(',').map((w) => w.trim()).filter(Boolean),
        override: { color: s(a.color), font: s(a.font), keywordColor: s(a.keyword_color), keywordFont: s(a.keyword_font), highlight: s(a.highlight) },
        size: n(a.size),
      });
    case 'cut_silences':
      return cutSilences(String(a.clip_id), n(a.min_pause) ?? 0.5, n(a.padding) ?? 0.12);
    case 'set_speed':
      S().setSpeed(String(a.clip_id), n(a.speed) ?? 1);
      return { ok: true };
    case 'set_transition': {
      const side = s(a.side) === 'out' ? 'out' : 'in';
      const type = s(a.type);
      if (type && type !== 'none' && !TRANSITION_TYPES.includes(type as TransitionType)) throw new Error(`type: ${TRANSITION_TYPES.join(', ')} ou none`);
      S().setTransition(String(a.clip_id), side, type && type !== 'none' ? { type: type as TransitionType, d: n(a.duration) ?? 0.5 } : null);
      return { ok: true };
    }
    case 'dissolve':
      S().dissolveWithPrevious(String(a.clip_id), n(a.duration) ?? 0.5);
      return { ok: true };
    case 'set_keyframe': {
      const id = String(a.clip_id);
      const time = n(a.time) ?? S().playhead;
      let count = 0;
      for (const prop of ['zoom', 'x', 'y', 'rotate', 'opacity'] as const) {
        const v = n(a[prop]);
        if (v !== undefined) {
          S().setKeyframe(id, prop, time, v);
          count++;
        }
      }
      if (!count) throw new Error('Indica zoom, x, y, rotate ou opacity');
      return { ok: true };
    }
    case 'animate_clip': {
      const preset = s(a.preset);
      if (preset === 'none') S().clearKeyframes(String(a.clip_id));
      else if (preset && MOTION_PRESETS.includes(preset as MotionPreset)) S().animate(String(a.clip_id), preset as MotionPreset, { amount: n(a.amount), every: n(a.every) });
      else throw new Error(`Usa ${MOTION_PRESETS.join(', ')} ou none`);
      return { ok: true };
    }
    case 'set_keyframe_ease': {
      const ease = s(a.ease) as Ease;
      if (!EASES.includes(ease)) throw new Error(`ease: ${EASES.join(', ')}`);
      const bz = Array.isArray(a.bz) && a.bz.length === 4 ? (a.bz.map(Number) as [number, number, number, number]) : undefined;
      if (ease === 'bezier' && !bz) throw new Error('bezier precisa de bz [x1, y1, x2, y2]');
      return { keyframes: S().setKeyframeEase(String(a.clip_id), (s(a.prop) as KeyProp) ?? null, n(a.time) ?? S().playhead, ease, bz) };
    }
    case 'set_modifier': {
      const prop = s(a.prop) as KeyProp;
      if (!['zoom', 'x', 'y', 'rotate', 'opacity'].includes(prop)) throw new Error('prop: zoom, x, y, rotate ou opacity');
      const type = s(a.type);
      let mod: Modifier | null = null;
      if (type === 'wiggle') mod = { type, freq: n(a.freq) ?? 2, amp: n(a.amp) ?? 0.02 };
      else if (type === 'loop') mod = { type, mode: s(a.mode) === 'pingpong' ? 'pingpong' : 'cycle' };
      else if (type === 'overshoot') mod = { type, amp: n(a.amp) ?? 0.25, freq: n(a.freq) ?? 3, decay: n(a.decay) ?? 6 };
      else if (type !== 'none') throw new Error('type: wiggle, loop, overshoot ou none');
      S().setModifier(String(a.clip_id), prop, mod);
      return { ok: true };
    }
    case 'set_blend': {
      const mode = s(a.mode) as BlendMode;
      if (!BLEND_MODES.includes(mode)) throw new Error(`mode: ${BLEND_MODES.join(', ')}`);
      S().setBlend(String(a.clip_id), mode);
      return { ok: true };
    }
    case 'set_matte': {
      const kind = s(a.kind);
      if (kind === 'none') S().setMatte(String(a.clip_id), null);
      else if (kind === 'text') S().setMatte(String(a.clip_id), { kind: 'text', text: s(a.text) ?? 'TEXTO', font: s(a.font), size: n(a.size), x: n(a.x), y: n(a.y), invert: a.invert === true });
      else if (kind === 'media') {
        const mid = s(a.media_id);
        if (!mid || !S().project.media.some((m) => m.id === mid)) throw new Error('media_id: id de uma média do projeto');
        S().setMatte(String(a.clip_id), { kind: 'media', mediaId: mid, mode: s(a.mode) === 'luma' ? 'luma' : 'alpha', invert: a.invert === true });
      } else throw new Error('kind: text, media ou none');
      return { ok: true };
    }
    case 'add_effect': {
      const type = s(a.type) as Effect['type'];
      if (!EFFECT_TYPES.includes(type)) throw new Error(`type: ${EFFECT_TYPES.join(', ')}`);
      return { effect_id: S().addEffect(String(a.clip_id), type, (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>) };
    }
    case 'update_effect':
      if (a.remove === true) S().removeEffect(String(a.clip_id), String(a.effect_id));
      else S().updateEffect(String(a.clip_id), String(a.effect_id), (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>);
      return { ok: true };
    case 'add_graphic':
    case 'update_graphic': {
      const patch: Partial<Graphic> = {};
      for (const k of ['title', 'subtitle', 'font'] as const) if (s(a[k]) !== undefined) patch[k] = s(a[k]);
      for (const k of ['accent', 'color', 'dark'] as const) {
        const v = s(a[k]);
        if (v === undefined) continue;
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`${k}: usa uma cor #RRGGBB`);
        patch[k] = v;
      }
      for (const k of ['x', 'y', 'scale'] as const) if (n(a[k]) !== undefined) patch[k] = n(a[k]);
      if (name === 'update_graphic') {
        S().updateGraphic(String(a.clip_id), patch);
        return { ok: true };
      }
      const kind = s(a.kind) as GraphicKind;
      if (!GRAPHIC_KINDS.includes(kind)) throw new Error(`kind: ${GRAPHIC_KINDS.join(', ')}`);
      const start = n(a.start) ?? (kind === 'progress' ? 0 : S().playhead);
      const length = n(a.duration) ?? (kind === 'progress' ? Math.max(1, projectDuration(S().project) - start) : 3);
      return { clip_id: S().addGraphic(kind, start, length, patch) };
    }
    case 'list_sfx':
      return (await sfxLibrary()).map((x) => ({ id: x.id, label: x.label, duration: x.duration }));
    case 'add_sfx':
      return { clip_id: await addSfx(String(a.id), n(a.time) ?? S().playhead, n(a.volume) ?? 0.8) };
    case 'auto_sfx': {
      const modes = (Array.isArray(a.modes) ? a.modes.map(String) : ['transitions', 'graphics']).filter((m): m is 'transitions' | 'cuts' | 'graphics' => m === 'transitions' || m === 'cuts' || m === 'graphics');
      return autoSfx(modes.length ? modes : ['transitions', 'graphics'], n(a.volume) ?? 0.7);
    }
    case 'detect_beats':
      return detectBeats(s(a.clip_id), n(a.sensitivity) ?? 1);
    case 'beat_sync': {
      const mode = s(a.mode);
      if (mode === 'pulse') return { clips: S().beatPulse(s(a.clip_id) ? [String(a.clip_id)] : 'all', n(a.amount) ?? 0.08) };
      if (mode === 'snap_cuts') return { cuts_moved: S().snapCutsToBeats(n(a.max_shift) ?? 0.25) };
      throw new Error('mode: pulse ou snap_cuts');
    }
    case 'add_marker': {
      if (a.clear === true) return { removed: S().clearMarkers(a.beats_only === true) };
      if (a.remove === true) {
        S().removeMarker(String(a.marker_id));
        return { ok: true };
      }
      const color = s(a.color);
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('color: #RRGGBB');
      return { marker_id: S().addMarker(n(a.time) ?? S().playhead, s(a.label), color) };
    }
    case 'freeze_frame':
      return freezeFrame(n(a.time) ?? S().playhead, Math.max(0.2, Math.min(10, n(a.length) ?? 1.5)), s(a.clip_id));
    case 'set_color': {
      const ids = s(a.clip_id) ? [String(a.clip_id)] : 'all';
      if (a.reset === true) return { clips: S().setGrade(ids, null) };
      const look = s(a.look);
      if (look && !LOOKS[look]) throw new Error(`Look desconhecido: usa ${Object.keys(LOOKS).join(', ')}`);
      const g: Grade = look ? { ...LOOKS[look]!.grade } : {};
      for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'vignette'] as const) if (n(a[k]) !== undefined) g[k] = n(a[k]);
      if (s(a.lut) !== undefined) {
        const lut = s(a.lut)!;
        if (lut && !/^[a-zA-Z]:[\\/].*\.cube$/i.test(lut)) throw new Error('A LUT tem de ser um caminho completo de um ficheiro .cube');
        g.lut = lut;
      }
      const clips = S().setGrade(ids, g, Boolean(look));
      if (!clips) throw new Error('Não há clips de vídeo para corrigir');
      return { clips };
    }
    case 'set_caption_style': {
      const patch: Partial<CaptionStyle> = {};
      for (const [k, key] of [['font', 'font'], ['color', 'color'], ['highlight', 'highlight'], ['outline_color', 'outlineColor'], ['box_color', 'boxColor'], ['shadow_color', 'shadowColor'], ['marker', 'marker']] as const) {
        const v = s(a[k]);
        if (v === undefined) continue;
        if (k !== 'font' && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`${k}: usa uma cor #RRGGBB`);
        patch[key] = v;
      }
      if (n(a.size) !== undefined) patch.size = Math.max(0.02, Math.min(0.14, n(a.size)!));
      if (n(a.outline) !== undefined) patch.outline = Math.max(0, Math.min(0.02, n(a.outline)!));
      if (n(a.y) !== undefined) patch.y = Math.max(0.05, Math.min(0.95, n(a.y)!));
      if (typeof a.box === 'boolean') patch.box = a.box;
      if (typeof a.glow === 'boolean') patch.glow = a.glow;
      if (n(a.shadow) !== undefined) patch.shadow = Math.max(0, Math.min(0.015, n(a.shadow)!));
      if (n(a.spacing) !== undefined) patch.spacing = Math.max(0, Math.min(0.012, n(a.spacing)!));
      const anim = s(a.anim);
      if (anim) {
        if (!['pop', 'fade', 'slide', 'words', 'bounce', 'karaoke', 'marker'].includes(anim)) throw new Error('anim: pop, fade, slide, words, bounce, karaoke ou marker');
        patch.anim = anim as CaptionStyle['anim'];
      }
      if (typeof a.uppercase === 'boolean') patch.uppercase = a.uppercase;
      const style = s(a.style);
      const known = (id: string) => Boolean(STYLES[id] || S().userStyles[id] || S().project.styles?.[id]);
      if (style && style !== 'custom' && !known(style)) throw new Error(`Estilo: ${Object.keys(STYLES).join(', ')}, custom ou um estilo guardado (list_caption_styles)`);
      if (Object.keys(patch).length) {
        if (style && STYLES[style]) S().setCaptionStyle({ ...STYLES[style]!, ...patch }, true);
        else S().setCaptionStyle(patch);
        return { captions: S().styleAllCaptions(MY_STYLE_ID), style: S().project.styles?.[MY_STYLE_ID] };
      }
      if (!style) throw new Error('Indica style ou uma propriedade do estilo');
      if (style === 'custom' && !known(MY_STYLE_ID)) S().setCaptionStyle({});
      return { captions: S().styleAllCaptions(style) };
    }
    case 'list_caption_styles': {
      const saved = { ...S().project.styles, ...S().userStyles };
      return {
        presets: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label])),
        saved: Object.fromEntries(Object.entries(saved).filter(([k]) => !STYLES[k])),
      };
    }
    case 'save_caption_style': {
      // Start from a preset/saved style (from) or the given style object; fields override it.
      const from = s(a.from);
      const base = from ? (STYLES[from] ?? S().userStyles[from] ?? S().project.styles?.[from]) : null;
      if (from && !base) throw new Error(`Estilo de partida desconhecido: ${from}`);
      const given = a.style && typeof a.style === 'object' ? (a.style as Partial<CaptionStyle>) : {};
      const start = { ...(base ?? STYLES.clean!), ...given, label: s(a.name) ?? given.label ?? base?.label ?? 'Novo estilo' } as CaptionStyle;
      const merged = applyOverride(start, cleanOverride({ font: given.font, color: given.color, keywordColor: s(a.keyword_color), keywordFont: s(a.keyword_font) }));
      const style = validateStyle(merged);
      if (!style) throw new Error('Estilo inválido: precisa de font, size e color (#RRGGBB)');
      const id = s(a.id);
      if (id && STYLES[id]) throw new Error('Não se pode substituir um estilo da app; usa outro id');
      const saved = await S().saveUserStyle(id ?? null, style);
      if (a.apply === true) S().applyCaptionStyle(saved, 'all');
      return { id: saved, style: S().userStyles[saved] };
    }
    case 'delete_caption_style': {
      const id = String(a.id);
      if (STYLES[id]) throw new Error('Os estilos da app não se apagam');
      return { deleted: await S().deleteUserStyle(id) };
    }
    case 'export_srt':
      return { path: await window.ec.writeSrt(String(a.path), toSrt(S().project)) };
    case 'import_srt': {
      const list = parseSrt(await window.ec.readSrt(String(a.path)));
      if (!list.length) throw new Error('O ficheiro não tem legendas SRT');
      return { captions: S().addCaptions(list, a.replace === true, s(a.style) ?? 'clean') };
    }
    case 'set_audio': {
      const patch: { normalize?: boolean; duck?: boolean } = {};
      if (typeof a.normalize === 'boolean') patch.normalize = a.normalize;
      if (typeof a.duck === 'boolean') patch.duck = a.duck;
      S().setAudio(patch);
      return { audio: S().project.audio };
    }
    case 'add_mask':
    case 'update_mask': {
      const clipId = String(a.clip_id);
      const shape = s(a.shape);
      if (shape && !['ellipse', 'rect', 'pen', 'person'].includes(shape)) throw new Error('shape: ellipse, rect, pen ou person');
      const mode = s(a.mode);
      if (mode && !['blur', 'pixelate', 'darken', 'cut', 'front'].includes(mode)) throw new Error('mode: front, blur, pixelate, darken ou cut');
      const free = shape === 'pen' || shape === 'person';
      const id = name === 'add_mask' ? S().addMask(clipId, (shape as Mask['shape']) ?? 'ellipse', (mode as MaskMode) ?? (free ? 'front' : 'blur')) : String(a.mask_id);
      if (name === 'add_mask' && free) S().setMaskTool(null);
      if (Array.isArray(a.points)) {
        const pts = (a.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v))).map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number]);
        if (pts.length < 3) throw new Error('points: pelo menos 3 pontos [x, y] de 0 a 1');
        S().updateMask(clipId, id, { points: pts });
      }
      const patch: Partial<Mask> = {};
      for (const k of ['x', 'y', 'w', 'h', 'feather', 'amount'] as const) if (n(a[k]) !== undefined) patch[k] = n(a[k]);
      if (n(a.to_x) !== undefined) patch.toX = n(a.to_x);
      if (n(a.to_y) !== undefined) patch.toY = n(a.to_y);
      if (typeof a.invert === 'boolean') patch.invert = a.invert;
      if (shape) patch.shape = shape as Mask['shape'];
      if (mode) patch.mode = mode as MaskMode;
      const pick = shape === 'person' || findClip(S().project, clipId)?.clip.masks?.find((m) => m.id === id)?.shape === 'person';
      if (pick && (patch.x !== undefined || patch.y !== undefined)) {
        // Person: x/y is where the person is; cut them out over the whole clip.
        const m = findClip(S().project, clipId)!.clip.masks!.find((mm) => mm.id === id)!;
        await personMatte(clipId, id, patch.x ?? m.x, patch.y ?? m.y);
        delete patch.x;
        delete patch.y;
      }
      if (Object.keys(patch).length) S().updateMask(clipId, id, patch);
      return { mask_id: id };
    }
    case 'remove_mask':
      S().removeMask(String(a.clip_id), String(a.mask_id));
      return { ok: true };
    case 'fusion_add_node': {
      const id = S().addNode(String(a.clip_id), String(a.type) as FNodeType, s(a.after) ?? null);
      if (a.params && typeof a.params === 'object') S().setNodeParams(String(a.clip_id), id, cleanParams(a.params));
      return { node_id: id, fusion: findClipFusion(String(a.clip_id)) };
    }
    case 'fusion_set':
      S().setNodeParams(String(a.clip_id), String(a.node_id), cleanParams(a.params));
      return { ok: true };
    case 'fusion_link':
      if (s(a.from)) S().linkNodes(String(a.clip_id), String(a.from), String(a.to), n(a.port) ?? 0);
      else S().unlinkPort(String(a.clip_id), String(a.to), n(a.port) ?? 0);
      return { fusion: findClipFusion(String(a.clip_id)) };
    case 'fusion_remove':
      if (s(a.node_id) === 'all') S().resetFusion(String(a.clip_id));
      else S().removeNode(String(a.clip_id), String(a.node_id));
      return { ok: true };
    case 'list_capcut':
      return (await window.ec.capcutList()).map((d) => ({ name: d.name, file: d.file, duration: d.duration, modified: new Date(d.modified).toISOString() }));
    case 'import_capcut': {
      let file = s(a.file) ?? null;
      if (!file) file = (await window.ec.capcutList())[0]?.file ?? null;
      if (!file) throw new Error('Não encontrei projetos do CapCut neste PC');
      return importCapcut(file);
    }
    case 'set_canvas': {
      const preset = String(a.preset) as CanvasPreset;
      if (!PRESETS[preset]) throw new Error('Formato inválido: usa 9:16, 16:9, 1:1 ou 4:5');
      S().setCanvas(preset);
      return { canvas: S().project.canvas };
    }
    case 'show_page': {
      const page = s(a.page);
      if (page !== 'media' && page !== 'edit' && page !== 'fusion' && page !== 'color' && page !== 'captions' && page !== 'deliver') throw new Error('Página: media, edit, fusion, color, captions ou deliver');
      S().setPage(page);
      return { page };
    }
    case 'seek':
      S().seek(n(a.time) ?? 0);
      return { playhead: S().playhead };
    case 'export_video': {
      const path = s(a.path);
      if (path && !/^[a-zA-Z]:[\\/]/.test(path)) throw new Error('Usa um caminho completo (ex.: C:\\Users\\...\\video.mp4)');
      return { path: await exportVideo({ path, gpu: a.gpu === true, ask: false }) };
    }
    case 'open_project': {
      const r = await openProject(s(a.path) ?? undefined);
      return r ? { opened: r.path, name: r.project.name } : { opened: null };
    }
    case 'save_project':
      return { path: await saveProject(s(a.path) ?? null) };
    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}
