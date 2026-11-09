// Waveform of a clip's audio, drawn from the media peaks (100 per second), following in/out
// and speed. Redrawn only when the clip, zoom or size change.
import { useEffect, useRef } from 'react';
import { decodePeaks, speedOf } from '../lib/project';
import type { Clip } from '../types';

export function Wave({ peaks, clip, width, height, color }: { peaks: string; clip: Clip; width: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || width < 2) return;
    const w = Math.min(Math.round(width), 8000);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = color;
    const data = decodePeaks(peaks);
    let loud = 0;
    for (let i = 0; i < data.length; i++) if (data[i]! > loud) loud = data[i]!;
    const norm = 255 / Math.max(48, loud);
    const sp = speedOf(clip);
    const total = (clip.out - clip.in) / sp;
    const mid = height / 2;
    for (let x = 0; x < w; x += 2) {
      const a = clip.in + (x / w) * total * sp;
      const b = clip.in + ((x + 2) / w) * total * sp;
      let m = 0;
      for (let i = Math.floor(a * 100); i <= Math.ceil(b * 100) && i < data.length; i++) if (i >= 0 && data[i]! > m) m = data[i]!;
      const h = Math.max(1, Math.min(1, (m * norm) / 255) * (height - 2));
      ctx.fillRect(x, mid - h / 2, 1.4, h);
    }
  }, [peaks, clip.in, clip.out, clip.speed, width, height, color]);
  return <canvas ref={ref} className="wavec" style={{ width: Math.min(width, 8000), height }} aria-hidden="true" />;
}
