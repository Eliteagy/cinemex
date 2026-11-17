# VideoCraft (dosmoon/VideoCraft) — reverse-engineering report

Clone: `scratchpad\re\src\VideoCraft` (depth 1, HEAD `d93c639` "docs(task): record v0.3.11 release"). Nothing installed, built or run.
All paths below are relative to the repo root. "GUESS" marks inference not verified in code.

## 1. What it is

A Windows desktop "program generator where the editor is AI" (README.markdown:3-4). Not a general NLE: one project = one source video (YouTube link via yt-dlp or a local file) → subtitles (ASR / import / LLM translate / QC) → AI analysis (titles, chapters, hot clips) → two "creations":

- **Clip** — batch-cut vertical short videos from AI-mined "hotclips", each with burned subtitles, hook card, outro card, watermarks, optional TTS dub, plus a publish caption (.md) with title/transcript/hashtags.
- **News Desk** — the full-length video with bilingual subtitles, chapter topic strip + chapter hero cards, watermarks, optional dub, per-chapter split, MP3 extract, and a publish doc (YouTube description with chapters).

Author "OldApeTalk", MIT, v0.3.11 (desktop/package.json:3). Chinese-first product, zh/en UI.

## 2. Stack

| Layer | Tech | Where |
|---|---|---|
| Shell | Electron ^42.3, electron-vite, electron-builder NSIS | desktop/package.json |
| UI | React 19 + TS, lucide-react, @uiw/react-color-sketch; **no state library** (plain React state) | desktop/src/renderer |
| Video engine | **WebGPU** compositor + **WebCodecs** decode (mp4box demux) + encode (mp4-muxer) or raw frames piped to **ffmpeg h264_nvenc** | desktop/src/renderer/engine |
| Sidecar | Python 3.12, FastAPI HTTP JSON-RPC + SSE on 127.0.0.1 ephemeral port, PyInstaller onedir, uv | core_rpc/, src/core/, ADR-0010 |
| AI | Gemini SDK, OpenAI-compatible (DeepSeek, xAI Grok, Custom, aistack), `claude -p` CLI, llama.cpp, faster-whisper, LemonFox, edge-tts, Fish Audio, aistack Qwen3-TTS | src/core/ai |
| Docs site | Astro (site/) | site/ |

## 3. Architecture

```
Electron main (desktop/electron/main.ts)  — window, menu, vc:* IPC (fs read/write/list, pickers,
   vc-media:// range-serving protocol, ffmpeg encode jobs, splitChapters, extractMp3)
Renderer (desktop/src)                    — ALL plugin logic in TS (ADR-0008):
   composition/   OTIO-style timeline IR + component library + crop math + TimeMap
   creations/     clip, news_desk (assemble → Timeline, render orchestration, publish.md, presets)
   materials/     news_video (material model, AI news-context prompt/schema)
   renderer/engine  WebGPU compositor, WebCodecs readers, export sinks, audio mix
Python sidecar (core_rpc/ + src/core)     — plugin-agnostic capability gateway:
   capability.asr/translate/analyze/tts_dub/llm_extract/subtitle_check/acquire_source,
   ai.*, models.*, gpu.*, env.*, project.*   (core_rpc/methods/*.py)
```

- Transport: FastAPI `/rpc` (one request at a time behind `dispatch_lock`), `/events` SSE for job progress, `/shutdown` (core_rpc/server.py:170-215). Port announced on stdout handshake (desktop/electron/sidecar.ts:138).
- Principle "preview ≡ render": export reuses the same `prepareFrame` as preview (desktop/src/renderer/engine/export/encode.ts:1-10; docs/design/00-overview.md:76).
- "Snapshot principle": a creation copies upstream hotclips/SRT into its own folder on first access and never re-syncs (desktop/src/creations/clip/hotclipsRepo.ts:1-45; ADR-0003).

## 4. Data model

