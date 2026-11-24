// Safe-zone guides on the viewer (never in the export): the parts of a 9:16 video that Instagram,
// TikTok or YouTube cover with their own buttons, names and captions.
import { useEditor } from '../store';
import { SAFE_ZONES } from '../lib/autoedit.js';

export function SafeZoneOverlay({ width, height }: { width: number; height: number }) {
  const zone = useEditor((s) => s.safeZone);
  if (!zone || !width) return null;
  const z = SAFE_ZONES[zone];
  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="safe" style={{ width, height }} aria-hidden="true">
      <i className="safe-cover" style={{ left: 0, right: 0, top: 0, height: pct(z.top) }} />
      <i className="safe-cover" style={{ left: 0, right: 0, bottom: 0, height: pct(z.bottom) }} />
      <i className="safe-cover" style={{ right: 0, top: pct(z.top), bottom: pct(z.bottom), width: pct(z.right) }} />
      <i className="safe-cover" style={{ left: 0, top: pct(z.top), bottom: pct(z.bottom), width: pct(z.left) }} />
      <div className="safe-box" style={{ left: pct(z.left), right: pct(z.right), top: pct(z.top), bottom: pct(z.bottom) }}>
        <span>{z.label} · área segura</span>
      </div>
    </div>
  );
}
