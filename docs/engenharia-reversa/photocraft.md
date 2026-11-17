# PhotoCraft 0.20.1 — reverse-engineering report (for porting into Cinemex)

Source: `github.com/storytold/photocraft`, tag `v0.20.1` (commit `327c4cc82e737a3e0af7c147a477126d77525495`, same as `photocraft-cli --version` of the installed portable build: "0.20.1 (327c4cc82, 2026-11-03)"). Licence MIT OR Apache-2.0 (Cargo workspace `license = "MIT OR Apache-2.0"`), so code/formulas can be ported with attribution.
Local copy: git objects only (C: drive was full, 0 GB free when cloning; the working tree was not checked out). Read with `git -C <scratchpad>\re\src\photocraft show HEAD:<path>`.
All citations below are `path:line` at that tag. "Guess" = my inference, not read in code.

Installed build (`...\AI Tools\PhotoCraft\`): `photocraft.exe` (152 MB, GUI), `photocraft-cli.exe` (109 MB, headless), fonts licences, `PhotoCraftData\` (preferences.json, ui.ron, logs). `portable.txt` makes settings live in `PhotoCraftData`. CLI subcommands: `convert`, `info`, `run`, `batch`, `droplet`, `commands`, `mcp`, `serve`. `commands` lists ~400 engine commands (the registry the GUI, CLI, JSON control channel and MCP all share).

---

## 1. Architecture

### 1.1 Crates (`Cargo.toml` workspace, `crates/*`, `apps/*`)
| Crate | Role |
|---|---|
| `geom`, `color`, `cms` | geometry; colour models + **blend modes** (`color/src/blend.rs`); ICC + LUT file parsers (`cms/src/lutfile.rs`: `parse_cube`:151, `parse_3dl`:233, `parse_look`:334) |
| `raster` | tiled copy-on-write `Surface`, runtime sample depth (8/16-bit int, 32-bit float) |
| `doc` | pure-data document model: `Layer`, `Adjustment`, `Effect`, `BlendIf`, `Timeline`, `VideoData` |
| `ops` | document operations |
| `compose` | **CPU reference compositor** (export + tests = "oracle"): adjustments, layer styles, masks, fills, patterns |
| `gpu` | **wgpu compositor** (Metal/Vulkan/DX12/WebGPU): `compose.wgsl` (69 KB) mirrors `compose` op-for-op; `camera_raw.wgsl` |
| `algo` | CPU filters (Filter menu), selection/segmentation, inpainting, matting, HDR, panorama, liquify, faces (YuNet port) |
| `paint` | brush engine, mixer brush, retouch dabs |
| `vector`, `text` | paths/shapes, type layout/shaping/warp |
| `psd`, `io`, `codecs`, `raw`, `heif`, `affinity`, `format` | PSD/PSB, flat formats, camera raw decode, Affinity import, native `.pcraft` |
| `engine` | `Session`: open docs, history, **command registry** + dispatch |
| `automation`, `plugins`, `ipp`, `tablet` | CLI/JSON control/MCP server, plugins, printing, pen tablets |
| `ui-egui` | egui GUI (thin shell over engine commands) |

Dependency direction enforced by `cargo xtask layers` (book/src/architecture/overview.md). `unsafe_code = "forbid"` workspace-wide.

### 1.2 Rendering
- Two compositors: CPU `photocraft-compose` (export, correctness oracle) and GPU `photocraft-gpu` (interactive canvas when the planner can represent the doc; falls back to CPU otherwise) — `book/src/architecture/rendering.md`.
- GPU passes render one chunk into a **straight-alpha RGBA32F** accumulator; inputs read with `textureLoad` at the same pixel (`crates/gpu/src/compose.wgsl:1-6`). Adjustments run as a single `adjust()` switch (`compose.wgsl:638-791`) parameterised by `op.kind` + 4 vec4 params + a LUT texture (4096-sample rows).
- Compositing equation (W3C/PDF general form), straight alpha: `αo = αs + αb(1−αs)`, `αo·Co = (1−αs)αb·Cb + (1−αb)αs·Cs + αs·αb·B(Cb,Cs)` (`crates/color/src/blend.rs:444-470`). "Atop" variant for Lock Transparency (`blend.rs:472-486`).
- Filters are depth-agnostic f32, tile-based with declared halo (`crates/algo/src/lib.rs:1-17, 564-742`), selection-masked.
- Everything is classical / hand-written: **no ONNX or ML runtime**. `scorecard/automation.toml:58-61`: "Local ONNX models … target", "No ONNX runtime dependency". Only learned weights shipped: YuNet face detector (100 KB, `crates/algo/data/libfacedetection.bin`, plain-Rust inference `crates/algo/src/faces/cnn.rs`).

### 1.3 Layer model (`crates/doc/src/lib.rs`)
`Layer` (:630-680): `id, name, visible, locks, blend: BlendMode, opacity, fill_opacity, clipped (clipping mask), mask: Option<LayerMask{surface, enabled, linked, density, feather}> (:245-251), vector_mask, effects: Effects{enabled, items: Vec<Effect>} (:295), label, content, excluded_channels, blend_if: BlendIf, advanced: AdvancedBlending, video: Option<VideoData>`.
`LayerContent` (:597-605): `Raster | Group(Pass Through/isolated, artboards) | Adjustment | Fill(Solid|Gradient|Pattern) (:328-372) | Text | Shape | Smart(SmartObject with smart_filters: Vec<SmartFilter{command, params JSON, blend, opacity, visible}>, filter_mask, warp, perspective, stack_mode)` (:515-580).
- Opacity vs Fill: Fill applies only to the layer's own pixels, not its effects; for 8 "special" modes Fill < 100 % pulls the source toward the mode's neutral colour (`compose.wgsl:315-356`).
- Smart filters = list of engine command IDs + JSON params → non-destructive filter stack. (Same idea as a per-clip effect stack.)
- Video: `doc/src/video.rs` — `Timeline{fps, duration, current, work_start, work_end}` and `VideoData{frames: Vec<Surface>, original_frames, source, fps, show_altered}`. Video layers are **in-memory frame stacks** (frame animation / rotoscoping), not a streaming video engine. Commands: `filter.video.deInterlace`, `filter.video.ntscColors`, Timeline, Video layers. Nothing there for Cinemex to copy.

### 1.4 File format `.pcraft` (`book/src/formats/pcraft.md`, `crates/format`)
ZIP or directory bundle: `manifest.json` (versioned doc tree, serde of `photocraft-doc`), `tiles/<blake3>.zst`, `blobs/<blake3>.zst` (content-addressed, zstd), `thumb.png`, `composite/preview.png`, `save.lock` (dir bundles). Limits: manifest 256 MiB, blob 1 GiB, total 16 GiB, group depth 100. PSD/PSB read/write with high fidelity ("307 of 309 psd-tools test files").

### 1.5 Automation (useful for Cinemex as an external still-image processor)
`photocraft-cli run <file> --cmd <id> --params '<json>' --out <file>` runs any registry command headless (e.g. `filter.render.lensFlare`, `select.subject`, content-aware fill) on a still; `mcp` exposes the same engine over MCP stdio; `serve` keeps a JSON-lines session. Example params seen in code: `filter.blur.gaussianBlur {"radius":8}`, `filter.noise.addNoise {"amount":8,"seed":1}`, `filter.render.lensFlare {"brightness":240,"centerX":5.0,"centerY":-5.0,"lens":"prime105"}` (`crates/engine/src/cmd/atn_cmds/render_tests.rs:260`).

---

## 2. Feature inventory (what actually exists)

### 2.1 Tools (68) — `crates/ui-egui/src/state/tool.rs:4`
Move, Artboard, Rect/Ellipse/SingleRow/SingleColumn Marquee, Lasso, Polygon Lasso, Magnetic Lasso, Magic Wand, Quick Selection, Object Selection, Crop, Perspective Crop, Eyedropper, Color Sampler, Ruler, Note, Count, Brush, Pencil, Mixer Brush, Color Replacement, Eraser, Background Eraser, Magic Eraser, Gradient, Paint Bucket, Type (H/V + type masks), Hand, Rotate View, Zoom, **Remove**, Spot Healing, Healing, Patch, Content-Aware Move, Red Eye, Clone Stamp, Pattern Stamp, History Brush, Art History Brush, Blur, Sharpen, Smudge, Dodge, Burn, Sponge, Pen/Freeform/Curvature Pen + anchor tools, Path/Direct Selection, Rectangle/Ellipse/Triangle/Polygon/Line/Custom Shape, Slice/Slice Select, Frame.

### 2.2 Blend modes (34) — `crates/color/src/blend.rs:11-47`
Photoshop 27 + Pass Through (groups) + 6 Paint.NET modes (Reflect, Glow, Negation, XOR, Color Burn PDN, Color Dodge PDN). Dissolve uses a per-pixel hash vs. coverage (`compose.wgsl:404-410`).

### 2.3 Adjustment layers (16 + direct-only ones) — `crates/doc/src/adjust.rs:199-313`
Brightness/Contrast (modern + legacy), Levels (master + RGB, RGB/CMYK/Lab space), Curves (natural spline or pencil map, per channel), Exposure (exposure/offset/gamma), Vibrance (vibrance + saturation), Hue/Saturation (6 hue ranges with 4-point bounds, colorize), Color Balance (3 tones × 3 sliders, preserve luminosity), Black & White (6 weights + tint), Photo Filter (colour, density, preserve lum), Channel Mixer (3×4 matrix incl. constant, monochrome), Color Lookup (3D LUT .cube/.3dl/.look, trilinear or tetrahedral, dither), Invert, Posterize, Threshold, Gradient Map (stops, reverse, dither), Selective Color (9 ranges × CMYK, relative/absolute).
Direct (Image › Adjustments, pixel-only): Shadows/Highlights, Replace Color, Match Color, HDR Toning, Desaturate, Equalize (CLI `commands`).

### 2.4 Layer styles (10) — `crates/doc/src/effects.rs:243-274`
Drop Shadow, Inner Shadow, Outer Glow, Inner Glow (Softer/Precise, Edge/Center, contour, range, jitter, noise, colour/gradient/pattern paint), Stroke (Outside/Inside/Center; colour/gradient/pattern; overprint), Color Overlay, Gradient Overlay (Linear/Radial/Angle/Reflected/Diamond, dither), Pattern Overlay, Satin, Bevel & Emboss (Outer/Inner/Emboss/Pillow/Stroke Emboss; Smooth/Chisel Hard/Chisel Soft; gloss contour; contour; texture). Plus Blending Options: Fill opacity, Blend If, Advanced Blending (knockout, blend interior as group, channels).

### 2.5 Filters (registry IDs; params in `crates/algo/src/lib.rs:207-562`)
- Blur: Gaussian (σ = radius), Box, Motion, Radial (spin/zoom), Surface, Smart, Lens Blur (iris blades, depth map, specular), Shape, Average, Blur/Blur More.
- Blur Gallery: Tilt-Shift, Iris, Field, Spin, Path.
- Sharpen: Unsharp Mask (exact + FFT path), Smart Sharpen (basic), Sharpen/More/Edges, High Pass (Other).
- Noise: Add Noise (uniform/gaussian, mono, seed), Median (Huang sliding histogram), Dust & Scratches, Despeckle, Reduce Noise (guided filter).
- Pixelate: Mosaic, Color Halftone, Crystallize, Facet, Fragment, Mezzotint, Pointillize.
- Stylize: Emboss, Find Edges, Solarize, Diffuse, Extrude, Oil Paint, Tiles, Trace Contour, Wind.
- Distort: Twirl, Pinch, Spherize, Wave, Ripple, Polar Coordinates, Displace, Shear, ZigZag; Liquify; Puppet Warp; Lens Correction; Adaptive Wide Angle; Vanishing Point.
- Render: Clouds, Difference Clouds, Fibers, **Lens Flare** (Zoom / 35 mm / 105 mm / Movie Prime), Lighting Effects, **Relight**, Flame, Picture Frame, Tree.
- Other: Custom 5×5, HSB/HSL, Minimum/Maximum, Offset, **Color to Alpha**.
- Video: De-Interlace, NTSC Colors.
- **Camera Raw Filter** (`crates/algo/src/camera_raw.rs`, GPU `crates/gpu/src/camera_raw.wgsl`).
- Filter Gallery: 47 artistic effects (Colored Pencil … Film Grain … Texturizer) (`crates/algo/src/artistic.rs`, `artistic_fx.rs`).

### 2.6 Selection tools / smart selection (all classical, `crates/algo/src/segment.rs:1-24`)
Marquees, lassos, Magnetic Lasso (Intelligent Scissors live-wire, `magnetic.rs:1-17`), Magic Wand, Color Range, Quick Selection (one min-cut with area cost, constants fitted on Photoshop, `segment/quick.rs`), Object Selection (rectangle → GrabCut, `segment/grabcut.rs`), **Select Subject** (SLIC superpixels → saliency (Zhu CVPR 2014 + Achanta FT) → Otsu → two GrabCut passes, `segment/subject.rs:1-27`), **Select Sky** (colour prior × smoothness, region grow from top, GMM, guided-filter refine, `segment/sky.rs`), **Focus Area** (Laplacian energy threshold + guided filter, `segment/focus.rs`), Select and Mask / Refine Edge (guided filter, smart radius, smooth/feather/contrast/shift, decontaminate colours, refine-edge brush with Levin colour-line model, `matting.rs`, `matting/brush.rs`), Load Luminosity, Quick Mask, modify border/smooth/expand/contract/feather, grow, similar.

### 2.7 "AI-like" features (classical implementations)
| Feature | Algorithm | File |
|---|---|---|
| Content-Aware Fill | Wexler space-time completion + PatchMatch, coarse-to-fine, sampling window `4·√(max(w,50)·max(h,50))`, colour adaptation | `algo/src/inpaint.rs`, `content_aware.rs` |
| Remove tool | Newson et al. non-local patch inpainting + texture features + gradient-domain seam hiding; closes loops | `remove.rs`, `nonlocal.rs` |
| Spot Healing / Healing | Poisson blending (SOR, cascadic multigrid) | `poisson.rs` |
| Content-Aware Scale | Seam carving | `seam.rs` |
| Select Subject / Sky / Focus | see 2.6 | `segment/*` |
| Face detection | YuNet CNN port (Liquify face-aware, red-eye; guess on all callers) | `faces.rs`, `faces/cnn.rs` |
| Relight | Retinex shading + Lambert lamp | `relight.rs` |
| Dehaze | Dark channel prior + guided filter | `camera_raw.rs:932-1005` |
| HDR merge | Ward MTB align, Debevec response, ghost removal, Reinhard tone map | `hdr.rs` |
| Auto-Blend / focus stack / depth-from-focus | Burt-Adelson pyramids, ring difference filter | `pyramid.rs`, `dff.rs` |
| Panorama | `panorama.rs` | |
| Stack modes (median etc.) | per-pixel stats | `stack.rs` |

---

## 3. Algorithms with parameters + how to port

Conventions: `cb` = backdrop, `cs` = source, values 0..1. "Canvas" = Cinemex 2D canvas preview; "WebGL" = a GLSL port (recommended where canvas can't); "ffmpeg" = export in `electron/render.cjs`.

### 3.1 Blend modes — `crates/color/src/blend.rs:194-268` (separable), `:407-436` (non-separable); GPU twin `compose.wgsl:127-288`

| Mode | Formula (PhotoCraft) |
|---|---|
| Darken / Lighten | `min / max(cb,cs)` |
| Multiply / Screen | `cb·cs` / `cb+cs−cb·cs` |
| Color Burn | `cb≥1→1; cs≤0→0; 1−min(1,(1−cb)/cs)` (`:295-303`) |
| Color Dodge | `cb≤0→0; cs≥1→1; min(1, cb/(1−cs))` (`:306-314`) |
| Linear Burn / Dodge | `max(0,cb+cs−1)` / `min(1,cb+cs)` (unclipped in 32-bit) |
| Overlay / Hard Light | `HardLight(cs,cb)` / `cs≤.5 ? 2cb·cs : cb+s−cb·s, s=2cs−1` |
| Soft Light | W3C: `cs≤.5: 2cb·cs + cb²(1−2cs)`; else `2cb(1−cs) + D(cb)(2cs−1)`, `D = cb≤.25 ? ((16cb−12)cb+4)cb : √cb` (`:331-339`) |
| Vivid Light | `cs≤.5 ? burn(cb,2cs) : dodge(cb,2(cs−.5))` |
| Linear Light | `clamp(cb+2cs−1)` |
| Pin Light | `cs≤.5 ? min(cb,2cs) : max(cb,2cs−1)` |
| Hard Mix | `vividHM(cb,cs) ≥ 0.5−1e-6 ? 1 : 0` (`:225-231, 275-292`) |
| Difference / Exclusion | `|cb−cs|` / `cb+cs−2cb·cs` |
| Subtract / Divide | `max(0,cb−cs)` / `cs≤0 ? (cb≤0?0:1) : min(1,cb/cs)` |
| Hue / Saturation / Color / Luminosity | W3C SetLum/SetSat/ClipColor with `lum = .3R+.59G+.11B`; out-of-range lum → grey (`:343-436`) |
| Darker / Lighter Color | whole pixel with lower / higher `lum` |
| Reflect / Glow | `min(1, cb²/(1−cs))` / swapped |
| Negation | `1−|1−cb−cs|` |
| XOR | 8-bit `cb ^ cs` |
| Dissolve | pixel shown iff `hash(x,y) < αs·opacity`; hash = `compose.wgsl:404-410` (`h=(x·0x8da6b343)^(y·0xd8163841)^0x9e3779b9; h^=h>>15; h*=0x2c1b3c6d; h^=h>>12; (h&0xffff)/65536`) |
| Fill < 100 % special-8 | Color/Linear Burn neutral 1, Vivid/Linear Light 0.5, others 0: `cs' = n + (cs−n)·fill`; Hard Mix `clamp((cb − f(1−cs))/(1−f))` (`compose.wgsl:326-356`) |

**Cinemex today:** 8 modes (normal, multiply, screen, overlay, add, lighten, darken, difference) in `src/lib/layerfx.js:20-24`. New: Color Burn, Color Dodge, Linear Burn, Soft Light, Hard Light, Vivid/Linear/Pin Light, Hard Mix, Exclusion, Subtract, Divide, Hue, Saturation, Color, Luminosity, Darker/Lighter Color, Dissolve, Reflect/Glow/Negation.

**(a) Canvas / WebGL.** `globalCompositeOperation` implements W3C (same formulas incl. the W3C soft-light D(cb) and 0.3/0.59/0.11 lum): `color-burn, color-dodge, hard-light, soft-light, exclusion, hue, saturation, color, luminosity` are drop-in. The missing ones (Linear Burn, Linear Light, Vivid Light, Pin Light, Hard Mix, Subtract, Divide, Darker/Lighter Color, Dissolve, Reflect/Glow/Negation) need a WebGL2 pass. Port `blend_channel` + `blend_rgb` + `composite` from `compose.wgsl:127-288` nearly 1:1 to GLSL (WGSL→GLSL is mechanical: `vec3<f32>`→`vec3`, `select(a,b,c)`→`c?b:a`). Draw the WebGL result back with `drawImage` into the 2D canvas.

**(b) ffmpeg.** Measured on the installed ffmpeg 9.0.2 (`blend` with two `format=gbrp` solids, values 64/200 and 100/50, both input orders):
- `normal` outputs the **first** input.
- The backdrop is the **first** input for `overlay, hardlight, pinlight, subtract, divide, reflect, glow`. Symmetric: `multiply, screen, lighten, darken, difference, exclusion, addition, negation, hardmix`.
- The backdrop is the **second** input for `burn, dodge, vividlight, linearlight` (the results matched the PS formulas only with the inputs swapped). So Cinemex's "base = first input" convention (`layerfx.js:22`) is wrong for those four. Use `all_expr` or swap the inputs.
- `softlight` matches neither order of the W3C formula (64/200 → 88, W3C 100; 200/64 → 176, W3C 178). Use `all_expr`.
- `all_opacity` mixes toward the first input, so it is only right where the backdrop is first.

Exact `all_expr` for the missing modes (A = backdrop/first, B = source/second, 8-bit; for >8-bit replace 255 by the max):
```
linearburn : max(A+B-255,0)
colorburn  : if(gte(A,255),255,if(lte(B,0),0,255-min(255,(255-A)*255/B)))
colordodge : if(lte(A,0),0,if(gte(B,255),255,min(255,A*255/(255-B))))
vividlight : if(lte(B,127.5), if(gte(A,255),255,if(lte(B,0),0,255-min(255,(255-A)*255/(2*B)))), if(lte(A,0),0,if(gte(B,255),255,min(255,A*255/(255-2*(B-127.5))))))
linearlight: clip(A+2*B-255,0,255)
pinlight   : if(lte(B,127.5),min(A,2*B),max(A,2*B-255))
hardmix    : 255*gte(A+B,255)          (equals the vivid-light threshold for 8-bit, guess)
softlight  : st(0,A/255);st(1,B/255);255*if(lte(ld(1),0.5),2*ld(0)*ld(1)+ld(0)*ld(0)*(1-2*ld(1)),2*ld(0)*(1-ld(1))+if(lte(ld(0),0.25),((16*ld(0)-12)*ld(0)+4)*ld(0),sqrt(ld(0)))*(2*ld(1)-1))
```
Opacity: `A+(expr−A)·op`. Source alpha: `blend` ignores alpha, so composite as `[bg][fg]blend=…[b]; [b][fgAlpha]alphamerge[m]; [bg][m]overlay`. Non-separable modes (Hue/Sat/Color/Luminosity/Darker/Lighter Color) can't be done per plane. Approximation: convert both to `yuv444p`; Luminosity = source Y + backdrop UV, Color = backdrop Y + source UV via `mergeplanes` (BT.601 Y instead of 0.3/0.59/0.11, no ClipColor). Exact but slow: `hstack` the two frames and `geq` reading `r(X+W/2,Y)` etc.
Dissolve: `geq` alpha = `255*lt(hash(X,Y), alpha)`, with the same hash written in geq arithmetic (bit operations need `bitand`, which geq has, guess) or `noise=alls=100:allf=0` + threshold (not deterministic per pixel).

### 3.2 Adjustments (per-pixel; GPU switch `compose.wgsl:638-791`)
Cinemex has exposure/contrast/saturation/temperature/vignette + 7 looks + `.cube` via `lut3d` (memory note v0.4). Everything below is new except Exposure/Color Lookup.

| Adjustment | Algorithm (cite) | Params |
|---|---|---|
| Brightness/Contrast (modern) | Brightness: line `s·x` (`s=1.375^(b/50)`) up to knee y=126/255, then Hermite (or power) roll-off to (1,1); negative = inverse by bisection (`compose/src/adjust/tone.rs:155-226`). Contrast: symmetric cubic Hermite S-curve about 0.5, end slope `1−c/128`, centre slope `1+c/128` (`:261-271`). LUT 4096 (`:230-256`) | b −150..150, c −50..100 |
| Levels | `u=clamp((v−inB)/(inW−inB))`, gamma `u^(1/g)` with a toe `a·u−b·u^2.2`, `a=2^g`, for g>1; then `outB+t(outW−outB)`; per-channel first, then master (`tone.rs:310-356`, `:43-47`) | 5 per channel |
| Curves | **natural cubic spline** (tridiagonal solve), constant outside end points, clamp 0..1; channel curve then master (`tone.rs:404-461`, `:49-52`); pencil = piecewise linear (`:375-399`) | points per channel |
| Exposure | linear light: `(dec(v)·2^e + offset)^(1/γ)` then re-encode (`compose.wgsl:601-609`) | e, offset, γ |
| Vibrance | linear light; Vibrance = HSV-saturation change with skin weight for hues ≤30°…45°/≥300° and fitted boost; Saturation = move from grey `0.288R+0.712G` by `1+s` (`compose.wgsl:433-465, 729-740`; `adjust/color.rs:337-371`) | v, s −100..100 |
| Hue/Saturation | lightness first (`c·(1+l)` or `c+(1−c)l`), then HSL hue shift + sat (`s>0: S/(1−s)`, `s<0: S·(1+s)`); 6 ranges with trapezoid weights on the **original** hue (`compose.wgsl:670-728`; `doc/src/adjust.rs:128-191`; `adjust/color.rs:6-16`); colorize = HSL(h, |s|, L') | hue ±180, sat/light ±100, ranges |
| Color Balance | folded into one Levels per channel: black = −shadows (levels), white = 255−highlights, gamma `2^(m/100)`, `m = mid + (sh+hi)/2`; preserve-lum variant uses max/min across channels; Hermite knee for γ>1 (`adjust/color.rs:169-267`) | 3×3 sliders ±100 |
| Black & White | `min + (mid−min)·w[secondary]/100 + (max−mid)·w[primary]/100`; tint = SetLum(tint, gray) (`adjust/color.rs:98-118`, `compose.wgsl:758-775`) | 6 weights, tint |
| Photo Filter | linear sRGB → XYZ D50 → scale by `1−d+d·XYZ(color)/D50` → back; preserve lum = SetLum (`adjust/color.rs:325-335`, `compose.wgsl:748-757`) | colour, density |
| Channel Mixer | `out = M·rgb + k`, monochrome = row 0 (`compose.wgsl:741-747`) | 3×4 |
| Selective Color | weights: chroma part per hue sector, whites `2(min−.5)`, neutrals `1−|max−.5|−|min−.5|`, blacks `2(.5−max)`; ink shift relative (`·ink`) or absolute (`·min(1,2(1−ink))` / `·min(1,2·ink)`) (`adjust/color.rs:271-318`) | 9×CMYK % |
| Gradient Map | `t = lum(.3,.59,.11)`, stops LUT, optional 4×4 Bayer dither (`compose.wgsl:776-782`; `adjust/color.rs:121-124`) | stops |
| Color Lookup | trilinear or **tetrahedral** 3D LUT (`adjust/color.rs:127-167`); parsers `.cube/.3dl/.look` (`cms/src/lutfile.rs`) | LUT |
| Posterize / Threshold / Invert | PS bins `floor(k·255/(n−1))`; threshold on `30R+59G+11B` (`tone.rs:273-297`, `compose.wgsl:646-661`) | |
| Shadows/Highlights | edge-aware neighbourhood (σ=1.14·radius, weights fall with brightness difference), tonal mask from Beta(1.95,23)…1−L, self-screen curve `1−(1−v)^q`, colour slider (`algo/src/tone/shadows_highlights.rs:1-20`) | amount, tone, radius, color — **spatial** |

**Port strategy (one mechanism for preview + export):** every adjustment above except Shadows/Highlights and the dither options is a pure function `rgb → rgb`. Port the functions to TS (`src/engine/adjust/*.ts`), evaluate the clip's whole adjustment stack on a 33³ or 65³ grid, and:
- (a) Preview: upload as a WebGL2 `TEXTURE_3D` and sample (tetrahedral in the shader, or trilinear hardware). The 2D canvas fallback (`getImageData` + per-pixel trilinear in JS) works but costs ~2 M lookups per 1080p frame (guess: 20-60 ms).
- (b) Export: write `adjN.cube` and use the `lut3d=file=…:interp=tetrahedral` that Cinemex already emits for LUTs.
Exact per-filter alternatives in ffmpeg where one exists: Curves → `curves=r='…':g='…':b='…':master='…'` (ffmpeg's default interpolation is also a natural spline and applies master after the channels, the same order; check for clamping differences). Channel Mixer → `colorchannelmixer` (no constant term: add it with `lutrgb`). Invert → `negate`. Posterize/Levels → `lutrgb` expressions. Selective Color → ffmpeg `selectivecolor` (also Photoshop-modelled, but a separate implementation, so expect small differences). The LUT bake is simpler and matches the preview by construction.

### 3.3 Camera Raw develop — `crates/algo/src/camera_raw.rs:1-27`, per-pixel GPU shader `crates/gpu/src/camera_raw.wgsl:283-416`
This is the most video-relevant part: a Lightroom-style panel already written as **one fragment shader**.
Per-pixel stages (order as in the shader):
1. WB + exposure in linear: gains `[1+.35t, 1−.25tint, 1−.35t]` (t = temp/100), normalised by their BT.709 luma, ×2^exposure (`camera_raw.rs:670-674`, `camera_raw/per_pixel.rs:13-19`, wgsl:288-292).
2. Contrast on luminance, ratios kept: `lv = l − k·sin(2πl)/2π`, `k = contrast/100·0.6` (wgsl:294-306, per_pixel.rs:23-24).
3. Whites/Blacks: image-adaptive global curves (LUT rows; points measured from the image: `per_pixel.rs:192-220`).
4. Vibrance/Saturation: `k = 1 + sat + vib·(1−S)·(1−skin)`, skin = hat around hue 25°, about BT.709 luma (wgsl:312-321).
5. Parametric curve (Highlights/Lights/Darks/Shadows + 3 splits) then point curves master/R/G/B, monotone cubic (Fritsch-Carlson) LUT 1024 (wgsl:322-333).
6. HSL Color Mixer: 8 bands at hues `0,30,60,120,180,240,270,300`, hat weights between neighbours; hue `+d.h/100·30°`, sat `·(1+d.s/100)`, luma restored then `·2^(d.l/100·S)` (wgsl:207-227, 334-351).
7. Color Grading: masks `sh = 1−smoothstep(0, .5+bal+blend, L)`, `hi = smoothstep(.5+bal−blend, 1, L)`, `mid = 1−sh−hi`, global = 1; add tint `(hsv(h,1,1)−luma)·sat/100·0.3`, luminance `·2^(mask·lum/100·0.6)`; `blend = .15+.35·blending/100`, `bal = .25·balance/100` (wgsl:353-367, per_pixel.rs:50-61).
8. Vignette: superellipse distance (power `2+6·max(−roundness,0)`), smoothstep between edges from midpoint/feather; styles highlight priority / colour priority / paint overlay (wgsl:369-400, per_pixel.rs:93-118).
9. Grain: 2-octave value noise (cell `1+size/25`, roughness mixes octave ×2.3), amount `·0.12`, weighted `0.4+2.4·L(1−L)` (wgsl:402-411, per_pixel.rs:135-144).
Spatial stages (not in the shader): Dehaze (dark channel on a ≤768 px proxy, window r = max(side/60, 2), opened min-filter, atmospheric light = mean of the top 0.1 %, guided-filter transmission, `J=(I−A)/max(t,.1)+A`, `camera_raw.rs:932-1005`), Clarity (`lv += clarity/100·0.8·(L − guided(L, r=0.02·long, ε=.005))·(1−(2L−1)²)`) and Texture (`lv += tex/100·0.9·clamp(L−gauss(L, σ=.002·long), ±.1)`) (`camera_raw.rs:718-738`), Shadows/Highlights as a fast local Laplacian (`camera_raw/local_tone.rs`), Detail sharpening / NR (`:1007+`).
- (a) Preview: port `camera_raw.wgsl` to GLSL (≈130 lines plus helpers). The 64-bit hash (wgsl:229-262) can be replaced by a 32-bit hash for preview.
- (b) Export: stages 1–7 are position-independent, so bake them into the same `.cube` (Whites/Blacks: freeze the image-adaptive points per clip, measured on one frame, or they flicker). Vignette → `geq` multiplier or a pre-rendered mask PNG + `blend=multiply`. Grain → Cinemex's existing grain node, adding the `0.4+2.4L(1−L)` luma weighting. Clarity/Texture → `split; gblur` (Texture) / `guided` filter (ffmpeg has `guided`) + `blend all_expr`. Dehaze → per-frame dark channel isn't available in ffmpeg; approximate with a fixed atmospheric light per clip + `minimum` (erosion, radius via repeats) + `guided` + `geq` (L).

### 3.4 Layer styles — `crates/compose/src/effects.rs:1-22`, `effects/paint.rs`, `effects/blur.rs`, `effects/distance.rs`
Stack bottom→top: drop shadows, outer glows, outer bevel, layer (fill opacity) + overlays, satin, inner glows, inner shadows, strokes, inner bevel (`effects.rs:3-11`).
- Soft falloff = **two box blurs of width `size` (tent)**, fitted on PSD files (`effects/blur.rs:4-11, 50-63`). Spread/Choke: `(r, bw) = (round(size·spread), size·(1−spread))`; dilate by `r` with the 5×5 chamfer distance, then tent blur `bw` (`paint.rs:258-260`, `blur.rs:18-30`).
- Drop/Inner shadow: shift by `(cos,−sin)·distance` (light angle, global light), dilate, tent, contour LUT, noise; inner = from `1−α`, multiplied by α (`paint.rs:262-278`).
- Glow Softer = shadow-like; Precise = exact Euclidean distance `d`: `d ≤ size·spread → 1`, else `0.5·(1 − (d−solid)/(size+1−solid))`; Range/contour LUT; Center source = `1−edge` (`paint.rs:280-320`). Gradient glow coloured by `1−v`, opaque from `v = range²` (`:384-400`).
- Stroke: outside edge uses an exact EDT (Felzenszwalb-style `dt1`, `distance.rs:4`), inside the chamfer; positions Outside/Inside/Center (`effects/composite.rs:453-560, 614-635`).
- Gradient geometry for overlays/fills: Linear `(along−corner)/chord+.5`, Reflected `|…|/(chord/2)`, Radial `r/(len/2)`, Diamond `(|along|+|across|)/(len/2)`, Angle = clockwise sweep from the angle; `len = √((cos·w)²+(sin·h)²)`, `chord = min(w/|cos|, h/|sin|)` (`paint.rs:126-168`).
Cinemex has: drop shadow, glow, light sweep, gradient ramp (`layerfx.js:12-19`). New: Stroke, Inner Shadow, Inner Glow, Outer Glow Precise/contour/range, Satin, Bevel/Emboss, Pattern/Gradient overlay (5 geometries), Fill-vs-Opacity.
- (a) Canvas: Outer glow / drop shadow = `ctx.filter='blur()'` on the alpha (≈ Gaussian, not tent: close enough, guess). Stroke outside = dilate the alpha: exact with a jump-flood EDT in WebGL (my suggestion, not PhotoCraft code) or several `shadowBlur`+threshold passes. Inner shadow = blur(1−α) shifted, × α. Gradient styles: `createLinearGradient`, `createRadialGradient`, `createConicGradient` (Angle); Reflected/Diamond need a shader or per-pixel loop.
- (b) ffmpeg: alpha-only pipeline `alphaextract` → `gblur=sigma=size/2.5` (σ for a tent of width w ≈ w/√6·√2 ≈ 0.58w, guess) → `lut` for spread/contour → `geq`/`colorize` → `overlay`. Stroke outside N px: `alphaextract,gblur=sigma=N/2,lut='255*gte(val,8)'` (rounded, approximate) or repeated `dilation`. Inner shadow: `negate` alpha → `gblur` → shift with `pad/crop` → multiply by the original alpha (`blend=multiply`). Gradient overlays: `gradients` source (linear/radial/circular/spiral/square types) or `geq` with the formulas above.

### 3.5 Blend If — `crates/doc/src/blend_if.rs:43-57`
Per channel (Gray + R,G,B), two slider pairs (This Layer / Underlying), split points on 0..255: `w = ramp(blackLo, blackHi, v) · ramp(255−whiteHi, 255−whiteLo, 255−v)`; layer alpha ×= product of weights. ("Gray" = composite channel; I didn't confirm which luma formula. Guess: the same 0.3/0.59/0.11 lum.)
- (a) Canvas/WebGL: one-line shader (or a JS loop on the clip's ImageData before compositing).
- (b) ffmpeg: This Layer → `split; format=gray; lut='…ramp…'` → `blend=multiply` into the source alpha (or `alphamerge`). Underlying → the same LUT on the backdrop's gray → `maskedmerge=bg:fg:mask`. Uses: knocking black out of fire/smoke/light-leak footage with a soft ramp (better than `colorkey`), putting text "behind" bright sky.

### 3.6 Color to Alpha — `crates/algo/src/color_to_alpha.rs:1-25` (`opacity`:31, `remap`:50, `unmix`:64)
Per channel `a_i = (P−C)/(1−C)` if `P>C`, `(C−P)/C` if `P<C`; `a = max a_i`; `Q = C + (P−C)/a`; thresholds remap `a` linearly between transparency and opacity thresholds. Composited back over C it reproduces P exactly. Ideal for overlay assets on black or white (light leaks, smoke, sparks, film burns) without losing colour. (a) one fragment function. (b) `geq` with `r/g/b/a` expressions on `format=gbrap` (pure per-pixel, exact).

### 3.7 Blur Gallery — `crates/algo/src/gallery.rs`
σ = 0.6·blur (`:24-26`). Spatially varying blur = interpolation over 7 Gaussian levels `0, smax/2^5 … smax` (`:33-60`). Tilt-Shift: `d = |(p−c)·n| / shortSide`, `σ = smax·smoothstep(focus, focus+transition, d)` (`:146-160`). Iris: superellipse exponent `2+6·roundness/100`, `σ = blur·smoothstep(feather, 1, e)` (`:214-247`). Field: inverse-square interpolation of pin blurs (`:249`). Spin: arcs about ellipse centre. Path: motion along path tangents (`:337-340`).
(a) WebGL: blur pyramid (2-3 levels) + per-pixel mix by σ (or Canvas: draw a `filter:blur()` copy and mask it with a gradient, which is a 2-level approximation). (b) ffmpeg: `split=3` → `gblur=sigma=s/4`, `gblur=sigma=s` → two `maskedmerge` with `geq`-generated smoothstep masks (static per clip; render once as PNG and `loop`).

### 3.8 Lens Flare — `crates/algo/src/render.rs:109-200+`
Per pixel, additive (screen in 8-bit): core `exp(−(d/(core·s))²) + .35·exp(−d/(glow·s))` warm white; rays `(sin(12θ)·.5+.5)^8 + .6(sin(7θ+1.3)·.5+.5)^12` decaying; anamorphic streak (Movie Prime) `exp(−|dy|/2.5s)·exp(−|dx|/450s)` bluish; halo ring with ±4 % chromatic offset (35 mm); ghost discs at `c + (centre−c)·2t` with tint/size tables. `s = diag/1000`, brightness 10–300 %. Lens tables at `:128-150`.
(a) WebGL fragment shader (≈60 lines), animatable centre/brightness = flare tracking. (b) Render the flare per frame in Node with the same TS function (or one PNG if static) → `blend=screen`. Or `geq` (slow). Effort S.

### 3.9 Relight — `crates/algo/src/relight.rs:29-80, 229-302`
`σ = clamp(softness/100·0.08·shortSide, 2, 96)`; shading S = Gaussian(Rec.709 Y, σ) (3-box); normal = `norm(2·(S(x−k)−S(x+k)), 2·(S(y−k)−S(y+k)), 1)`, `k = round(σ) ≤ 32`; light dir `(cos a·cos e, −sin a·cos e, sin e)`; `out = c/max(S,.04) · (ambient + intensity·max(n·l,0)) · warmth` with warmth gains `[1+.15w, 1−.05w, 1−.25w]` (warm) or `[1−.2t, 1−.1t, 1+.15t]` (cool).
(a) WebGL 3 passes (luma, separable blur, shade). (b) ffmpeg: `split; format=gray; gblur=sigma=σ` → derivatives with `convolution` on a σ-downscaled copy (`scale=iw/k:-1`, 3×3 `0 0 0 -1 0 1 0 0 0`), upscale → `geq` combine. Doable but heavy: M.

### 3.10 Other per-pixel or cheap items
- Add Noise: hash of document coords; uniform ±50 % at 100 %, Gaussian ≈ 2σ (`algo/src/noise.rs`). Film Grain (gallery): `(hash−.5)·grain/20·.5·(.3+2.8L(1−L))` + highlight area (`artistic_fx.rs:656-665`).
- Gradient Fill/Map styles: §3.4 formulas. Dither = 4×4 Bayer (`adjust/color.rs:121-124`).
- De-Interlace / NTSC Colors (`algo/src/video.rs:10-58`): ffmpeg has `yadif/bwdif` and broadcast-legal limiting; skip.
- Halftone, Oil Paint, Kuwahara-based Paint Daubs, Neon Glow, etc. (Filter Gallery): stylistic, low priority.
- Unsharp Mask: Gaussian kernel, `v + amount·(v−blur)` with threshold (`algo/src/sharpen.rs:17-45`). ffmpeg `unsharp` is a box-ish kernel. Use `gblur` + `blend` for parity. Low priority.

### 3.11 Stills-only features (usable in Cinemex through `photocraft-cli` on one frame)
Content-Aware Fill / Remove (clean plate for a locked-off shot: extract a frame, run `photocraft-cli run frame.png --cmd <select…> --cmd <fill…> --out plate.png`, then overlay the plate in a masked region for the clip's duration; my suggestion), Select Sky (sky replacement on static shots), Seam carving, Liquify/Puppet. Exact command IDs for fill/remove: run `photocraft-cli commands | findstr /i fill` (not checked).

---

## 4. Already in Cinemex (don't duplicate)
From `src/lib/layerfx.js` (read) and the project memory note: per-clip colour (exposure, contrast, saturation, temperature, vignette, 7 looks, `.cube` via `lut3d`, histogram), masks (ellipse/rect/pen + RVM person matte), Fusion nodes (media, background, merge, transform, chroma, blur, glow, color, grain, letterbox), layer effects shadow/glow/light sweep/gradient ramp, 8 blend modes + track matte, captions/text via ASS, transitions, keyframes, frames/backgrounds, YuNet face tracking for reframing (`tools/clips/reframe.py`). PhotoCraft's YuNet port, person/subject selection and plain Gaussian blur/glow/grain add nothing.

---

## 5. Top 10 to port into Cinemex (ranked by value for video ÷ effort)

| # | Feature | Why for video | Port path | Effort |
|---|---|---|---|---|
| 1 | **Adjustment-stack → baked 3D LUT** (Levels, Curves natural spline, Hue/Sat with 6 ranges + colorize, Selective Color, Channel Mixer, B&W + tint, Photo Filter, Gradient Map, Color Balance, Vibrance, B/C, Posterize/Threshold/Invert) | real grading tools; one code path gives identical preview/export through the existing `lut3d` | TS port of §3.2 functions → 33³/65³ `.cube` → WebGL 3D texture / `lut3d` | M |
| 2 | **Camera Raw panel**: WB temp/tint, contrast, whites/blacks, vibrance, parametric + point curves, **8-band HSL mixer**, **3-way colour-grading wheels** + blending/balance | the colour page gets Lightroom/Resolve-style controls | GLSL port of `camera_raw.wgsl:283-416`; stages 1–7 baked into the LUT for export | M |
| 3 | **Full blend-mode set** (27 PS + Reflect/Glow/Negation) and the ffmpeg operand-order fix for burn/dodge/vivid/linear light | compositing overlays (light leaks, textures, titles) | canvas ops + small WebGL pass; `all_expr` table §3.1 | S–M |
| 4 | **Blend If** (soft luma ranges, This/Underlying) | knock black/white out of stock FX, text behind sky | shader / `lut` + `maskedmerge` | S |
| 5 | **Color to Alpha** | turns black-background FX into true RGBA without fringes | one per-pixel function; `geq` | S |
| 6 | **Layer styles: Stroke (out/in/center), Inner Shadow, Outer/Inner Glow (Precise, contour, range), Gradient Overlay (5 geometries)** | titles, stickers, keyed subjects (outline-the-person look) | alpha-distance + tent blur; canvas/WebGL; ffmpeg alpha pipelines §3.4 | M (Bevel/Satin: L, skip) |
| 7 | **Tilt-Shift + Iris + Field blur** | miniature look, background defocus, animated focus pulls | blur pyramid + smoothstep masks | M |
| 8 | **Lens Flare** (4 lens types, anamorphic streak, ghosts) | animated flare tracking a point | WebGL shader + per-frame render → `blend=screen` | S |
| 9 | **Clarity / Texture / Dehaze** | punchy footage, haze removal in drone shots | guided filter + band-pass; dark channel with a per-clip fixed atmospheric light (avoid flicker) | M |
| 10 | **Relight** (Retinex + Lambert lamp, angle/elevation/warmth/softness) | fix flat talking-head light, add a key light from a side | WebGL 3-pass; ffmpeg gblur + derivative + geq | M |

Honourable mentions: Shadows/Highlights (edge-aware, M), Dissolve mode (S), film-grain luma weighting `0.4+2.4L(1−L)` for the existing grain node (S), content-aware clean plate through `photocraft-cli` on one frame (S–M, static shots only), Select Sky via CLI (stills).

Effort key: S ≤ 1 day, M 2–4 days, L > 1 week (guesses for one developer familiar with Cinemex).
