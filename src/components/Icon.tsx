// Small line icons (own drawings, 24x24 grid, 1.75 stroke).
const P: Record<string, string> = {
  play: 'M7 5.5v13l11-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  start: 'M6 5v14M18 6l-9 6 9 6z',
  end: 'M18 5v14M6 6l9 6-9 6z',
  split: 'M12 3v18M7 8l-3 4 3 4M17 8l3 4-3 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  text: 'M5 6h14M12 6v13M9 19h6',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  export: 'M12 16V4M7 9l5-5 5 5M5 14v6h14v-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.3 7.6A17 17 0 0 0 2 12s4 7 10 7a9.4 9.4 0 0 0 4.4-1.1',
  sound: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6',
  captions: 'M3 6h18v12H3zM7 11h4M7 14h7M14 11h3',
  scissors: 'M6 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 22a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 6l12 12M8 18 20 6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  plus: 'M12 5v14M5 12h14',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  close: 'M6 6l12 12M18 6 6 18',
  nodes: 'M3 5h6v5H3zM15 14h6v5h-6zM9 7.5h2a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2',
  color: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01M17 11.5h.01',
};

export function Icon({ name, className = 'icon' }: { name: keyof typeof P | string; className?: string }) {
  const d = P[name] ?? '';
  const filled = name === 'play' || name === 'pause' || name === 'start' || name === 'end' || name === 'stop';
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
