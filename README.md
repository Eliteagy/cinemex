# Cinemex

The Elite Agency's video editor. It takes the best ideas from three programs we studied by reverse engineering for interoperability, without copying their code or their look:

| Idea | Inspired by | In Cinemex |
|---|---|---|
| Built-in MCP server so an AI can edit | Premiere Pro 2026 (`dvamcp.dll`, "Premiere MCP Server") | `electron/mcp.cjs`: 56 tools over HTTP at `127.0.0.1:4545/mcp` (token required) |
| Media bins and multi-track editing | Premiere | Media panel, tracks V1/V2, Captions, Music |
| Word-level transcription, automatic captions | DaVinci Resolve 21 (`GetTranscription`, `AutoCaptionSettings`) | Local Whisper (large-v3-turbo on the GPU) and word-by-word captions |
| Readable JSON project | CapCut (`draft_content.json`) | `.ecproj` in JSON, times in seconds |
| Vertical formats and Reels-style animated captions | CapCut | 9:16 / 16:9 / 1:1 / 4:5 presets; Elite Pop, Clean, Box and Title styles |
| Cut pauses (jump cuts) | Editing practice in all three | "Cut pauses" from the transcript, which also redoes the captions |
| Speed 0.25×–4× (pitch kept) | Premiere / CapCut | `setpts` + chained `atempo`; preview with `playbackRate` |
| Transitions (fade, slide, cross dissolve) | All three | In/out per clip; "Dissolve with previous" overlaps the two clips |
| Zoom/pan keyframes with ease, ready-made animations (Ken Burns, Punch…) | DaVinci / CapCut | Keyframes in the Inspector; export via `zoompan` |
| Waveform | All three | Peaks computed by ffmpeg on import (100/s) |
| Import CapCut projects | CapCut (`draft_content.json`) | Videos, music, text (with position), speeds and zoom; finds files that moved |
| Colour page: sliders, looks, LUTs, scope | DaVinci Resolve (Color page), Premiere (Lumetri) | Exposure, contrast, saturation, temperature, vignette per clip; 7 looks; `.cube` LUTs; RGB histogram; copy grade to all clips. Preview with canvas filters, export with `colorchannelmixer`/`eq`/`lut3d`/`vignette` |
| Captions page: list editor, own style, SRT | Premiere (Captions panel), CapCut | Edit text and timing of every caption, search, own style (font, size, colours, outline, box colour, uppercase, position), SRT import/export |
| Animated caption blocks | CapCut (text templates) | 15 blocks with live animated previews: pop, fade, slide, word by word, bounce, karaoke, marker pen, neon glow, 3D shadow, letter spacing; bundled fonts (Anton, Bebas Neue, Bangers, Permanent Marker, Archivo Black, Lilita One, Poppins Black, Inter Black, Great Vibes) |
| Client caption styles with a keyword (v0.8) | The Gui's own edits for Felipe and Marta (Python/Fusion generators) | **Felipe**: white Inter Black revealed letter by letter + one blue script keyword (Great Vibes, squeezed, gradient, glow, rises with blur). **Marta**: white Inter Black with gradient/glow/shadow, bordeaux "Birds of Paradise" keyword below (the user's installed font, never bundled; falls back to Great Vibes), extra words stacked to the right. The keyword is picked automatically (longest content word) and can be changed per caption on the Captions page |
| AutoSubs options (v0.8) | AutoSubs (MIT, Tauri + faster-whisper) | Model choice, language auto-detect, translate to English, context prompt, density / characters per line, max lines, text case, remove punctuation, censored words; *Legendas automáticas* panel and `auto_captions` parameters. Re-implemented natively, no AutoSubs binaries |
| Masks | Premiere Pro (effect masks) | Ellipse/rectangle, feather, invert, blur/pixelate/darken/cut, linear movement; drawn and dragged on the viewer |
| Fusion page (nodes) | DaVinci Resolve (Fusion) | Node editor per clip: Media, Background, Merge (normal/screen/multiply/add), Transform, Chroma key, Blur, Glow, Colour, Film grain, Letterbox |
| Music ducking and loudness | Premiere (Essential Sound), DaVinci (Fairlight) | Music lowered under the voice (`sidechaincompress`), normalisation to -14 LUFS (`loudnorm`) |
| More transitions (v0.10) | CapCut (Whip, Zoom in, Spin), Premiere (Dip to White/Black), Resolve (Blur Dissolve) | Whip with horizontal motion blur, zoom-through, spin, white flash, black dip, defocus. Shared numbers in `src/lib/fx.js`; blur is a 3-step staircase so `gblur` with `enable=` matches the preview |
| Rotation and opacity keyframes, more motion presets (v0.10) | All three | Rotate (`rotate` filter) and opacity (`geq` alpha) keyframes; presets Shake (handheld), Pulse, Spin in, Fade in/out |
| Graphics templates (v0.10) | Premiere (Essential Graphics), CapCut (text templates), Resolve (titles) | Lower third, title with underline, label and progress bar on their own "Grafismos" tracks; one event list (`src/lib/graphics.js`) drawn by the preview and written as ASS (`\move`, `ad`, `	`, `\p1` shapes, BorderStyle 3 boxes) |
| Sound effects (v0.10) | CapCut (sound effects), Premiere (Essential Sound) | 9 synthesised effects (whoosh, swoosh, pop, click, riser, impact, ding, camera, glitch) in `electron/sfx.cjs`, written once as WAV; auto SFX on transitions, cuts and graphics |
| Markers, beats, freeze frame (v0.10) | All three; CapCut "Beats", Premiere "Beat Edit" | Markers (M key), beat detection from the waveform, zoom pulse on beats, cuts snapped to beats, freeze frame (still extracted by ffmpeg, rest of the track pushed back) |
| Keyframe interpolation (v0.11) | After Effects (Easy Ease, graph editor, hold keyframes) | Per keyframe: smooth, linear, hold, easy ease, easy in/out, own cubic-bezier. `src/lib/anim.js` evaluates it in JS for the preview and writes the same maths (6 fixed Newton steps with `st`/`ld`) as ffmpeg expressions; a test evaluates both and compares |
| Expressions (v0.11) | After Effects (`wiggle`, `loopOut`, inertial bounce) | Per property: wiggle (frequency, amplitude), loop (cycle, ping-pong), overshoot (strength, oscillations, damping), without running user code |
| Blend modes and track mattes (v0.11) | After Effects (layer modes, track mattes) | Normal, multiply, screen, overlay, add, lighten, darken, difference (ffmpeg `blend` with the base as backdrop, canvas `globalCompositeOperation`); track matte from a text (video inside the letters, `drawtext`) or another media's alpha/brightness, invertible |
| Effect stack (v0.11) | After Effects (Drop Shadow, Glow, CC Light Sweep, Gradient Ramp) | `src/lib/layerfx.js` builds the export filters; `src/engine/layerfx.ts` draws the same geometry in the preview |