**Project** = folder with `.videocraft/project.json` (docs/design/00-overview.md:50). Materials and creations are componentized subdirectories (ADR-0005). Subtitle artifacts sit flat in `subtitles/` as `<iso>.srt`, `<iso>.analysis.json`, `<iso>.transcript.md`, `<iso>.chapter_transcript.md`, `<iso>.hotclips.json`, `<iso>.dub.json` + `<iso>.dub.mp3` (src/core/subtitle_analysis.py:50-59).

**Timeline IR** (desktop/src/composition/ir.ts):
- `Timeline { durationSec, tracks[] }`; `Track { kind: video|audio|overlay, z, enabled, children[] }` (ir.ts:91-107).
- Children are `Clip | Gap | Transition` (ir.ts:45-89). **Relative positioning**: items store only duration; absolute start is derived (ir.ts:22-24, 154-172). Transition has `inOffsetSec/outOffsetSec` and overlaps neighbours, shortening the track (ir.ts:75-87, 174-185).
- `Clip { kind, durationSec, sourceStart?, mediaRef?, crop?: {x,y,w,h normalized}, style, data }` — style is inlined at compile time (ir.ts:45-67).
- `validateTimeline` enforces 7 invariants (catalog kinds, source bounds, transition placement, duration consistency, crop rect in [0,1]) and returns all issues (ir.ts:234-354).

**TimeMap** (desktop/src/composition/timemap.ts:1-40): derived from the assembled video track; maps source↔output time so source-anchored content (SRT cues, chapter rows) is cut and rippled to match edits (null where cut).

**Analysis envelope** `<iso>.analysis.json` schema_version 2: `titles[]`, `chapters[{start,start_sec,end,end_sec,title,refined,key_points[]}]`; normalization forces sorted, contiguous chapters starting at 00:00:00 (YouTube rule) (src/core/chapters_io.py:1-40).

**Hotclip** entry: `start, end, duration_sec, hook, outro, why_viral, score 1-10, suggested_title, suggested_hashtags[], transcript` (src/core/subtitle_analysis_runners.py:290-314; desktop/src/creations/clip/types.ts:101-114). Per-clip user override: start/end, hook/outro text, title, hashtags, crop_rect (types.ts:125-133).

**Clip components** (types.ts:18-98): `clip_subtitle`, `clip_text_watermark`, `clip_image_watermark`, `clip_hook_card`, `clip_outro_card`, `clip_dubbing`; list order = z-order (assemble.ts:140-142). Field edit UI is data-driven by `FieldSpec[]` per component (composition/components/fieldSpec.ts; ADR-0007).

## 5. Features and how they work

### 5.1 Source acquisition
- yt-dlp download with height/codec format selector, merge to mp4 (src/core/source_acquire.py:290-345); optional time range done by a post-download ffmpeg `-ss … -t … -c copy` cut, not yt-dlp ranges (source_acquire.py:212, 335, 541-550). Errors categorised (network, url_invalid, js_runtime, cookies, disk, ffmpeg) for recovery hints (source_acquire.py:35-40, 416-417).
- Platform metadata (uploader, description, tags) captured and fed to the AI news-context prompt (src/core/prompts.py:162-181).

### 5.2 ASR
- Default provider faster-whisper (CTranslate2, auto cuda/fp16 else cpu/int8, silero VAD, `word_timestamps: True`) (src/core/ai/config.py:178-200, 245-251). Alternatives: LemonFox cloud Whisper, aistack local gateway (whisper/parakeet/sensevoice) (config.py:155-176).
- **Sentence regrouping** of word-level output (port of stable-ts chain): split on terminal punctuation skipping false terminators (Mr., U.S., 3.14, ellipsis, lowercase-next), then gaps ≥0.5 s, then commas once ≥50 chars, then hard cap 70 chars; CJK-aware joins (src/core/sentence_regroup.py:1-41, 64-87, 97-176, 273-287).

