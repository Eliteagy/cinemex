// Preview engine: draws the frame at the playhead on a canvas. One <video>/<audio> element per
// clip, seeked or played in sync with the timeline clock; images and captions drawn directly.
import type { Clip, Media, Project, Track } from '../types';
import { activeClip, end, gradeMath, isGraded, mediaUrl, projectDuration, speedOf, srcTime, styleOf, audioFade } from '../lib/project';
import type { CaptionStyle } from '../types';
import { drawCaption, loadFonts, onFontsChanged } from './caption';
import { applyMasks, frontLayer, type Mattes } from './mask';
import { evalFusion, hasFusion } from './fusion';
import { BFLASH, transitionState as fxState } from '../lib/fx.js';
import { drawGraphic } from './graphics';
import { propAt } from '../lib/anim.js';
import { BLEND_CANVAS } from '../lib/layerfx.js';
import { applyLayerFx } from './layerfx';

type El = HTMLVideoElement | HTMLAudioElement;


export class Player {
  private ctx: CanvasRenderingContext2D;
  private els = new Map<string, El>();
  private imgs = new Map<string, HTMLImageElement>();
  private raf = 0;
  private wallStart = 0;
  private tStart = 0;
  private lastPlaying = false;
  private lastEmitted = 0;
  private dirty = true;
  private offFonts: () => void = () => {};
  private layerCanvas: HTMLCanvasElement | null = null;
  /** Last frame where every visible video clip was ready: shown instead of black while the next one loads. */
  private lastVideo: HTMLCanvasElement | null = null;
  /** Video clips visible in the last frame drawn while playing (null when paused: scrubbing never waits). */
  private shown: Set<string> | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private get: () => { project: Project; playhead: number; playing: boolean; userStyles?: Record<string, CaptionStyle> },
    private onTime: (t: number) => void,
    private onEnd: () => void,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    void loadFonts().then(() => (this.dirty = true));
    this.offFonts = onFontsChanged(() => (this.dirty = true));
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Transparent canvas-sized layer for masked clips. */
  private layer(w: number, h: number) {
    const c = (this.layerCanvas ??= document.createElement('canvas'));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, w, h);
    return x;
  }

  private fusionPool = new Map<string, HTMLCanvasElement>();
  private fusionInput: HTMLCanvasElement | null = null;

  /** Run the clip's node graph on the layer (MediaIn = the framed clip). */
  private runFusion(clip: Clip, local: number, cw: number, ch: number, media: Map<string, Media>, playing: boolean, used: Set<string>) {
    const layer = this.layerCanvas!;
    const input = (this.fusionInput ??= document.createElement('canvas'));
    input.width = cw;
    input.height = ch;
    input.getContext('2d')!.drawImage(layer, 0, 0);
    const out = evalFusion(
      clip.fusion!,
      {
        w: cw,
        h: ch,
        local,
        input,
        media: (node, mediaId) => {
          const m = media.get(mediaId);
          if (!m) return null;
          if (m.kind === 'image') {
            const img = this.image(m);
            return img.naturalWidth ? img : null;
          }
          // A Media node plays its file from the start of the clip, looping.
          const key = `${clip.id}/${node.id}`;
          const el = this.element({ id: key }, m) as HTMLVideoElement;
          used.add(key);
          const t = m.duration > 0 ? local % m.duration : local;
          this.sync(el, t, playing, 0, 1);
          return el.readyState >= 2 ? el : null;
        },
        mediaSize: (_node, mediaId) => {
          const m = media.get(mediaId);
          return m ? { w: m.width || 1920, h: m.height || 1080 } : null;
        },
      },
      this.fusionPool,
    );
    const lx = layer.getContext('2d')!;
    lx.clearRect(0, 0, cw, ch);
    if (out) lx.drawImage(out, 0, 0);
  }

  private probe: CanvasRenderingContext2D | null = null;
  /** True when the video element has no picture to give yet (draws fully transparent). */
  private emptyFrame(v: HTMLVideoElement) {
    if (!this.probe) {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 2;
      this.probe = c.getContext('2d', { willReadFrequently: true });
    }
    const p = this.probe;
    if (!p) return false;
    p.clearRect(0, 0, 2, 2);
    try {
      p.drawImage(v, 0, 0, 2, 2);
      const d = p.getImageData(0, 0, 2, 2).data;
      return d[3] === 0 && d[7] === 0 && d[11] === 0 && d[15] === 0;
    } catch {
      return false;
    }
  }

  invalidate() {
    this.dirty = true;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.offFonts();
    for (const el of this.els.values()) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.els.clear();
  }

  private element(clip: Clip | { id: string }, m: Media): El {
    let el = this.els.get(clip.id);
    if (!el || el.dataset.src !== m.path) {
      el?.pause();
      el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.dataset.src = m.path;
      el.src = mediaUrl(m.path);
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.addEventListener('seeked', () => (this.dirty = true));
      el.addEventListener('loadeddata', () => (this.dirty = true));
      this.els.set(clip.id, el);
    }
    return el;
  }

  private image(m: Media) {
    let img = this.imgs.get(m.id);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => (this.dirty = true);
      img.src = mediaUrl(m.path);
      this.imgs.set(m.id, img);
    }
    return img;
  }

  private tick() {
    const { project, playhead, playing } = this.get();
    let t = playhead;
    if (playing) {
      // Started, or the user moved the playhead while playing: restart the clock from there.
      if (!this.lastPlaying || Math.abs(playhead - this.lastEmitted) > 0.05) {
        this.wallStart = performance.now();
        this.tStart = playhead;
      }
      t = this.tStart + (performance.now() - this.wallStart) / 1000;
      const total = projectDuration(project);
      if (t >= total) {
        t = total;
        this.onEnd();
      }
      this.lastEmitted = t;
      this.onTime(t);
    } else if (this.lastPlaying) this.dirty = true;
    if (!playing && Math.abs(t - this.tStart) > 1e-6) {
      this.tStart = t;
      this.dirty = true;
    }
    this.lastPlaying = playing;
    if (playing || this.dirty) this.draw(project, t, playing);
  }

  private sync(el: El, target: number, playing: boolean, volume: number, rate = 1) {
    if (el.playbackRate !== rate) el.playbackRate = rate;
    el.preservesPitch = true;
    el.volume = Math.max(0, Math.min(1, volume));
    el.muted = volume <= 0;
    if (playing) {
      if (el.paused) {
        el.currentTime = target;
        void el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02 && !el.seeking) el.currentTime = target;
    }
  }

  private draw(project: Project, t: number, playing: boolean) {
    this.dirty = false;
    const { w: W, h: H } = project.canvas;
    const scale = Math.min(1, 1280 / Math.max(W, H)); // preview resolution cap
    const cw = Math.round(W * scale);
    const ch = Math.round(H * scale);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const media = new Map(project.media.map((m) => [m.id, m]));
    const used = new Set<string>();
    // Parts of clips that go over the captions ("front" masks), drawn after the text.
    const fronts: { canvas: HTMLCanvasElement; alpha: number; slide: number }[] = [];
    let missing = false;
    const nowShown = new Set<string>();

    for (const track of project.tracks) {
      if (track.kind === 'text') continue;
      const clip = track.hidden && track.kind === 'video' ? null : activeClip(track, t);
      // Audio of every active media clip, also on hidden video tracks.
      const audible = track.kind === 'audio' || track.kind === 'video' ? activeClip(track, t) : null;
      if (audible) {
        const m = media.get(audible.mediaId ?? '');
        if (m && m.kind !== 'image') {
          const el = this.element(audible, m);
          used.add(audible.id);
          const fade = audioFade(audible, t - audible.start);
          this.sync(el, srcTime(audible, t), playing, track.muted ? 0 : (audible.volume ?? 1) * fade, speedOf(audible));
        }
      }
      if (!clip || track.kind !== 'video') continue;
      const m = media.get(clip.mediaId ?? '');
      if (!m) continue;
      const src: CanvasImageSource | null = m.kind === 'image' ? this.image(m) : (this.els.get(clip.id) as HTMLVideoElement | undefined) ?? null;
      // An image that has not finished decoding would draw nothing (black): treat it as still loading.
      if (src instanceof HTMLImageElement && !src.complete) {
        missing = true;
        this.dirty = true;
        continue;
      }
      const sw = src instanceof HTMLVideoElement ? src.videoWidth : src instanceof HTMLImageElement ? src.naturalWidth : 0;
      const sh = src instanceof HTMLVideoElement ? src.videoHeight : src instanceof HTMLImageElement ? src.naturalHeight : 0;
      // A clip that just became visible waits for its first presented frame (requestVideoFrameCallback),
      // at most 250 ms, so the cut never shows an empty frame.
      if (src instanceof HTMLVideoElement && this.shown !== null && !this.shown.has(clip.id)) {
        src.dataset.vfc = String(performance.now());
        src.dataset.since = src.dataset.vfc;
        // Wait for a presented frame of the right moment (a stale frame from the parked position does not count).
        const want = srcTime(clip, t);
        const cb: VideoFrameRequestCallback = (_now, md) => {
          if (Math.abs(md.mediaTime - want) < 0.3 || !src.dataset.vfc) {
            src.dataset.vfc = '';
            this.dirty = true;
          } else src.requestVideoFrameCallback(cb);
        };
        src.requestVideoFrameCallback?.(cb);
      }
      nowShown.add(clip.id);
      const waiting = src instanceof HTMLVideoElement && Boolean(src.dataset.vfc) && performance.now() - Number(src.dataset.vfc) < 400;
      // Right after a cut the decoder can hand over an empty picture: probe it on a 2x2 canvas
      // (an empty frame draws nothing, alpha 0; real black footage is opaque).
      const fresh = src instanceof HTMLVideoElement && performance.now() - Number(src.dataset.since || 0) < 400;
      const empty = fresh && src instanceof HTMLVideoElement && src.readyState >= 2 && !src.seeking && this.emptyFrame(src);
      if (!src || !sw || !sh || waiting || empty || (src instanceof HTMLVideoElement && (src.readyState < 2 || src.seeking))) {
        missing = true;
        this.dirty = true;
        continue;
      }
      // Sideways footage: framing uses the rotated size (export: transpose before scale).
      const orient = clip.orient ?? 0;
      const side = orient === 90 || orient === 270;
      const ow = side ? sh : sw;
      const oh = side ? sw : sh;
      const k = clip.fit === 'fit' ? Math.min(cw / ow, ch / oh) : Math.max(cw / ow, ch / oh);
      const dw = ow * k;
      const dh = oh * k;
      const local = t - clip.start;
      const tr = fxState(clip, local, end(clip) - clip.start);
      // Zoom/pan keyframes: the frame point (cx, cy) goes to the centre, scaled by z (as the export's zoompan).
      const z = Math.max(1, propAt(clip, 'zoom', local, 1)) * tr.zoom;
      const rot = ((propAt(clip, 'rotate', local, 0) + tr.rotate) * Math.PI) / 180;
      const opacity = Math.max(0, Math.min(1, propAt(clip, 'opacity', local, 1)));
      const blurPx = tr.blur * Math.min(cw, ch);
      const cx = Math.max(0.5 / z, Math.min(1 - 0.5 / z, 0.5 + propAt(clip, 'x', local, 0)));
      const cy = Math.max(0.5 / z, Math.min(1 - 0.5 / z, 0.5 + propAt(clip, 'y', local, 0)));
      // Masked or Fusion clips are drawn on their own layer (no slide/fade), processed, then composited.
      const fused = hasFusion(clip.fusion);
      // Rotation, opacity, transition blur and flash/dip are applied when the clip layer is
      // composited (after masks and Fusion), in the same order as the export.
      const masked = Boolean(clip.masks?.length) || fused || Math.abs(rot) > 1e-4 || opacity < 0.999 || blurPx > 0.3 || tr.white > 0 || tr.black > 0 || tr.bright > 0 || Boolean(clip.effects?.length) || Boolean(clip.matte) || Boolean(clip.blend && clip.blend !== 'normal');
      const x = masked ? this.layer(cw, ch) : ctx;
      const alpha = masked ? 1 : tr.alpha;
      const slide = masked ? 0 : tr.slide;
      x.save();
      x.globalAlpha = alpha;
      x.beginPath();
      x.rect(slide * cw, 0, cw, ch);
      x.clip();
      x.translate(cw / 2 + slide * cw, ch / 2);
      x.scale(z, z);
      x.translate(-cx * cw, -cy * ch);
      const graded = isGraded(clip.color);
      const g = graded ? gradeMath(clip.color) : null;
      if (g) x.filter = `brightness(${g.bright}) contrast(${g.contrast}) saturate(${g.saturation})`;
      if (orient) {
        x.save();
        x.translate(cw / 2, ch / 2);
        x.rotate((-orient * Math.PI) / 180);
        x.drawImage(src, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
        x.restore();
      } else x.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      x.filter = 'none';
      if (g) {
        // Temperature: multiply by a warm/cool tint (same factors as the export's colorchannelmixer).
        if (g.warm.some((w) => Math.abs(w - 1) > 1e-3)) {
          const top = Math.max(...g.warm);
          x.globalCompositeOperation = 'multiply';
          x.fillStyle = `rgb(${g.warm.map((w) => Math.round((w / top) * 255)).join(',')})`;
          x.fillRect((cw - dw) / 2, (ch - dh) / 2, dw, dh);
          x.globalCompositeOperation = 'source-over';
          x.globalAlpha = alpha;
        }
      }
      x.restore();
      if (g && g.vignette > 0) {
        x.save();
        x.globalAlpha = alpha;
        const r = Math.hypot(cw, ch) / 2;
        const grad = x.createRadialGradient(cw / 2, ch / 2, r * (0.75 - g.vignette * 0.35), cw / 2, ch / 2, r);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, `rgba(0,0,0,${0.35 + g.vignette * 0.5})`);
        x.fillStyle = grad;
        x.fillRect(0, 0, cw, ch);
        x.restore();
      }
      if (masked) {
        if (fused) this.runFusion(clip, local, cw, ch, media, playing, used);
        // Person mattes: their grey video framed exactly like the clip (same fit, zoom and pan).
        const mattes: Mattes = new Map();
        for (const mk of clip.masks ?? []) {
          if (mk.shape !== 'person' || !mk.matte) continue;
          const key = `matte:${clip.id}:${mk.id}`;
          const el = this.element({ id: key }, { id: key, path: mk.matte.file, kind: 'video' } as Media) as HTMLVideoElement;
          used.add(key);
          this.sync(el, Math.max(0, srcTime(clip, t) - mk.matte.in), playing, 0, speedOf(clip));
          if (el.readyState < 2) continue;
          const mc = document.createElement('canvas');
          mc.width = cw;
          mc.height = ch;
          const mx = mc.getContext('2d')!;
          mx.fillStyle = '#000';
          mx.fillRect(0, 0, cw, ch);
          mx.translate(cw / 2, ch / 2);
          mx.scale(z, z);
          mx.translate(-cx * cw, -cy * ch);
          mx.drawImage(el, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
          mattes.set(mk.id, mc);
        }
        if (clip.masks?.length) {
          applyMasks(this.layerCanvas!, clip.masks, local, end(clip) - clip.start, mattes);
          const fr = frontLayer(this.layerCanvas!, clip.masks, local, end(clip) - clip.start, mattes);
          if (fr) fronts.push({ canvas: fr, alpha: tr.alpha, slide: tr.slide });
        }
        if (clip.effects?.length || clip.matte) {
          applyLayerFx(this.layerCanvas!, clip, local, W, H, (mediaId) => {
            const mm = media.get(mediaId);
            if (!mm) return null;
            if (mm.kind === 'image') {
              const img = this.image(mm);
              return img.complete && img.naturalWidth ? img : null;
            }
            // A video matte plays from the clip's start, looping (same as the export).
            const key = `${clip.id}/matte`;
            const el = this.element({ id: key }, mm) as HTMLVideoElement;
            used.add(key);
            this.sync(el, mm.duration > 0 ? local % mm.duration : local, playing, 0, 1);
            return el.readyState >= 2 ? el : null;
          });
        }
        const layer = this.layerCanvas!;
        ctx.save();
        ctx.globalCompositeOperation = BLEND_CANVAS[clip.blend ?? 'normal'] ?? 'source-over';
        ctx.globalAlpha = tr.alpha * opacity;
        ctx.translate(cw / 2 + tr.slide * cw, ch / 2);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.rect(-cw / 2, -ch / 2, cw, ch);
        ctx.clip();
        if (blurPx > 0.3 && tr.blurDir) {
          // Horizontal motion blur (whip): average of shifted copies, like gblur with sigmaV ~ 0.
          const n = 9;
          const a0 = ctx.globalAlpha;
          for (let i = 0; i < n; i++) {
            ctx.globalAlpha = a0 / (i + 1);
            ctx.drawImage(layer, -cw / 2 + (i / (n - 1) - 0.5) * 4 * blurPx, -ch / 2);
          }
          ctx.globalAlpha = a0;
        } else {
          if (blurPx > 0.3) ctx.filter = `blur(${blurPx}px)`;
          ctx.drawImage(layer, -cw / 2, -ch / 2);
          ctx.filter = 'none';
        }
        ctx.globalCompositeOperation = 'source-over';
        if (tr.bright > 0) {
          // Brightness Flash: add the picture again (gain) and white (lift); 'lighter' adds and clips like the export.
          const a0 = ctx.globalAlpha;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = a0 * Math.min(1, BFLASH.gain * tr.bright);
          ctx.drawImage(layer, -cw / 2, -ch / 2);
          ctx.globalAlpha = a0;
          ctx.fillStyle = `rgba(255,255,255,${BFLASH.lift * tr.bright})`;
          ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
          ctx.globalCompositeOperation = 'source-over';
        }
        if (tr.white > 0 || tr.black > 0) {
          ctx.fillStyle = tr.white > 0 ? `rgba(255,255,255,${tr.white})` : `rgba(0,0,0,${tr.black})`;
          ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
        }
        ctx.restore();
      }
    }

    // Preload: the next clip of every video track is opened and parked on its first frame, so the
    // cut does not wait for a 4K file to load (that wait showed black at every cut).
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      const next = track.clips.find((c) => c.start > t + 1e-3 && c.start - t < 2.5);
      const m = next ? media.get(next.mediaId ?? '') : undefined;
      if (next && m?.kind === 'image') {
        const img = this.image(m);
        if (!img.dataset.decoding) {
          img.dataset.decoding = '1';
          void img.decode().catch(() => {});
        }
        continue;
      }
      if (!next || !m || m.kind !== 'video' || used.has(next.id)) continue;
      const el = this.element(next, m);
      used.add(next.id);
      this.sync(el, next.in, false, 0, 1);
    }
    for (const [id, el] of this.els) if (!used.has(id) && !el.paused) el.pause();

    this.shown = playing ? nowShown : null;
    // A clip that is still loading keeps the last good picture instead of flashing black.
    const last = (this.lastVideo ??= document.createElement('canvas'));
    if (missing && last.width === cw && last.height === ch) ctx.drawImage(last, 0, 0);
    else if (!missing) {
      if (last.width !== cw || last.height !== ch) {
        last.width = cw;
        last.height = ch;
      }
      last.getContext('2d')!.drawImage(this.canvas, 0, 0);
    }

    for (const track of project.tracks) if (track.kind === 'text' && !track.hidden) this.drawText(track, t, cw, ch, project);
    for (const f of fronts) {
      ctx.save();
      ctx.globalAlpha = f.alpha;
      ctx.drawImage(f.canvas, f.slide * cw, 0);
      ctx.restore();
    }
  }

  private drawText(track: Track, t: number, cw: number, ch: number, project: Project) {
    const userStyles = this.get().userStyles;
    for (const c of track.clips) {
      if (t < c.start || t >= end(c)) continue;
      if (c.graphic) {
        drawGraphic(this.ctx, c.graphic, t - c.start, end(c) - c.start, project.canvas.w, project.canvas.h, cw, ch, this.lastVideo);
        continue;
      }
      if (!c.text) continue;
      drawCaption(this.ctx, { text: c.text, words: c.words, keyword: c.keyword, x: c.x, y: c.y, size: c.size, lines: c.lines }, styleOf(c, project, userStyles), t - c.start, end(c) - c.start, cw, ch);
    }
  }
}