## Opening it

- Windows: Start menu → **Cinemex**, or double-click `Abrir Cinemex.vbs`.
- macOS: double-click `Abrir Cinemex.command` (installs on the first run, rebuilds the interface every time).
- For development: `pnpm app` (builds and opens), `pnpm test` (engine tests, including a real ffmpeg export).

## Using it

- **Import:** drag files onto the window, or click Import. Double-click a media item to put it at the end of the timeline, or drag it onto a track.
- **Editing:** drag clips to move them, drag the edges to trim. `S` cuts at the playhead, `Delete` deletes (`Shift+Delete` deletes and closes the gap), `T` adds text, `Space` plays, `Ctrl+Z`/`Ctrl+Shift+Z` undo and redo. The magnet snaps clips to edges and to the playhead.
- **Captions:** select a clip (or nothing, to caption the whole video) → *Automatic captions*. Transcription runs on this PC.
- **Colour:** *Cor* page. Click a look (Shift+click: all clips) or move the sliders; double-click a slider to reset it. LUTs apply on export.
- **Fusion:** *Fusion* page. Add nodes from the left, connect an output (●) to an input, set the node on the right. Chroma key + Background + Merge = green screen.
- **Masks:** Inspector → *Máscaras*, then drag the shape on the viewer.
- **Captions:** *Legendas* page. *Legendas automáticas* opens the AutoSubs-style options (model, language, translation, density, lines, case, punctuation, censored words). Click a block to apply it (Shift+click: only the selected caption). Edit the text and timing in the list; with Felipe or Marta, the selected caption shows its words: click one to make it the keyword. *O meu estilo* changes every caption at once; SRT in and out.
- **Export:** *Export* → MP4 H.264 + AAC with the captions burned in (libass). The NVIDIA GPU is available through MCP (`gpu: true`).