### 5.3 Translation (LLM)
- Batches of 100 cues, each prefixed `【n】`, JSON-schema response with `index`; mismatched counts logged and matched by index (src/core/translate.py:60-213; prompts/translate.md). Any language pair (not Whisper's EN-only translate).

### 5.4 Subtitle QC + auto-fix
- `check_srt`: parse errors, empty cues, timing, overlap (200 ms tolerance), cue-count mismatch vs reference SRT, length ratio vs reference (0.2–5×), LLM format residue (`【N】`, `<|im_end|>`, "assistant:"), duplicate runs (≥3), language purity by Unicode-block ratio (src/core/subtitle_check.py:1-23, 64-77, 185-244). Issues classed hard / fixable / advisory (subtitle_check.py:64-66, 127).
- `apply_auto_fixes` = `clean_residue` on every cue (subtitle_check.py:169, 398-410). Exposed as `capability.subtitle_check` / `capability.subtitle_quick_fix`.
- SRT "quality fingerprint" (cue count, avg duration, punctuation ratio, ALL-CAPS ratio, speaker/sound tags, reading rate) without scoring (src/core/srt_quality.py:1-20).

### 5.5 AI analysis "pack" (titles + chapters + summaries + key points)
- One LLM call returns `titles` (1–3), YouTube-style `segments` with HH:MM:SS, per-segment `refined` (≤128 zh chars / ≤80 words) and `key_points` (src/core/prompts.py:128-160; runner src/core/subtitle_analysis_runners.py:90-141). Output language forced to the subtitle language via `{output_language}` (prompts.py:350-369).
- Optional "context block" (news context, see 5.7) prepended to every analysis prompt (subtitle_analysis_runners.py:95-116).
- Derived non-AI artifacts: full transcript .md and per-chapter transcript .md with summary, key points, candidate titles (subtitle_analysis_runners.py:146-275).

### 5.6 Hot-clip mining (core feature)
- `run_hotclips(strategy=auto|per_chapter|full, desired_count=10, target 30–90 s)`: transcript rendered as `[HH:MM:SS] text` lines; when chapters exist each chapter is a separate prompt window with budget `max(3, desired//chapters+1)`; results merged and sorted by start (subtitle_analysis_runners.py:278-480).
- Prompt asks for self-contained clips with strong opening (contrarian / suspense / strong opinion / data contrast / emotion), hook ≤30 chars, outro CTA ≤25 chars (explicitly no generic "follow/like"), why_viral, score, title, 3–5 hashtags (src/core/prompts.py:259-292).
- **Anti-hallucination**: transcript is NOT requested from the model; it is sliced from the real SRT after the call (subtitle_analysis_runners.py:287-289, 335-349, 457-464). JSON schema validated (290-314). Task `subtitle.post`, tier premium (369-373).

### 5.7 AI news context (web-search grounded)
- 15-field event dossier (host, host_bio, affiliation, guests, event_date/time/location, show_type, topic, summary, key_points, background, audience, platform_tone, notes) produced from URL + yt-dlp metadata + user hints, with instructions to web-search and correct the user's hints (src/core/prompts.py:162-257; desktop/src/materials/news_video/aiFill.ts:1-60).
- Routed to task `news.realtime`: xAI Grok (native search) or Claude Code CLI with `--tools WebSearch` (src/core/ai/config.py:51-73, 238-245; src/core/ai/providers/claude_code.py:30-50, 107-115). Note in code: `--json-schema` disables WebSearch, so the search path enforces schema by prompt only (claude_code.py:11-16).
- Filled context is rendered as a labelled markdown prefix for downstream prompts (aiFill.ts CONTEXT_BLOCK_LABELS).

### 5.8 TTS dubbing with timestamp fitting
- Per cue: synthesize at 1.0, measure; budget = gap until next cue start (not just cue end); if too long speed up to fit, capped at `max_speed` 1.5; edge-tts re-synthesizes at the rate (no pitch artefacts), other engines use ffmpeg `atempo`; if still too long, overflow (never truncate) (src/core/tts_dubbing.py:1-28, 46-88, 109-186).
- Output: full-length `<iso>.dub.mp3` aligned to source + `<iso>.dub.json` manifest with per-cue natural/speed/placed/overflowed, versioned by provider+voice (tts_dubbing.py:218-327).
- Engines: edge-tts default (no key, 100+ zh voices), Fish Audio (voice cloning), aistack Qwen3-TTS (config.py:205-243). Voice picker UI (desktop/src/renderer/ui/voicePicker.tsx).
- In a creation: `replace` original audio or `mix` (dub at gain_db, original ducked to source_gain_db), plus offset (desktop/src/composition/components/dubbing.ts:11-45; desktop/src/creations/clip/assemble.ts:147-187).

### 5.9 Clip creation (batch shorts)
- `buildClipTimeline`: one video clip windowed to the candidate (+ optional crop), audio track(s), overlay tracks from components in z-order (desktop/src/creations/clip/assemble.ts:59-145).
- **Reframe modes**: `reframe` (draggable output-aspect crop window, cover), `letterbox` (whole source with bars, contain — for side-by-side speakers), `passthrough` (desktop/src/composition/crop.ts:21-34). `centerCropRect` default; `clampCropRect` keeps aspect and bounds while dragging (crop.ts:79-117); target dims at a 1080-class short edge, even numbers (crop.ts:55-68). Crop editor UI: desktop/src/renderer/workbenches/clip/CropPreview.tsx (619 lines).
- **Hook/outro cards**: text card at start/end for `duration_sec`, positions upper-third/center/lower-third, bg+opacity, stroke, padding (desktop/src/composition/components/card.ts:1-60). Text comes from AI hook/outro unless overridden (assemble.ts:100-101).
- **Subtitle stacking**: multiple subtitle components (e.g. bilingual) sharing an edge have margins stacked so they don't overlap (assemble.ts:103-113; mapping.ts `stackSubtitleMargins`).
- **One-line subtitle invariant**: a cue that would overflow width is split into time-sequential sub-cues; max chars = (W/H)·0.92 / (fontsizePct·ratio), ratio 1.0 CJK / 0.55 Latin, script auto-detected from content, breaks at punctuation (desktop/src/composition/subtitleWrap.ts:1-60; ADR-0002).
- **Render orchestration**: per-candidate files `clip_NNN_<sanitized hook>.mp4`, sidecar JSON per clip, stale-file cleanup, persisted rendered[] state (desktop/src/creations/clip/render.ts:1-47, 109-230).
- **Publish docs**: per clip `clip_NNN.md` (title, duration, score, hook, copy-paste caption = title + transcript + hashtags for X/TikTok, outro CTA, why viral) and an `index.md` table (desktop/src/creations/clip/publish.ts:1-60).
- **Presets**: global `clip_preset.json` with components + output (aspect, short_edge, mode) + encode preset; built-in "Default 9:16" re-injected (desktop/src/creations/clip/presets.ts:1-40).

### 5.10 News Desk creation
- Full-source timeline, identity TimeMap; subtitles per SRT (bilingual = two subtitle components), chapter component emits two overlay tracks (desktop/src/creations/news_desk/assemble.ts:1-40).
- **Chapter component**: `top_strip` topic bar spanning each chapter, `start_card` hero card (title + refined + key points, accent colour) for the first N seconds of each chapter (desktop/src/composition/components/chapter.ts:1-60). Chapter schedule editor UI (desktop/src/renderer/workbenches/material/ChapterScheduleEditor.tsx).
- **Split by chapter**: ffmpeg `-ss -i -t -c copy -avoid_negative_ts make_zero +faststart` per chapter, `.part` → rename (desktop/electron/ffmpeg.ts:245-285). **Extract MP3** (ffmpeg.ts:287+).
- **Publish doc** with context fields, chapter list (YouTube description) and per-chapter transcript detail (desktop/src/creations/news_desk/publish.ts:1-40, 95-140).

### 5.11 Watermarks
- Text watermark (text, size, colour, opacity) and image watermark (path, scale, opacity), corner anchor + x/y margins as frame fractions, full-duration overlay (desktop/src/composition/components/watermark.ts:1-60).

### 5.12 Render / export engine
- Decode: mp4box demux + WebCodecs VideoDecoder, frame ring buffer (desktop/src/renderer/engine/source/*). Compositing on WebGPU (gpu/Backend.ts, pipelines/videoFrame.ts crop sampling, overlayTexture.ts); overlays drawn on Canvas2D then uploaded (overlay/canvas2d.ts).
- Two sinks: WebCodecs H.264 software + mp4-muxer, streamed to disk in 16 MiB chunks (export/webcodecsSink.ts:1-40; encode.ts:48-58), or **GPU readback → raw BGRA piped to ffmpeg h264_nvenc** (fallback libx264), audio pulled from source with `-ss` (export/ffmpegSink.ts:1-40; desktop/electron/ffmpeg.ts:67-114). NVENC availability probed by a 1-frame test encode (ffmpeg.ts:67-90).
- Export settings: engine auto/chromium/ffmpeg, resolution presets, fps 24–60, bitrate auto/Mbps (desktop/src/creations/exportSettings.ts:1-40). Audio mix 48 kHz AAC 192k with linear resample (webcodecsSink.ts:20-23; export/audioMix.ts).

### 5.13 Python video tools (sidecar)
- Split modes FAST (stream copy), KEYFRAME_SNAP (ffprobe I-frames, snap start to keyframe ≤ target, cached per path+mtime), ACCURATE (re-encode) (src/core/video_split.py:1-40). Merge of non-contiguous segments via re-encode + concat demuxer (src/core/video_concat.py:1-15). GUESS: no current UI exposes split workbench (docstrings reference retired Tk tools).

### 5.14 AI router / console / model manager
- Per-task (provider, model) matrix; empty cell = auto-fallback through priority-ordered candidates (src/core/ai/router.py:672-737; config.py:254-290). Tasks: translate, subtitle.post, news.realtime, asr.transcribe (config.py:238-245).
- Call log JSONL (request shape, response preview, citations, usage, latency), rotates at 2000 lines (src/core/ai/call_log.py:1-25). AI Console UI (desktop/src/renderer/aiconsole/AiConsole.tsx).
- Prompts are editable .md files with built-in defaults and reset (src/core/prompts.py:1-23, 315-397).
- Model manager: HF downloads with hf-mirror.com option, GPU (CUDA wheels) install, embedded llama.cpp/faster-whisper install (src/core/models/*, src/core/gpu_install.py, src/core/embedded_ai_install.py:30-40).

## 6. AI / LLM integrations

| Purpose | Provider | Models / endpoint | Code |
|---|---|---|---|
| LLM | Gemini (google-genai SDK, native `response_schema`) | gemini-2.5-pro / flash / flash-lite | ai/config.py:21-37; providers/gemini.py:31-45 |
| LLM | DeepSeek (OpenAI-compat) | deepseek-reasoner / deepseek-chat, api.deepseek.com | config.py:38-51 |
| LLM + web search | xAI Grok (OpenAI-compat) | grok-4 / grok-4-fast, api.x.ai/v1 | config.py:52-73 |
| LLM (+ WebSearch) | Claude Code CLI `claude -p --output-format json --permission-mode bypassPermissions [--effort low] [--tools WebSearch]`, prompt on stdin | opus / sonnet / haiku | config.py:86-104; providers/claude_code.py:36-341 |
| LLM | Custom OpenAI-compatible; aistack gateway 127.0.0.1:11500/v1; llama.cpp in-process GGUF (Qwen from HF) | user-picked | config.py:74-85, 105-136; providers/llama_cpp.py:97 |
| ASR | faster-whisper (default small), LemonFox API, aistack | whisper tiny…large-v3-turbo, parakeet, sensevoice | config.py:155-200 |
| TTS | edge-tts (default, zh-CN-YunxiNeural), Fish Audio, aistack Qwen3-TTS 0.6B | — | config.py:205-243 |

No Anthropic API SDK; Claude is only used via the local CLI.

## 7. Security review of the repo

No malicious code found.
- No npm lifecycle scripts (postinstall/preinstall/prepare) in desktop/package.json or site/package.json; pnpm `onlyBuiltDependencies` limited to electron, esbuild.
- No eval / new Function / base64 blobs / obfuscation. Subprocess use is ffmpeg/ffprobe/yt-dlp/nvidia-smi/explorer/claude CLI only.
- Network endpoints are all expected: provider APIs, huggingface.co / hf-mirror.com, nodejs.org (SHA256-verified, env/node_manager.py:73-131), abetlen.github.io wheel index, gyan.dev / GitHub for ffmpeg. No telemetry found.
- `src/__pycache__/*.cpython-312.pyc` (4 files) are committed leftovers of an early prototype (yt_dlp download, whisper transcribe, googletrans translate, ffmpeg subtitle burn; strings show dev path `D:\My_Prjs\VideoCraft\src\...`). Their .py sources are absent, so Python never imports them. Benign.

Weak spots in VideoCraft itself (do NOT copy into Cinemex):
1. **Sidecar RPC has no auth token, no Host/Origin check** (core_rpc/server.py:177-191; binds 127.0.0.1:0 at :264). `request.json()` parses any body, so a `text/plain` POST from a web page (no CORS preflight) is accepted if the port is found. `ai.update_provider` lets you set the ClaudeCode `executable` (whitelist includes it: src/core/ai/console_view.py:91, 229), which is later spawned (providers/claude_code.py:273). GUESS: drive-by local code execution is possible from a browser that scans for the port while VideoCraft runs.
2. Electron: `sandbox: false` (desktop/electron/main.ts:263-267), `disable-gpu-sandbox` (main.ts:175), automatic relaunch with `--no-sandbox` on some Win11 builds (main.ts:177-238); `setWindowOpenHandler` → `shell.openExternal(url)` with no scheme check (main.ts:278-279); `vc-media://local/<any absolute path>` serves any file and `vc:fs:*` IPC reads/writes any path (main.ts:298-370, 416-532).
3. Claude CLI run with `--permission-mode bypassPermissions` (claude_code.py:236-240); in the WebSearch path it fetches web content into a run that could act. GUESS: tools are restricted to WebSearch via `--tools`, which limits damage.
4. CI `fetch_ffmpeg.ps1` downloads ffmpeg without checksum; runtime `yt-dlp` is pip-upgraded unpinned.
5. Installer unsigned (README).

## 8. Cinemex comparison

Cinemex (read-only check of `Elite cinema\src`, `electron`): has 56 MCP tools (electron/mcp.cjs) incl. auto_captions (local Whisper word-level, Whisper translate to EN only), cut_silences, speed, transitions, keyframes, effects, masks/matte, Fusion nodes, graphics, SFX/auto_sfx, beats, markers, freeze, colour/LUT, canvas presets 9:16/16:9/1:1/4:5 (src/types.ts:258-270), set_crop, NVENC export (electron/render.cjs), CapCut import, chat agents via Claude/Codex/Gemini (electron/ai-providers.cjs).

Grep of src/ and electron/ found **no** hits for: hotclip/highlight mining (the "viral" hits are caption-style names), TTS/dub/voiceover, chapter, watermark, letterbox/reframe, yt-dlp/youtube, hashtag/publish, loudnorm/duck, lower-third/name plate, batch export.

Features VideoCraft has that Cinemex lacks:
1. AI hot-clip mining with score, hook, outro, why_viral, title, hashtags; transcript sliced from real SRT.
2. Batch export of N shorts from one long video (one timeline per candidate, file naming, sidecars).
3. Per-clip publish caption .md (title + transcript + hashtags) + index.
4. LLM subtitle translation to any language (batched, index-matched JSON).
5. TTS dubbing with slot-fitting speed-up, replace/mix + ducking, versioned dubs.
6. AI chapters (titles + summaries + key points), YouTube chapter description, chapter topic strip + hero cards, split-by-chapter export, MP3 extract.
7. Reframe/letterbox/passthrough output modes with draggable aspect-locked crop window (Cinemex has crop + canvas preset; GUESS: no contain/letterbox mode and no per-clip aspect-locked reframe UI).
8. Hook / outro text cards auto-filled from AI.
9. Text and image watermark components (corner + margin).
10. Subtitle QC (overlap, residue, duplicates, language purity, count/length mismatch vs reference) + auto-fix.
11. Sentence-level regrouping of Whisper words (stable-ts style) for SRT/translation-grade cues (Cinemex groups by max words for captions; GUESS: no sentence-grade SRT).
12. One-line subtitle fitting by aspect and script (CJK/Latin).
13. Stacked bilingual subtitle tracks (two languages on screen at once). GUESS: Cinemex captions are one language per clip.
14. Source download from URL via yt-dlp with time-range trim.
15. Web-search-grounded context dossier injected into all AI prompts.
16. Editable prompt files + per-task provider/model routing + AI call log.
17. Keyframe-snap / fast / accurate split modes.
18. Export presets (components + output + encode).

## 9. Top 10 to port into Cinemex (ranked)

| # | Feature | Effort | Where in Cinemex |
|---|---|---|---|
| 1 | **AI hot-clip mining** (prompt prompts.py:259-292 + schema runners.py:290-314, chapter-windowed, SRT-sliced transcript). Use the existing Media.transcript words as input; call Claude via the existing ai-providers.cjs. New MCP tool `find_hotclips`. | M | new `electron/hotclips.cjs`; tool in `electron/mcp.cjs` + `src/mcpHandler.ts`; UI panel `src/components/Hotclips.tsx`; store results on `Media` in `src/types.ts` |
| 2 | **Batch shorts export**: for each chosen candidate build a 9:16 project slice (cut window + captions + hook/outro + crop) and queue renders `clip_NNN_<hook>.mp4` | M | `src/actions.ts` (slice builder), `electron/render.cjs` (queue), `src/components/Deliver.tsx` |
| 3 | **Reframe modes** cover/letterbox/passthrough with aspect-locked draggable crop window (crop.ts:55-117 is pure and portable as-is) | S | `src/engine/` player draw + `electron/render.cjs` filter (crop+scale vs scale+pad); extend `set_crop` / `set_canvas` tools |
| 4 | **LLM translation of captions** to any language, batched with index markers (translate.py:60-213) + second caption track for bilingual stacking (assemble.ts:103-113) | M | `src/engine/caption.ts`, `src/components/AutoSubs.tsx`, new MCP tool `translate_captions` |
| 5 | **TTS dub with slot fitting** (tts_dubbing.py compute_speed/cue_budget logic) using ElevenLabs or edge-tts; output one aligned audio clip; replace/mix + ducking | M | new `electron/dub.cjs`; audio track in timeline; `set_audio` gain for ducking; tool `dub_track` |
| 6 | **Hook / outro cards from AI** (card.ts) as auto-generated graphics at clip start/end | S | `src/engine/graphics.ts` presets; driven by #1 output |
| 7 | **Publish pack**: per-clip caption .md (title, transcript, hashtags, CTA) + AI titles/chapters YouTube description | S | `electron/` new writer next to render output; tool `publish_pack` |
| 8 | **AI chapters + chapter strip/hero card + split by chapter** (prompt prompts.py:128-160, normalize chapters_io.py, ffmpeg copy-split ffmpeg.ts:245-285) | M | markers as chapters (`add_marker` exists); graphics overlay; `electron/render.cjs` split |
| 9 | **Subtitle QC + auto-fix** (overlap, empty, duplicates, residue, purity) before export/SRT | S | `src/engine/caption.ts` util + MCP tool `check_captions` |
| 10 | **Watermark component** (text/image, corner + margin, opacity) as a project-level overlay | S | `src/types.ts` project field + `src/engine/player.ts` draw + `electron/render.cjs` overlay filter |

Honourable mentions: sentence regrouping for SRT export (sentence_regroup.py, S), yt-dlp import with time range (S, mind licensing), web-search context dossier for script/caption prompts (M).

Do not port: the WebGPU/WebCodecs engine (Cinemex already renders with ffmpeg + NVENC), or the Python sidecar pattern (and if any localhost RPC is added, require a random token and Origin check, unlike VideoCraft).
