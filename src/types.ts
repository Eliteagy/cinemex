// Cinemex project model. Saved as readable JSON (.ecproj). Times are in seconds.

export interface Word {
  w: string;
  s: number;
  e: number;
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface Media {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  thumb?: string | null;
  /** Word-level transcript of the whole file (source time), cached after the first transcription. */
  transcript?: Word[];
  /** Options the transcript was made with (model|language|task|prompt); a change transcribes again. */
  transcriptKey?: string;
  /** Audio peaks, 100 per second, 0-255, base64 (waveform). */
  peaks?: string;
}

/** fade, slide (existing) and whip, zoom, spin, flash, dip, blur (src/lib/fx.js). */
export type TransitionType = 'fade' | 'slide' | 'whip' | 'zoom' | 'spin' | 'flash' | 'dip' | 'blur' | 'bflash';
export interface Transition {
  type: TransitionType;
  /** Seconds on the timeline. */
  d: number;
}

/** Interpolation of the segment that starts at a keyframe (src/lib/anim.js), like After Effects. */
export type Ease = 'smooth' | 'linear' | 'hold' | 'easy' | 'easy_in' | 'easy_out' | 'apple' | 'apple_out' | 'apple_pop' | 'bezier';
/** A keyframe: t is seconds from the clip start (timeline), v the value. */
export interface Keyframe {
  t: number;
  v: number;
  /** How the value travels to the next keyframe (default smooth). */
  ease?: Ease;
  /** ease 'bezier': cubic-bezier [x1, y1, x2, y2] (AE graph editor / CSS). */
  bz?: [number, number, number, number];
}

/** Expression-like modifier of an animated property (AE wiggle, loopOut, overshoot). */
export type Modifier =
  | { type: 'wiggle'; freq: number; amp: number; seed?: string }
  | { type: 'loop'; mode: 'cycle' | 'pingpong' }
  | { type: 'overshoot'; amp: number; freq: number; decay: number };

/** Blend mode of a clip over what is underneath (AE layer modes). */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'lighten' | 'darken' | 'difference';

/** Track matte (AE): the clip shows only inside a text, or inside the alpha/brightness of a media file. */
export type Matte =
  | { kind: 'text'; text: string; font?: string; size?: number; x?: number; y?: number; invert?: boolean }
  | { kind: 'media'; mediaId: string; mode: 'alpha' | 'luma'; invert?: boolean };

/** Layer effects (AE effect stack). Lengths are fractions of the frame's shorter side; colours #RRGGBB. */
export type Effect =
  | { id: string; type: 'shadow'; color: string; opacity: number; distance: number; angle: number; softness: number }
  | { id: string; type: 'glow'; radius: number; intensity: number }
  | { id: string; type: 'sweep'; color: string; angle: number; width: number; intensity: number; start: number; duration: number }
  | { id: string; type: 'gradient'; c0: string; c1: string; x0: number; y0: number; x1: number; y1: number; opacity: number };
/** rotate in degrees (-180..180), opacity 0..1. */
export type KeyProp = 'zoom' | 'x' | 'y' | 'rotate' | 'opacity' | 'scale' | 'px' | 'py';

/** Colour grade of a clip. All sliders -1..1 (0 = untouched); vignette 0..1. */
export interface Grade {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  vignette?: number;
  /** Path of a .cube LUT applied after the sliders (export only). */
  lut?: string;
}

/** Mask (like Premiere's): a shape on the frame that limits an effect, or cuts the clip out. */
/** front = this part of the clip is drawn again over the captions (captions go behind it). */
export type MaskMode = 'cut' | 'blur' | 'pixelate' | 'darken' | 'front';
export interface Mask {
  id: string;
  /** ellipse / rect; pen = drawn shape (points); person = the person cut out by the matte engine. */
  shape: 'ellipse' | 'rect' | 'pen' | 'person';
  /** pen: corners of the drawn shape, fractions of the frame, closed. */
  points?: [number, number][];
  /** person: grey matte video (white = person) for the source range [in, out], made by engine/matte.py; px/py = where the Gui clicked. */
  matte?: { file: string; in: number; out: number; px: number; py: number };
  /** Centre and size as fractions of the frame (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Soft edge, fraction of the frame's shorter side (0..0.2). */
  feather: number;
  invert: boolean;
  mode: MaskMode;
  /** Strength of blur/pixelate/darken, 0..1. */
  amount: number;
  /** Optional movement: centre at the clip's end (linear from x/y). */
  toX?: number;
  toY?: number;
}

/** Fusion (node compositing, like DaVinci's): nodes and the links between them. */
export type FNodeType = 'mediaIn' | 'mediaOut' | 'media' | 'background' | 'merge' | 'transform' | 'chroma' | 'blur' | 'glow' | 'color' | 'grain' | 'letterbox';
export interface FNode {
  id: string;
  type: FNodeType;
  /** Position in the node editor (pixels). */
  x: number;
  y: number;
  p: Record<string, number | string | boolean>;
}
/** Output of `from` goes into input number `port` of `to`. */
export interface FLink {
  from: string;
  to: string;
  port: number;
}
export interface Fusion {
  nodes: FNode[];
  links: FLink[];
}

export interface AudioSettings {
  /** Loudness normalisation for social media (-14 LUFS). */
  normalize?: boolean;
  /** Lower the music while someone speaks (sidechain). */
  duck?: boolean;
}
export type Keyframes = Partial<Record<KeyProp, Keyframe[]>>;

export type TrackKind = 'video' | 'text' | 'audio';

export interface Clip {
  id: string;
  mediaId?: string;
  /** Position on the timeline. */
  start: number;
  /** In/out points in the source (text clips: 0 and their duration). */
  in: number;
  out: number;
  volume?: number;
  fit?: 'fill' | 'fit';
  /** Source orientation, degrees counter-clockwise like Resolve's rotation (0, 90, 180, 270): footage shot sideways. Applied before framing. */
  orient?: 0 | 90 | 180 | 270;
  /** Playback speed (0.25-4). Timeline duration = (out - in) / speed. */
  speed?: number;
  transitionIn?: Transition | null;
  transitionOut?: Transition | null;
  /** Zoom (1 = framed, up to 4) and pan (x/y, -0.5..0.5 of the frame), animated. */
  keyframes?: Keyframes;
  /** Modifiers per animated property (wiggle, loop, overshoot). */
  mods?: Partial<Record<KeyProp, Modifier>>;
  /** Blend mode over the tracks underneath (default normal). */
  blend?: BlendMode;
  matte?: Matte;
  effects?: Effect[];
  /** Parent clip or null object (AE parenting): inherits its position, scale and rotation. */
  parent?: string;
  /** Null object (AE): invisible clip on a video track whose transform drives its children. */
  null?: boolean;
  /** Time remap (AE): keys of local timeline time t -> source time v (seconds); replaces speed. */
  remap?: Keyframe[];
  /** Motion blur (AE): shutter angle in degrees and samples per frame. */
  motionBlur?: { shutter: number; samples?: number };
  /** Text animator (AE range selector): letters or words come in one after the other. */
  textAnim?: TextAnim;
  color?: Grade;
  masks?: Mask[];
  fusion?: Fusion;
  text?: string;
  style?: string;
  /** Words relative to the clip start (captions with word highlight). */
  words?: Word[];
  /** Caption made by auto_captions (replaced when captions are generated again). */
  auto?: boolean;
  /** Keyword of an emphasis caption: index into its words, -1 = none, unset = automatic. */
  keyword?: number;
  /** This caption's own look over its style (src/lib/capstyle.js applyOverride). */
  override?: CaptionOverride;
  /** Felipe/Marta: each line moved on its own (base = top words, kw = keyword, rest = Marta's stack), fractions of the frame. */
  lines?: Partial<Record<'base' | 'kw' | 'rest', { x: number; y: number }>>;
  x?: number;
  y?: number;
  size?: number;
  /** Graphic (lower third, title, label, progress bar, Apple headline / reveal / glass card) instead of a caption (src/lib/graphics.js). */
  graphic?: Graphic;
}

/** Per-letter / per-word animator of a text clip. from = the look each unit starts with; it reaches the style in `dur` s, units `stagger` s apart; accel > 1 starts slowly (ASS 	 accel). */
export interface TextAnim {
  unit: 'char' | 'word';
  stagger: number;
  dur: number;
  accel?: number;
  from: { opacity?: number; scaleY?: number; blur?: number; color?: string };
}

export type GraphicKind = 'lower' | 'title' | 'label' | 'progress' | 'headline' | 'reveal' | 'glass';
export interface Graphic {
  kind: GraphicKind;
  title?: string;
  subtitle?: string;
  /** #RRGGBB: accent (bars, boxes), text colour and dark colour (boxes, text on accent). */
  accent?: string;
  color?: string;
  dark?: string;
  font?: string;
  /** Anchor, fractions of the frame. */
  x?: number;
  y?: number;
  scale?: number;
}

/** Timeline marker (all three editors have them); beats found in music are markers too. */
export interface Marker {
  id: string;
  t: number;
  label?: string;
  color?: string;
  beat?: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted?: boolean;
  hidden?: boolean;
  clips: Clip[];
}

export interface Canvas {
  w: number;
  h: number;
  fps: number;
  preset: CanvasPreset;
}

export type CanvasPreset = '9:16' | '16:9' | '1:1' | '4:5';

export interface Project {
  version: 1;
  name: string;
  canvas: Canvas;
  media: Media[];
  /** Render order: earlier tracks are drawn first (bottom). */
  tracks: Track[];
  /** The project's own caption style, used by clips with style 'custom'. */
  captionStyle?: CaptionStyle;
  /** Saved caption styles used by this project, embedded so it renders the same on another PC. */
  styles?: Record<string, CaptionStyle>;
  audio?: AudioSettings;
  markers?: Marker[];
}

/** Per-caption changes over its style. Colours #RRGGBB. */
export interface CaptionOverride {
  color?: string;
  /** Spoken-word colour; also the keyword colour of Felipe/Marta captions unless keywordColor is set. */
  highlight?: string;
  outlineColor?: string;
  font?: string;
  keywordColor?: string;
  keywordFont?: string;
  /** Felipe/Marta layout: 'stack' = keyword on its own line (the style's way), 'line' = every word on one line. */
  layout?: 'stack' | 'line';
  /** Space between the lines, times the style's own (0.3-3). */
  lineGap?: number;
  /** How the words / the keyword come in: reveal (left to right as spoken), rise (slide up), none (all at once). */
  textAnim?: 'reveal' | 'rise' | 'none';
  keywordAnim?: 'reveal' | 'rise' | 'none';
}

/** A font the caption font picker offers. */
export interface FontInfo {
  family: string;
  /** bundled with the app, installed for all users, or installed for this user only */
  source: 'app' | 'system' | 'user';
}

export interface CaptionStyle {
  label: string;
  font: string;
  size: number;
  color: string;
  highlight: string;
  outline: number;
  outlineColor: string;
  box: boolean;
  uppercase: boolean;
  y: number;
  /** Box colour (CSS) when box is on. */
  boxColor?: string;
  /** Effect: pop, fade, slide, words, bounce, karaoke, marker (src/engine/caption.ts). */
  anim?: CaptionAnim;
  /** Soft glow in the outline colour instead of a hard shadow. */
  glow?: boolean;
  /** Shadow offset (fraction of the frame height) and colour #RRGGBB. */
  shadow?: number;
  shadowColor?: string;
  /** Marker-pen colour of the spoken word (anim marker). */
  marker?: string;
  /** Letter spacing, fraction of the frame height. */
  spacing?: number;
  /** Keyword captions (Felipe, Marta): base words + one keyword in a second font (src/lib/emphasis.js). */
  emphasis?: Emphasis;
}

/** One text look inside an emphasis style. Lengths are fractions of the frame height. */
export interface TextLayer {
  font: string;
  /** libass font size (line height). */
  size: number;
  color: string;
  /** Vertical gradient: color at grad[0] to color2 at grad[1] (fractions of the line box, 0 = top). */
  color2?: string;
  grad?: [number, number];
  /** Fill opacity 0..1. */
  alpha?: number;
  /** Horizontal squeeze (0.75 = 75 % width). */
  squeezeX?: number;
  /** Letter spacing (negative = tighter). */
  tracking?: number;
  glow?: { color: string; alpha: number; blur: number };
  shadow?: { color: string; alpha: number; blur: number; x: number; y: number };
  /** reveal: letters appear left to right as each word is spoken; rise: the line rises in with blur. */
  anim?: 'reveal' | 'rise' | 'none';
  rise?: { dist: number; dur: number; blur: number };
  uppercase?: boolean;
}

export interface Emphasis {
  /** rows: lines stacked from the anchor (Felipe); slots: fixed places per role (Marta). */
  mode: 'rows' | 'slots';
  pitch?: number;
  /** Every word on one line (keyword inline in its own font) instead of stacked. */
  oneLine?: boolean;
  /** Draw the keyword over the base words (Felipe) instead of under them (Marta). */
  kwOnTop?: boolean;
  slots?: Partial<Record<'base' | 'kw' | 'rest', { dx: number; dy: number }>>;
  /** Grouping used by auto captions with this style. */
  maxWords?: number;
  maxChars?: number;
  base: TextLayer;
  keyword: TextLayer;
  rest?: TextLayer;
}

export type CaptionAnim = 'pop' | 'fade' | 'slide' | 'words' | 'bounce' | 'karaoke' | 'marker';

/** Transcription options (from AutoSubs): Whisper model, language ('auto' detects), translate to English, prompt. */
export interface TranscribeOptions {
  model?: string;
  language?: string;
  translate?: boolean;
  prompt?: string;
}

/** Grouping options (from AutoSubs): density or max characters per line, lines, case, punctuation, censored words. */
export interface CaptionOptions {
  style?: string;
  maxWords?: number;
  density?: 'single' | 'less' | 'standard' | 'more' | 'custom';
  maxChars?: number;
  maxLines?: number;
  textCase?: 'none' | 'lower' | 'upper' | 'title';
  stripPunct?: boolean;
  censor?: string[];
}

/** The model behind the chat panel. */
export type AiProvider = 'claude' | 'gemini' | 'gpt';

export type ClaudeEvent = { runId: number } & (
  | { type: 'init'; sessionId: string; model: string; mcp: string; tools: number }
  | { type: 'text'; delta: string; messageId: string | null }
  | { type: 'tool'; id: string; name: string; tool: string; area: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; ok: boolean }
  | { type: 'done'; ok: boolean; text?: string; sawText?: boolean; error?: string; code?: string; costUsd?: number; turns?: number }
  | { type: 'exit' }
);

export interface EcBridge {
  importDialog(): Promise<{ media: Media[]; errors: string[] }>;
  pathForFile(file: File): string;
  importPaths(paths: string[]): Promise<{ media: Media[]; errors: string[] }>;
  allowMedia(paths: string[]): Promise<boolean>;
  transcribe(file: string, opts?: TranscribeOptions): Promise<{ language: string; model: string; words: Word[] }>;
  userFont(name: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Fonts installed on this PC (system and per-user folders), cached. */
  listFonts(): Promise<{ family: string; user: boolean; upem: number; a: number; d: number }[]>;
  /** Bytes of an installed font family (regular face), for the preview. */
  fontFile(family: string): Promise<Uint8Array<ArrayBuffer> | null>;
  listCaptionStyles(): Promise<Record<string, CaptionStyle>>;
  saveCaptionStyle(id: string | null, style: CaptionStyle): Promise<{ id: string; style: CaptionStyle }>;
  deleteCaptionStyle(id: string): Promise<boolean>;
  captionClips(clip: Clip, words: Word[], opts: CaptionOptions): Promise<Omit<Clip, 'id'>[]>;
  /** Person matte for a clip's source range (x/y: keep only the person under that point). Resolves with the matte file. */
  matte(req: { id?: string; file: string; tin: number; tout: number; x?: number; y?: number }): Promise<string>;
  onMatteProgress(cb: (m: { id?: string; progress?: number; status?: string }) => void): () => void;
  exportVideo(project: Project, opts: { path?: string; gpu?: boolean; ask?: boolean; quality?: 'alta' | 'media' | 'leve' }): Promise<string | null>;
  cancelExport(): Promise<void>;
  onExportProgress(cb: (p: number) => void): () => void;
  saveProject(project: Project, file?: string | null): Promise<string | null>;
  openProject(file?: string): Promise<{ project: Project; path: string } | null>;
  capcutList(): Promise<{ name: string; file: string; modified: number; duration: number }[]>;
  capcutImport(file?: string | null): Promise<{ project: Project; warnings: string[] } | null>;
  peaks(file: string): Promise<string | null>;
  saveText(name: string, content: string, ext: string): Promise<string | null>;
  openText(ext: string): Promise<{ path: string; content: string } | null>;
  pickLut(): Promise<string | null>;
  writeSrt(file: string, content: string): Promise<string>;
  readSrt(file: string): Promise<string>;
  reveal(file: string): Promise<void>;
  mcpInfo(): Promise<{ url: string }>;
  /** Claude chat (local Claude Code CLI driving the editor's own MCP). */
  claudeStatus(who?: AiProvider): Promise<{ installed: boolean; running: boolean }>;
  claudeSend(projectKey: string, text: string, who?: AiProvider): Promise<{ runId: number }>;
  claudeCancel(who?: AiProvider): Promise<boolean>;
  claudeReset(projectKey: string, who?: AiProvider): Promise<boolean>;
  onClaudeEvent(cb: (ev: ClaudeEvent) => void): () => void;
  /** Built-in sound effects (made on first use in the app's data folder). */
  sfxList(): Promise<{ id: string; label: string; path: string; duration: number }[]>;
  /** A still of one frame of a video (PNG in the app's data folder) for freeze frames. */
  freezeFrame(file: string, time: number): Promise<string>;
  onMcpCall(handler: (name: string, args: Record<string, unknown>) => Promise<unknown>): () => void;
  /** Ligação: live link with the other computer (see electron/collab.cjs). */
  collabGet(): Promise<CollabView>;
  collabSet(patch: { name?: string; relayUrl?: string; autoConnect?: boolean; sharedRoot?: null }): Promise<CollabView>;
  collabPickFolder(): Promise<CollabView>;
  collabMakeFolder(): Promise<CollabView>;
  collabNewCode(): Promise<string>;
  collabGetCode(): Promise<string | null>;
  /** The invite link to send to the other person (creates the code the first time). */
  collabInvite(): Promise<string>;
  collabUseLink(link: string): Promise<CollabView>;
  onCollabOpen(cb: () => void): () => void;
  collabSetCode(code: string | null): Promise<CollabView>;
  collabConnect(): Promise<CollabView>;
  collabDisconnect(): Promise<CollabView>;
  collabSend(msg: CollabOut): Promise<boolean>;
  onCollabStatus(cb: (s: CollabStatus) => void): () => void;
  onCollabMessage(cb: (m: CollabIn) => void): () => void;
  updateInfo(opts?: { fetch?: boolean }): Promise<UpdateInfo>;
  updateApply(): Promise<{ changed: boolean; from?: string; to?: string }>;
  onUpdateStep(cb: (step: string) => void): () => void;
  relaunch(): Promise<void>;
}

export interface CollabStatus {
  state: 'off' | 'connecting' | 'online' | 'error';
  error: string | null;
  me: string | null;
  peers: string[];
}
export interface CollabView {
  config: { relayUrl: string; name: string; sharedRoot: string | null; autoConnect: boolean };
  hasCode: boolean;
  sharedRoot: string | null;
  googleDrive: string | null;
  os: string;
  defaultName: string;
  status: CollabStatus;
}
export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
}
export type UpdateInfo =
  | { git: false }
  | { git: true; local: CommitInfo | null; remote: CommitInfo | null; behind: number; ahead: number; dirty: boolean; fetched: boolean; fetchError: string | null };

/** What one Cinemex tells the others about itself. */
export interface PeerHello {
  name: string;
  os: string;
  version: string | null;
  session: { id: string; name: string } | null;
}
/** Where the other person is looking: drawn on the timeline in their colour. */
export interface PeerPresence {
  session: string | null;
  playhead: number;
  selected: string | null;
  page: string;
  playing: boolean;
}
export type CollabOut =
  | ({ kind: 'hello'; reply?: boolean } & PeerHello)
  | ({ kind: 'presence' } & PeerPresence)
  | { kind: 'op'; session: string; op: import('./lib/collab').ProjectOp }
  | { kind: 'snapshot'; session: string; name: string; project: Project; to?: string }
  | { kind: 'want'; session: string }
  | { kind: 'stop'; session: string };
export type CollabIn = (CollabOut & { from: string }) | { kind: 'join'; peer: string; from?: string } | { kind: 'leave'; peer: string; from?: string };

declare global {
  interface Window {
    ec: EcBridge;
  }
}