## Painéis (como no Premiere)

Em todas as páginas os painéis (Média, Visor, Inspetor, Timeline…) mexem-se:

- **Tamanho:** arrasta a borda entre dois painéis.
- **Posição:** arrasta o separador com o nome do painel para cima de outro painel: nos lados fica ao lado, em cima ou em baixo; no meio ficam os dois no mesmo sítio, em separadores.
- Cada página guarda a sua disposição neste computador. **Repor painéis** (canto inferior esquerdo) volta à disposição de origem da página.

## Claude editing

1. Open Cinemex once (it creates the access token).
2. Run `powershell -File ligar-ao-claude.ps1` (registers the MCP in Claude Code). On macOS: `sh ligar-ao-claude.sh`.
3. In a new Claude session: "import C:\...\video.mp4, cut the pauses, put Elite Pop captions on it and export it in 9:16".

MCP tools (48): `get_project`, `import_media`, `add_clip`, `move_clip`, `trim_clip`, `split_clip`, `delete_clip`, `add_text`, `update_clip`, `auto_captions`, `cut_silences`, `set_speed`, `set_transition`, `dissolve`, `set_keyframe`, `animate_clip`, `list_capcut`, `import_capcut`, `set_canvas`, `set_color`, `set_caption_style`, `export_srt`, `import_srt`, `set_audio`, `add_mask`, `update_mask`, `remove_mask`, `fusion_add_node`, `fusion_set`, `fusion_link`, `fusion_remove`, `show_page`, `seek`, `export_video`, `save_project`, `open_project`, `list_caption_styles`, `save_caption_style`, `delete_caption_style`, and in v0.10 `add_graphic`, `update_graphic`, `list_sfx`, `add_sfx`, `auto_sfx`, `detect_beats`, `beat_sync`, `add_marker`, `freeze_frame`, and in v0.11 `set_keyframe_ease`, `set_modifier`, `set_blend`, `set_matte`, `add_effect`, `update_effect`, and `set_crop` (Recorte of the Inspector).

Security: the server only listens on 127.0.0.1, requires a bearer token (kept in the app's data folder, not in the discovery file `~/.cinemex/mcp.json`), and refuses any request coming from a web page (Origin header). The interface only plays files that were imported or that are in opened projects.

## Structure

```
electron/main.cjs      window, ec-media:// protocol (byte ranges), IPC, MCP ↔ editor bridge
electron/mcp.cjs       MCP server (JSON-RPC 2.0, Streamable HTTP with JSON replies)
electron/render.cjs    project → ffmpeg command (overlays, mixing, ASS captions)
electron/media.cjs     ffprobe + thumbnails
electron/captions.cjs  Whisper and grouping words into captions
electron/capcut.cjs    CapCut draft → Cinemex project (read only)
engine/transcribe.py   faster-whisper with word timestamps
src/store.ts           editor state (Zustand) with undo/redo
src/engine/player.ts   canvas preview in sync with the timeline
src/engine/caption.ts  caption effects (shared with the block gallery)
src/lib/emphasis.js    keyword captions: keyword pick, lines, positions (shared by preview, export, grouping)
electron/fonts.cjs     user fonts installed on the PC (personal licences, never shipped)
src/engine/mask.ts     masks in the preview
src/engine/fusion.ts   Fusion node graph in the preview (src/lib/fusion-nodes.json)
src/components/        TopBar, MediaBin, Viewer, Inspector, Timeline, Color, Captions, Deliver
```

Requirements: Node 20+, pnpm, ffmpeg/ffprobe on the PATH, Python with `faster-whisper` (for captions).

### macOS

The same code runs on a Mac; `electron/bin.cjs` finds the programs on each system.

- **ffmpeg:** the plain Homebrew `ffmpeg` has no libass/freetype, so exports with captions, graphics or text mattes fail (`No such filter: subtitles` / `drawtext`). Install `brew install ffmpeg-full`; it is found on its own in `/opt/homebrew/opt/ffmpeg-full` (or set `ELITE_FFMPEG` / `ELITE_FFPROBE`).
- **Captions:** the Homebrew Python does not take `pip install`, so Whisper lives in a venv that the app picks up: `python3 -m venv ~/.cinemex/venv && ~/.cinemex/venv/bin/pip install faster-whisper "av<19"` (PyAV 19 dropped an argument faster-whisper 1.2 still passes). It runs on the CPU.
- **GPU export:** `gpu: true` / *Placa gráfica* uses VideoToolbox (`h264_videotoolbox`) instead of NVIDIA.
- Fonts come from `~/Library/Fonts`, `/Library/Fonts` and `/System/Library/Fonts`; CapCut drafts from `~/Movies/CapCut`.

## Colaborar (GitHub)

Repositório: https://github.com/Eliteagy/cinemex. Só o programa: os projetos (`.ecproj`), vídeos, `node_modules` e `dist` ficam fora.

- Instalar: `git clone https://github.com/Eliteagy/cinemex.git`, depois `pnpm install` e `pnpm app` (precisa de Node 24+, pnpm, ffmpeg no PATH e Python 3 com faster-whisper para as legendas).
- Enviar alterações: commit no `main` e `git push` (os colaboradores são convidados pelo dono do repositório).
- Sincronização automática neste PC (push a cada commit, pull a cada 15 min): `powershell -ExecutionPolicy Bypass -File tools\sync\instalar-sync.ps1` (desligar com `-Remover`).
- No Mac: `sh tools/sync/instalar-sync.sh` (LaunchAgent em vez de tarefa agendada; `--so-pull` só recebe, `--remover` desliga; o registo do pull fica em `~/Library/Logs/cinemex-sync.log`).

## Ligação (editar em direto com o outro computador)

Botão **Ligação** na barra de cima. Três coisas:

1. **Computadores**: quem está ligado, o sistema (Windows/Mac) e a versão do Cinemex de cada um.
2. **Editar em direto**: "Partilhar este projeto" envia o projeto aberto; o outro recebe um convite e "Entrar no projeto" abre-o. A partir daí cada alteração passa logo para o outro lado, e a cabeça de leitura e o clip selecionado do outro aparecem na timeline na cor dele. Dois a mexer em clips diferentes ao mesmo tempo não se estragam; no mesmo clip ganha a última alteração.
3. **Versão do Cinemex**: diz se há alterações novas no GitHub e "Atualizar e reabrir" faz `git pull`, instala dependências se mudaram, prepara a interface e reabre.

**Pasta partilhada (Google Drive).** Com o Google Drive para computador instalado nos dois, a pasta `Cinemex` dentro de "O meu disco" é a pasta partilhada. Vídeos e projetos lá dentro ficam guardados como `@shared/...` e cada computador abre-os com o seu próprio caminho (G:\ no Windows, `~/Library/CloudStorage/GoogleDrive-…` no Mac). Pode escolher-se outra pasta no painel.

**Convidar.** No painel, "Copiar link de convite" e mandar o link ao outro (WhatsApp, e-mail). Ao abri-lo, o Cinemex dele liga-se sozinho (Windows); se não abrir, cola-se o link em "Recebeste um link?" no painel. "Avançado → Novo convite" anula o link antigo.

**Segurança.** O link leva o **código de ligação** (`cmx1-…`) depois do `#`, que o browser nunca envia ao servidor; trata-o como uma chave e manda-o só por mensagem privada. O código nunca sai do computador: dele saem o nome da sala e a chave AES-256-GCM, por isso o servidor só passa mensagens cifradas que não consegue ler, e não guarda nada.

**Servidor de ligação** (`relay/`, um Worker do Cloudflare com Durable Objects, plano grátis). Publicar uma vez:

```
cd relay
npx wrangler login
npx wrangler deploy
```

O endereço que aparece (`https://cinemex-relay.<conta>.workers.dev`) vai no campo "Servidor de ligação" do painel, nos dois computadores. Para testar sem conta: `npx wrangler dev --port 8799` e `http://127.0.0.1:8799`.
