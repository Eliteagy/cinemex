# LightCraft: reverse-engineering notes for porting to Cinemex

Sources:
- Source code: `github.com/storytold/lightcraft`, shallow clone of HEAD `27b755a9` (2026-11-17, workspace version **0.21.1**), at `F:\re-lightcraft-src\lightcraft\`. **C: was full** (0 MB free), so the clone went to F: and not to the scratchpad. It is source only: nothing was built or run.
- Installed build: `lightcraft-0.18.0-windows-x64-portable` (`lightcraft.exe` and `lightcraft-cli.exe`, about 125 MB each, statically linked Rust, no bundled asset folder: fonts and assets are inside the exe). I only ran `lightcraft-cli --help` and `lightcraft-cli controls`.
- **The version gap matters.** A strings check on the 0.18 binary finds the 21 looks (`lc.cine.teal-amber`), Point Color and SAM 3. It does **not** find `lens_blur_transition`, `detail_free` (process V8), `Crystal` grain (V7) or `nrc_joint` (V6 colour NR). Those are newer than the installed build.
- All `file:line` citations point at HEAD 27b755a. Paths are relative to `crates/`.
- Anything marked **[guess]** is my inference. Everything else is read from the code.

---

## 1. Architecture

### 1.1 Crates
Layering is enforced by `xtask layers` (`docs/architecture.md`). L0 is the lowest layer and L6 the highest.

| Layer | Crates | Role |
|---|---|---|
| L0 | `geom`, `color`, `raster`, `tiff`, `fetch`, `sysmem`, `wincolor` | Matrices and warps. Colour spaces (Rec.2020 working space, OkLab, CCT/Kelvin). Float buffers (`Rgb32f`, `Plane`) and Gaussian/box blurs. HTTPS downloads with pinned SHA-256. |
| L1 | `raw`, `codecs`, `meta`, `develop`, `denoise(-core)`, `faces`, `film`, `scenes`, `inpaint`, `lensdb`, `slideshow`, `geocode` | `develop` = **the edit model**: `DevelopSettings` plus one control-spec table. `codecs` decodes everything to linear light. `film` = negative conversion. `inpaint` = PatchMatch. `lensdb` reads the lensfun XML format. |
| L2 | `pipeline` | **CPU reference pipeline** (the "oracle"). Scene-referred float, resolution independent. |
| L3 | `gpu`, `catalog`, `preview`, `merge`, `segment` | `gpu` = a wgpu/WGSL compute **twin** of the pipeline, checked within 1/255 of the CPU. `merge` = HDR and panorama merge. `segment` = SAM 3 on candle. |
| L4 | `engine` | Sessions, a command registry ("everything is a command"), history, render and export jobs. |
| L5 | `ui-egui`, `mcp` | egui Lightroom-style UI and the MCP server (JSON-RPC over stdio). |
| L6 | `apps/lightcraft`, `apps/lightcraft-cli`, `apps/lightcraft-web` (WASM) | Desktop app, CLI, web build. |

### 1.2 Pipeline (CPU reference, `pipeline/src/lib.rs:1-22`)
Input is scene-linear **Rec.2020 D65** float. Output is display-encoded (sRGB curve) in the output primaries. Stages run in this order:
1. **Geometry**: orientation, lens corrections (distortion, CA, vignetting), perspective, crop, straighten, flips. All of it is **one** resample, followed by defringe.
2. **Scene-linear**: white balance, exposure, dehaze, local tone (highlights and shadows), texture, clarity, masks.
3. **Tone map**: contrast, whites and blacks on **luminance**, plus highlight desaturation.
4. **Colour**, in OkLCh: vibrance, saturation, colour mixer, point colour, colour grading, B&W.
5. **Display**: gamut map, then encode, then tone curves (parametric and point), vignette, grain, then the `.cube` LUT profile.

Key design points worth copying:
- **Spatial parameters are relative to the long edge.** A 400 px preview therefore looks the same as a 60 MP export. Cinemex has the same problem with a preview canvas versus a 1080p/4K export.
- **Spatial planes are precomputed and cached** (`Planes`, `local.rs:668-690`):
  - log luminance;
  - the guided-filter "base" (for highlights and shadows);
  - the clarity blur;
  - the texture blur;
  - the sharpen blur;
  - the dehaze dark channel;
  - the chroma blur.

  Dragging a colour or tone slider then only re-runs the per-pixel stage.
- **CPU and GPU share one parameter struct.** `FinishParams` (`pipeline/src/finish.rs:238-292`) is read by both the CPU loop and the WGSL kernel `gpu/src/wgsl/finish.wgsl` (802 lines), so they cannot drift apart. This is the same need Cinemex has between preview (canvas) and export (ffmpeg).
- **Process versions** (`develop` `Process::V1..V8`) freeze old maths so old edits keep their look (`docs/process-versions.md`). The installed 0.18 build is roughly ≤ V6 **[guess, from the strings check]**.

GPU details (`docs/gpu-pipeline.md`):
- The pipeline uses wgpu compute on DX12 (the Windows default), Metal or Vulkan, with no GL.
- WGSL kernels: `finish`, `blur`, `gauss`, `geom`, `mask`, `spot`, `map`, `hist`, `nrcj` (joint colour NR), `bm3d_*`, `nn_conv` and `faces_*` (neural nets on the GPU).
- On a GPU error it falls back to the CPU.

### 1.3 File formats
- **Edits**: `DevelopSettings` as JSON (`develop/src/settings.rs`). The library is an append-only op-log journal plus snapshots (`catalog/src/journal.rs`).
- **Interop**: XMP sidecars read and write with Adobe `crs:` mapping (`docs/xmp-interop.md`). Lightroom `.lrcat` import via a pure-Rust SQLite reader.
- **Presets**: `.lcpreset`, or an XMP preset. A preset is a **partial** settings JSON. `amount` (0–200 %) interpolates each named number between the photo's original value and the preset's value (`develop/src/presets.rs:1-13`).
- **LUT**: `.cube` (`LUT_3D_SIZE`, `DOMAIN_MIN/MAX`, red varies fastest). Applied **trilinearly** to the display-encoded colour and blended by the profile amount (`pipeline/src/lut.rs:1-47`).
- **Lens profiles**: lensfun-format XML supplied by the user (CC-BY-SA, so never bundled), converted to DNG `WarpRectilinear` / `FixVignetteRadial` polynomials (`lensdb/src/lib.rs`).
- **Decode** (`codecs`): JPEG, PNG, TIFF, WebP, GIF, BMP, PSD, JXL, HEIC (optional), plus raw (DNG/CR2/CR3/ARW/NEF/RAF/RW2/PEF/ORF/SRW).
- **Encode**: JPEG, PNG, TIFF, WebP, AVIF, JXL, PSD, DNG. HDR output as gain-map JPEG, PQ/HLG AVIF, or PQ PNG/JXL. Video: **AV1 MP4/WebM, slideshow export only** (`codecs/src/lib.rs`). LightCraft has **no video import or editing** (README feature table).
- **CLI** (`lightcraft-cli --help`, verified on 0.18):
  - `render IN -o OUT --set control=value --settings file --preset id --size N`
  - `run` (command pipeline)
  - `mcp`
  - `merge hdr|panorama`
  - `denoise-serve`
  - `controls --json`, which lists every slider id and range.

---

## 2. Conventions used below

- `smooth(a,b,x)` = smoothstep: `t=clamp((x-a)/(b-a),0,1); t*t*(3-2t)` (`finish.rs:18`).
- `log_l` = `log2(max(Y,1e-7)/0.18)`, the log luminance relative to middle grey, with `Y = 0.2627R+0.6780G+0.0593B` (Rec.2020 luma, `color/src/lib.rs:168`, `local.rs:656`).
- **OkLab** is standard Ottosson OkLab computed from linear Rec.2020: LMS = M1·rgb, cube root, then M2 (`color/src/perceptual.rs:55-69`). OkLCh hue is in radians.
- Slider values are in UI units (mostly −100..100). Code usually divides by 100.
- `px_per_long` = output pixels per long edge (e.g. 1920 for 1080p).
- **Porting colour space.** Cinemex works in sRGB/Rec.709. Exact parity means: decode sRGB, linearize, convert with the Rec.709→Rec.2020 matrix, process, convert back. Using linear Rec.709 with Rec.709 luma (0.2126, 0.7152, 0.0722) instead changes the results only slightly **[guess: visually negligible except for the gamut map]**.

---

## 3. Feature inventory: maths, ranges and how to port

Ranges come from the single control table `develop/src/controls.rs:175-301` (id, min, max, default, step). `lightcraft-cli controls --json` dumps it.

### 3.1 White balance: Temp and Tint
- **Ranges**: `wb.temp` 2000–50000 K (default 6500, step 50); `wb.tint` −150..150 (`controls.rs:178-179`). Presets: AsShot, Auto, Daylight, Cloudy, Shade, Tungsten, Fluorescent, Flash, Custom (`settings.rs:236`).
- **Maths for non-raw sources (JPEG/video)** (`local.rs:30-47`):
  1. `M = Bradford(white(T,tint)) · Bradford(asShot)^-1`. As-shot is 6500 K / 0 for rendered sources.
  2. Normalize the luminance of `M·(1,1,1)` so WB never changes exposure.
  3. Kelvin→xy uses the Kim 2002 Planckian cubic (1667–25000 K, extended linearly in mired outside that range). Tint moves perpendicular to the locus in CIE1960 uv, with `Duv = tint/3000` (`color/src/cct.rs:1-77`).
- **Raw sources** re-solve the camera matrices instead (DNG model). That is not relevant to video.
- **Mask-local Temp/Tint** is a cheap version (`finish.rs:777-782`): `R*=1+0.3t; G*=1-0.22tint; B*=1-0.3t`, then rescale to keep luminance.
- **Canvas/WebGL**: build a 3×3 matrix in JS and apply it to linear RGB. It is per-pixel, so it can be baked into a 3D LUT.
- **ffmpeg**: bake into a `.cube` and use `lut3d`. `colorchannelmixer` on **linear** data is also exact: `format=gbrpf32le` → `zscale=t=linear` → `colorchannelmixer=rr=..` → back. Cinemex's existing `temperature` slider could be replaced by this Kelvin model.

### 3.2 Exposure
- **Range**: `light.exposure` −5..5 EV (step 0.01). Maths: scene-linear gain `2^ev` (`finish.rs:316-317`, `adjust_scene_pixel` `finish.rs:741`).
- **Port**: in linear light, multiply. ffmpeg: in a baked LUT, or `colorchannelmixer` on linear data (or `exposure` filter, which works on linear float input).

### 3.3 Global tone map: Contrast, Whites, Blacks (`pipeline/src/tone.rs`)
- **Ranges**: −100..100 (`controls.rs:181-185`).
- It is applied to **luminance**, and colour is scaled by the same ratio (`finish.rs:544-556`):
  - `o = Tone(Y)`, then `rgb *= o/Y`;
  - if `max(rgb) > peak`, desaturate toward `o` by `t = (max-peak)/(max-o)`.
- **Display-referred sources (JPEG, so video)** use `ToneMap::display` (`tone.rs:284-331`). It is the identity at 0.

  ```
  p = Y^(1/2.2); m = 0.18^(1/2.2)
  p += c*0.35*(p-m)*(1-(2p-1)^2)                    // contrast S-curve anchored at 0, grey, 1
  p += w*0.12*smooth(0.45,1,p)*(1-0.5p)             // whites
  p += b*0.07*(1-smooth(0,0.45,p))*min(2p,1)        // blacks
  o = p^2.2; if edited and o>0.95: d=min(o-0.95,0.1); o=0.95+d-d²/0.2   // short shoulder
  ```

  Here `c, w, b` are the sliders divided by 100. The table has 4096 entries over −14..+10 EV around 0.18.
- **Raw sources** use `ToneMap::generic` (`tone.rs:241-282`):
  - slope = `1+0.55c` (or `1+0.4c` when c < 0);
  - white EV = `2.9-1.6w`;
  - extended Reinhard `y(1+y/wl²)/(1+y)`;
  - blacks: a soft-knee crush with `k=-b·0.035`, or a lift `k=b·0.03`.

  This is the filmic option if Cinemex ever gets log or raw footage.
- **Port**: per-pixel, so a 1D curve on luminance plus a ratio. That is **not** a per-channel 1D LUT, but it bakes exactly into a 3D LUT. ffmpeg: `lut3d`. WebGL: either sample the 4096-entry 1D texture with luminance, or use the baked 3D texture.

### 3.4 Highlights and Shadows: local tone (spatial)
- **Range**: −100..100 (`controls.rs:182-183`).
- **Base layer**: the fast **guided filter** (He & Sun) of `log_l` (`local.rs:274`):
  - σ = **1.5 % of the long edge**, ε = **0.35 EV²** (`local.rs:729,826-829`);
  - from V2 the base is taken of a **separable median** of radius `0.0015·long` (max 24 px), so thin lines don't count as tone (`local.rs:364-391`).
- **Per pixel** (`finish.rs:796-805`), with `base` = base plane + EV:

  ```
  sw = 1 - smooth(-4.8, 0.3, base);  hw = smooth(-1.0, 2.8, base)
  delta(stops) = sh*1.7*sw*sqrt(sw) + hl*1.7*hw ;  rgb *= 2^delta
  ```

- **WebGL**: needs a log-luma pass, then a guided filter. The fast guided filter is four Gaussian blurs of p and p² at 1/s resolution, then a, b and two more blurs, then a bilinear upsample. That is roughly 6–8 passes at ¼–⅛ resolution, so it is cheap. A plain large Gaussian base is acceptable for a first version but **halos** at edges.
- **ffmpeg**: has a `guided` filter (radius, eps, mode=basic|fast, sub; FFmpeg ≥ 5.0).

  ```
  split[s][g];
  [g]format=grayf32,<log via geq or lut>,guided=radius=R:eps=E:mode=fast:sub=4[base];
  [s]format=gbrpf32le[src];
  [base]format=gbrpf32le[b3];
  [src][b3]blend=all_expr='A*pow(2,<sh/hl expr of B>)'
  ```

  `blend` with `all_expr` sees `A` (the source channel) and `B` (base). It works on gbrpf32 planes. **[guess: geq/blend on float planes is slow (around 5–15 fps at 1080p); acceptable for export.]**

### 3.5 Clarity, Texture and Sharpening (all on log luminance)
- **Clarity** (−100..100):
  - plane = fast guided filter of `log_l`, σ = **1.2 % long edge**, ε = **0.8** (`local.rs:730,830`);
  - `d = clamp(log_l − blur, ±2.5)`, `delta += clar·0.85·d·(0.35+0.65·exp(-(base/3.2)²))`, so midtones are weighted (`finish.rs:815-822`).
- **Texture** (−100..100):
  - Gaussian σ = `max(0.0018·long, 0.6)` px (`local.rs:762-764`);
  - `d = log_l − blur`, `delta += tex·1.1·clamp(d,±1)·(1−0.6·smooth(0.4,1.6,|d|))` (`finish.rs:823-829`).
- **Sharpening**:
  - **Ranges**: Amount 0–150, Radius 0.5–3 px of the *original*, Detail 0–100, Masking 0–100 (`controls.rs:261-264`).
  - **V3+**: blur = exact Gaussian with σ = radius × px_per_long / native_long, clamped to [0.5, max] (`local.rs:769-784`). Then
    `term = 7·m·d/(1+|d|/limit)`, with `limit = 0.03·50^(detail/100)` and masking `m = smooth(0.1M, 0.1M+0.06, |d|)` (`finish.rs:34-56`). The result is `delta += (amount/150)·gain·term`.
  - V1/V2 sharpening used the texture band instead (`finish.rs:836-845`).
- All three are added to the same `delta` in **stops** and applied as `rgb *= 2^delta`. That is the core idea: every local-contrast tool is a luminance-only gain in log space, so colours never shift.
- **WebGL**: Gaussian passes (separable) on log luma, then one combine shader.
- **ffmpeg**:
  - Texture and sharpening are close to `unsharp=lx:ly:amount` on luma only; `cas` is a decent sharpening substitute.
  - Clarity needs a large radius, which `unsharp` (max 23 px kernel) can't reach. Use `gblur=sigma=S` (or `guided`) on luma, then `blend` with an expression as in 3.4.
  - Exact: build `log_l` and the blur planes, then one `blend all_expr` that implements the delta.

### 3.6 Dehaze (dark-channel prior)
- **Range**: −100..100.
- **Dark channel**: `min(R,G,B)` blurred by a Gaussian with σ = **2 % long edge** (`local.rs:734,832`).
- **Airlight A**: the **99.5th percentile** of every 7th dark-channel sample (`local.rs:948-967`). It is computed on a frame proxy so all windows share it.
- **Per pixel** (`finish.rs:756-774`):

  ```
  veil = clamp(min(dark/A_pre, minChannel/A), 0, 1)
  dehaze>0: t = max(1 - 0.95*min(d,1)*veil, 0.12);  rgb = max((rgb - A*(1-t))/t, 0)
  dehaze<0: k = min(-d,1)*0.7*(0.35+0.65*veil);     rgb += (0.9A - rgb)*k
  ```

- **Video note**: compute A **once per clip** (or smoothed over time), otherwise it flickers **[guess]**.
- **WebGL**: a min pass, a Gaussian, then the combine. A comes from the CPU off one sampled frame.
- **ffmpeg**: there is no native dehaze filter. Build it as:
  - `extractplanes` ×3 → `blend=all_mode=darken` ×2 → `gblur` → `[src][dark]blend=all_expr` with A as a constant baked into the expression.

  Effort M.

### 3.7 Tone curve: parametric plus point (`pipeline/src/curve.rs`, `finish.rs:58-81`)
- **Parametric**:
  - Shadows, Darks, Lights, Highlights: −100..100 each. Split points 10–70 / 20–80 / 30–90, defaults 25/50/75 (`controls.rs:193-199`).
  - Each region adds a cosine bump of half-width `(b−a)·0.75+0.05` centred on its window, and `y = x + d·4x(1−x)`. The result is clamped and **forced monotone** with a running max (`curve.rs:32-63`).
- **Point curves**: master, R, G and B. Monotone cubic Hermite (**Fritsch–Carlson**), so there is no overshoot (`color/src/spline.rs`). LUT order is `master ∘ parametric`, and each channel is `chan ∘ master ∘ parametric` (1024 entries).
- **Applied on encoded values** (sRGB curve) after the gamut map.
- **Refine Saturation** (0–100, `finish.rs:910-921`): rescales the curved colour's chroma around its luma by `k=(s0/s1)^(1−refine)` (max 4). It removes the saturation shift that RGB curves cause.
- **Port**: 1D LUTs, cheap. Canvas: a `Uint8Array`/`Float32Array` per channel. ffmpeg: `curves=master='..':r='..'`. ffmpeg `curves` uses a natural cubic spline, so **it overshoots**; better to bake into `lut3d` (or `lut1d` with a generated `.cube` 1D).

### 3.8 Vibrance and Saturation (OkLab chroma, `colorops.rs:189-220`)
- **Range**: −100..100.
- **Vibrance**:
  - `low = 1 − clamp(C/0.22, 0, 1)`;
  - skin protection (only when > 0): `skin = 1 − 0.6·exp(−(Δhue/0.35)²)`, with the skin hue = OkLCh hue of sRGB hue 25°;
  - `C *= max(0, 1 + v·low²·skin·1.2)`.
- **Saturation**: `C *= max(0, 1+s)` (plus the mask-local saturation).
- Applied in display-linear Rec.2020, after the tone map.
- **Port**: per-pixel, so bake into a 3D LUT. It is a direct upgrade of Cinemex's saturation, and vibrance with skin protection is valuable for people footage.

### 3.9 Colour Mixer (HSL), 8 bands (`colorops.rs:20-51, 222-235`)
- **Bands**: sRGB-HSV hues 0, 30, 60, 120, 180, 225, 270 and 315° (red, orange, yellow, green, aqua, blue, purple, magenta; `develop/settings.rs:419`), converted to OkLCh hues.
- **Weights**: a partition of unity, with a raised cosine between neighbouring band centres.
- **Per pixel**, with `cw = min(C/0.12, 1)`:
  - `h += Σw·hue_i·0.5 · cw` (hue slider ±100 → ±0.5 rad);
  - `C *= 1 + Σw·sat_i`;
  - `L += Σw·lum_i·0.18 · cw · sqrt(max(L,0.05))`.
- **B&W** (Treatment = Bw): the same 8-band weights; `L += Σw·bw_i·min(C/0.2,1)·0.25`, then `C = 0` (`colorops.rs:243-248`).
- **Auto B&W mix**: `auto.rs:109-144`.
- **Port**: bake into a 3D LUT. ffmpeg's `huesaturation` has only 6 colours with different maths, so use `lut3d`.

### 3.10 Point Color (`colorops.rs:60-130`; per-instance controls `controls.rs:305-415`)
- A sampled colour (OkLCh) plus Hue, Sat and Lum shifts (±100), Variance (±100), Range (0–100) and per-axis Hue, Sat and Lum ranges.
- Soft box weight: `w = wh·wc·wl`, each factor being `1−smooth(0.5W, W, |Δ|)`. Then the colour is rotated, scaled and shifted, and variance compresses toward the sample.
- This is the "make this exact green less green" tool, and it is good for brand colours.
- **Port**: bake into a 3D LUT.

### 3.11 Colour Grading: 3-way plus global wheels (`colorops.rs:149-154, 252-267`)
- **Ranges**: for each wheel (shadows, midtones, highlights, global), hue 0–360, sat 0–100, lum −100..100. Blending 0–100 (default 50) and Balance −100..100 (`controls.rs:235-248`).
- **Wheel to OkLab offset**: `a = 0.09·sat/100·cos(h)`, `b = …·sin(h)` (h = OkLCh hue of that sRGB hue), `L += 0.12·lum/100`.
- **Weights on OkLab L**:

  ```
  m = 0.5 − 0.25·balance;  width = 0.15 + 0.5·blending
  ws = 1 − smooth(m−width, m+0.25width, L);  wh = smooth(m−0.25width, m+width, L);  wm = max(0, 1−ws−wh);  global weight 1
  ```

- **Port**: bake into a 3D LUT. Canvas UI: the wheel is a polar picker that maps to (hue, sat). ffmpeg `colorbalance` is per-channel RGB lift/gamma/gain, so its maths differ; use `lut3d`.

### 3.12 Calibration (`colorops.rs:270-319`)
- Red, Green and Blue primaries, each with Hue and Sat (±100), plus Shadows Tint (±100).
- **Primaries**: each Rec.2020 primary is rotated by ±0.5 rad in OkLCh and its chroma scaled by 1±0.6. The resulting 3×3 is **re-normalized so white stays white**, and applied in scene-linear light before the tone map.
- **Shadows tint**: `G *= 1 − 0.3·t·(1−smooth(−5,−0.5,log2(Y/0.18)))`, luminance kept.
- **Port**: a 3×3 matrix. Canvas or WebGL: a mat3 uniform. ffmpeg: `colorchannelmixer` on linear data, or bake into the LUT.

### 3.13 Profiles: 21 "looks" (`pipeline/src/profiles.rs:45-235`)
- A profile is a set of **slider deltas** applied under the user's sliders, times `amount` (0–200 %).
  - Wheels are added as **colour vectors**, so a look's tint combines with the user's instead of replacing it (`profiles.rs:17-30`).
  - `fade` lifts black and lowers white on the point curve: `y → b + y(w−b)` (`profiles.rs:33-42`).
- **The looks** (fully listed in the source; copy the numbers verbatim):
  - Basic: neutral, vivid, landscape, portrait, mono.
  - Film: warm-print, cool-fade, golden-hour, faded-slide.
  - Cinematic: teal-amber, night-blue, desert-heat, neon-dusk.
  - Muted: matte-soft, bleached, pastel-haze, quiet-green.
  - B&W: mono-rich, red-filter, soft, sepia.
- Example, `lc.cine.teal-amber`: contrast +10, orange sat +6, green hue +20, green sat −20, blue hue −8, shadows wheel 195°/30, highlights wheel 38°/24.
- **Port: S.** It is pure data on top of features 3.7–3.11, and it **extends Cinemex's 7 looks to 21** with an amount slider. No look adds grain.
- A `.cube` profile (`lut:` id) is applied last on encoded values, blended by amount (`finish.rs:676-694`). Cinemex already has this.

### 3.14 Vignette, post-crop (`finish.rs:84-108, 568-596`)
- **Ranges**: Amount −100..100, Midpoint 0–100 (50), Roundness −100..100, Feather 0–100 (50), Highlights 0–100. Style: HighlightPriority, ColorPriority or PaintOverlay.
- **Parameters**:
  - `start = 0.15+0.95·mid/100`;
  - `width = 0.05+1.1·feather/100`;
  - roundness r: `aspect_mix=(r+1)/2`; the superellipse power is 2 for r ≥ 0, else `2+6(−r)`.
- **Distance**: on [−1,1] coordinates, aspect-mixed: `dist = (|u|^p+|v|^p)^(1/p)`, then `t = smooth(start, start+width, dist)`.
- **Darken (amount < 0)**: `f = 1+amount·t`. HighlightPriority adds `(1−f)·hl·smooth(0.4,1,lum)` back. PaintOverlay uses `rgb*(1−|a|t)`.
- **Lighten**: `c += (1−c)·a·t·0.85`.
- Applied on display-linear values, before the curves.
- **WebGL**: one fragment shader using the uniforms above.
- **ffmpeg**: the native `vignette` filter has different maths. Exact route:
  1. render a **gain mask** (16-bit gray PNG) in JS with the same function (it depends only on frame size and params);
  2. `[v][mask]blend=all_mode=multiply` for darkening;
  3. for lightening, `screen` with mask `= a·t·0.85` is the same formula, since `c + m(1−c)` = screen.

  Caveat: blend runs on encoded values while LightCraft uses linear values. Accept it, or wrap in `zscale` linear↔sRGB. HighlightPriority needs `blend all_expr`.

### 3.15 Film grain (`finish.rs:111-180, 655-669`; crystal model `crystal.rs`, `docs/grain.md`)
- **Ranges**: Amount 0–100, Size 0–100 (25), Roughness 0–100 (50), plus a seed.
- **Value-noise grain (processes V1–V6, the one in the installed 0.18)**:

  ```
  cell = max((0.0006 + 0.0024·size/100)·px_per_long, 0.6) px;  amt = 0.13·amount/100;  r = roughness/100
  v = n(p/cell)·(1−0.5r) + n(2.3p/cell, seed^0x55)·0.7r        // n = smoothstep-interpolated hash value noise, GRAIN_HASH consts finish.rs:111
  lum = Rec709 luma of encoded rgb;  rgb_enc += amt·v·(0.35 + 2.6·lum(1−lum))
  ```

- **Crystal grain (V7+, not in 0.18)**: stacked Boolean layers of polygon crystals, after Aurélien Pierre 2023. Each layer is precomputed as a torus tile (1280/1134 px) with summed-area tables. It is applied as `e += k·g·(1−lin(lum))·lift(e)`, calibrated to Lightroom (`crystal.rs:117-121, 1070-1077`). Too heavy for real-time video **[guess]**; the value noise is enough.
- **Video**: the seed must change **per frame** (frame index ^ seed), otherwise the grain is frozen on screen.
- **WebGL**: port the hash and value noise to GLSL (integer hash in WebGL2), about 20 lines.
- **ffmpeg**:
  - quick: `noise=alls=N:allf=t+u` (temporal uniform; different spectrum, no luminance weighting);
  - exact: generate a grain plate (a short looping clip rendered from the same JS), then `blend=all_expr='A+K*(B-0.5)*(0.35+2.6*A*(1-A))'` on normalized values.

### 3.16 Noise reduction (`local.rs:457-575`)
- **Ranges**: Luminance 0–100 with Detail (50) and Contrast; Color 0–100 with Detail (50) and Smoothness (50).
- **Luminance NR**:
  - self-guided filter of `log_l` with σ = `(1+2.5·lum)·scale` px, `eps=(0.002+0.25·lum²·(1−0.7·detail))·scale²`;
  - `rgb *= 2^((f−l)·sqrt(lum))`;
  - `scale` = output px per original px, so previews match exports.
- **Colour NR (≤ V5)**: blur the chromaticity `rgb/Y` with a Gaussian of σ = `(1.5+6·col)·scale·(1+smoothness)`, mix it in by `t=col·(1−0.5·colorDetail)`, then re-multiply by Y.
- **Colour NR (V6+)**: joint-guided linear NR (`nrc_joint.rs`, `docs/nr-color-joint.md`).
- **BM3D** exists on the GPU (`wgsl/bm3d_*`).
- **Video port**: use ffmpeg's own temporal denoisers (`hqdn3d`, `atadenoise`, `nlmeans`, `bm3d`), which beat any spatial-only photo NR on video. For colour NR, `gblur=sigma=S:planes=6` blurs only U/V in YUV, which is the same idea as the chromaticity blur. Preview in WebGL: a chroma blur shader. **[recommendation, not LightCraft]**

### 3.17 Optics: lens corrections (`pipeline/src/optics.rs`)
- **Manual distortion** (−100..100): `k1 = −0.2·d/100`, and source radius = `r(1+k1·r²)` with r relative to the **half diagonal** (`optics.rs:28,80,168-174`).
- **Manual vignetting** (−100..100) and midpoint: gain `2^(1.5·v/100 · r^(1+6·mid/100))`, with r relative to the half diagonal, capped at 1.5 (`optics.rs:30,81-82,238-244`).
- **Lateral CA**: Red/Cyan and Blue/Yellow ±100. Per-channel radial scale `1 + 0.003·v/100` around the centre (`optics.rs:32,83,192-195`). There is also an automatic estimator (`estimate_lateral_ca`).
- **Defringe**: purple and green, amount 0–20 plus hue ranges. Inside a min/max-lightness edge window, OkLab chroma is desaturated by hue weight (`optics.rs:620-680`).
- **Profile corrections**: DNG opcodes or lensfun profiles.
- **Port**:
  - Distortion → ffmpeg `lenscorrection=k1=…:k2=0` (it also normalizes by the half diagonal **[verify against ffmpeg docs]**). WebGL: a UV remap in the fragment shader.
  - CA → per-channel UV scale in the shader. ffmpeg: `extractplanes`, `scale` R and B by (1+k), `crop` or `pad` back, `mergeplanes`.

  Useful for action-cam and phone footage.

### 3.18 Geometry: transform, Upright, straighten, crop
- **Ranges**: Vertical and Horizontal keystone ±100, Rotate ±10°, Aspect ±100, Scale 50–150, Offset X/Y ±100, Straighten ±45° (`controls.rs:284-301`).
- The sliders are composed into **one homography**. Keystone is modelled as a virtual camera rotation `K·R·K⁻¹` with focal length 1.5 (in half-long-edge units), re-centred (`transform.rs:1-13,71`).
- **Upright** (Auto, Level, Vertical, Full, Guided) (`upright.rs`):
  1. own line-segment detector;
  2. RANSAC vanishing points;
  3. a rotation homography.
- **Auto straighten** (`straighten.rs`): plumb lines, then horizon detection, then the consensus of long lines; nothing beyond `MAX_DEGREES` is levelled.
- **Port**:
  - homography → WebGL vertex/UV transform;
  - ffmpeg `perspective=x0:y0:…` with the 4 corner points computed in JS from the homography;
  - auto straighten on one sampled frame works for locked-off shots: effort L for the line detector, or port only the horizon cue (M).

### 3.19 Masking: local adjustments (`pipeline/src/masks.rs`, `develop/settings.rs:961-1130`)
- **Component shapes** (`masks.rs:218-322`):
  - **Linear** gradient: `t=(p−a)·d/|d|²`, alpha = `1−smooth(0,1,t)`.
  - **Radial**: ellipse centre, rx, ry, angle, feather; `r = ‖rotated/(rx,ry)‖`, alpha = `1−smooth(1−f,1,r)`, optional invert.
  - **Brush**: strokes with size, feather, flow, density, pressure, erase and auto-mask.
  - **Luminance range**: `y=(log_l+ev+8)/12` (−8..+4 EV mapped to 0..1), alpha = `smooth(lo−lf,lo,y)·(1−smooth(hi,hi+hf,y))`.
  - **Colour range**: up to 64 OkLab samples; `d = min_s √(Δa²+Δb²+0.25ΔL²)`, alpha = `1−smooth(tol/2,tol,d)`.
  - **Depth range**: model only, not rendered.
  - **AI**: Subject and Sky are **classical heuristics** (centre-weighted local contrast; "bright, smooth, blue, top of frame"). Object (clicks) and Prompt (text) use **SAM 3** logits, guided-filtered by log luminance so the edge snaps to the photo. People and Landscape exist too.
- **Combining** (`masks.rs:160-215`):
  - components combine as Add = max, Subtract = `a(1−c)`, Intersect = `a·c`, each with optional invert;
  - **Refine Edges**: a cross guided filter of alpha with log_l (σ up to 4 % long edge, eps 0.02);
  - then the mask-level invert and Amount.
- **Local adjustments** (`settings.rs:884-924`, `finish.rs:204-234`): exposure, temp, tint, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, hue, saturation, sharpness, noise, moiré, defringe, lens blur (amount, boost, transition), colour overlay (hue and sat) and amount.
  - Each mask's terms are **alpha-weighted and summed** per pixel, then fed into the same delta-in-stops engine as the global sliders.
  - Local whites, blacks and contrast are themselves log-domain deltas: `0.8·smooth(0.5,3,L)`, `0.8·(1−smooth(−6,−1.5,L))` and `0.14·clamp(L,−6,4)` (`finish.rs:806-814`).
  - The colour overlay shifts OkLab a/b by `0.08·amount` toward the hue (`finish.rs:562-566`).
- **Video port**:
  - WebGL: compute alpha in the shader for linear and radial (with keyframable params), then mix the adjusted and original colour.
  - ffmpeg: `split` → graded branch (its own `lut3d` plus spatial ops) → `maskedmerge` (source, graded, mask). The mask is a static PNG (`-loop 1`) or a rendered mask video for keyframed or tracked masks. A linear or radial mask with constant parameters can also be generated in-graph with `geq` (X, Y, W, H, T available).
- **Effort**: L, including UI and keyframes.

### 3.20 Lens Blur: fake shallow depth of field (`pipeline/src/lens_blur.rs`)
- **Ranges**: Amount 0–100 (max CoC = **3.5 % long edge**), Boost 0–100, Transition 0–100 (up to 15 % long edge, not in 0.18). There is also a focus mask and Focus/Blur brushes.
- **Two-depth model**: focus = subject mask; `CoC = R·(1−focus)`.
- **Blur**: 4 disc-blur levels on coarse grids, using **normalized convolution weighted by out-of-focus-ness** so there is no halo around the subject. Boost: `gain = 1+4·boost·smooth(0.5,1,Y)` before blurring, which produces bokeh discs.
- **Port**: WebGL with a few disc-blur passes plus a mix. ffmpeg: `gblur` or `avgblur` plus `maskedmerge` with a subject mask (that needs segmentation). L.

### 3.21 Spot removal: Heal, Clone, Fill (`pipeline/src/spots.rs`, `crates/inpaint`)
- **Clone**: copy the source patch with a feathered edge.
- **Heal**: `result = src + blur(target − src)`, frequency separation, blur σ = `max(0.6·r,1)` (`spots.rs:4,421`).
- **Remove**: Heal with the source picked automatically, by scoring ring candidates on annulus match.
- **Fill**: PatchMatch completion (Barnes 2009 / Wexler 2007), deterministic.
- **Port to video**: only for locked-off shots (static logo or dust): `delogo` is a rough ffmpeg equivalent; heal = overlay a blurred-difference patch. Moving shots need tracking, which is out of scope.

### 3.22 Red eye / pet eye, dust detection, blemish detection, culling
Photo-specific (`redeye.rs`, `dust.rs`, `blemish.rs`, `cull.rs` = focus, clipping and burst signature). Low value for video, except `cull.rs`'s focus/sharpness score, which could rank takes **[guess]**.

### 3.23 Auto features (`pipeline/src/auto.rs`)
- **Auto Tone** (`auto.rs:91-104`):
  - `exposure = clamp(−0.58 − 0.41·mean(log2(Y/0.18)), −2, 3)` over a 512 px proxy;
  - then a fixed recipe: Contrast +68, Highlights −66, Shadows +52, Vibrance +30, Whites/Blacks/Saturation 0;
  - calibrated against Lightroom Auto on 24 raws (median dE76 6.4).
  - The fixed recipe was fitted on raws. Video (display-referred) needs smaller values **[guess]**.
- **Auto WB** (`auto.rs:146-175`):
  - grey-world on a 256 px proxy, weighted `(1−chroma)²·(1−min(|log2Y+2.5|/4,1))` (mid-tone, low-chroma pixels);
  - the average is turned into xy through the Bradford/camera model, then into (T, tint).
- **Auto B&W mix** (`auto.rs:109-144`): pushes each hue band away from the mean lightness, by `sep·400` clamped to ±60.
- **Port**: S. Grab one frame (or a few) through canvas `getImageData` and run the formulas in JS. Results go into the settings, so ffmpeg needs nothing new.

### 3.24 HDR editing (`settings.rs:1462-1514`, `tone.rs`)
- `hdr.maxEv` 0–5 (default 3); peak = `2^maxEv`. There are SDR-rendition sliders (brightness, contrast, highlights, shadows, whites, clarity).
- Highlights get lifted above SDR white along `smooth(1.5 EV, top, ev)`.
- **Output**: gain-map JPEG, PQ/HLG AVIF, PQ PNG/JXL.
- **Video relevance**: only if Cinemex targets HDR10/HLG delivery (`zscale` / `libx265` with PQ). Low priority.

### 3.25 AI features (all optional and model-gated)
- **AI Denoise** (`crates/denoise`):
  - ONNX models on **Bayer raw before demosaic**, tiled, with a CPU and GPU runner;
  - remote GPU serving over TCP (`denoise-serve`);
  - the weights are user-installed.
  - Not applicable to video frames (raw only; X-Trans and linear RGB are "missing").
- **SAM 3 segmentation** (`crates/segment`): Meta's SAM 3 checkpoint (SAM License, user download) on candle; Metal on macOS, otherwise CPU. Point prompts and **text prompts** ("the red car"). The image encoder is a 32-layer ViT at 1008². Per video frame this is far too slow on CPU **[guess]**. A video port would need SAM 2/3 video propagation, which is not in LightCraft.
- **Faces**: YuNet detection plus recognition through ONNX, run on a pure-Rust interpreter.
- **Inpaint**: PatchMatch, not generative.
- **Super Resolution**: not implemented.
- **Photo Merge**: HDR merge (align, deghost) and panorama (features, RANSAC, bundle adjustment, multi-band blending). These are stills tools.

### 3.26 Workflow and infrastructure ideas worth copying
- **One control-spec table** (id, label, section, min, max, default, step, decimals, track style) drives the UI sliders, clamping, presets, MCP and the CLI (`controls.rs:1-160`). Cinemex could do the same for `clip.color`: one TS table, with an agent (Claude/MCP) setting `color.vibrance=20` by id.
- **Presets as partial JSON plus an amount (0–200 %)** that interpolates from the original value. Copy, paste and sync use the same setting groups (`presets.rs`).
- **Disabled sections**: a per-panel on/off eye (`DevelopSettings.disabled_sections`) gives before/after per panel.
- **Process versions**: when the maths change later, old projects keep rendering identically. This is important once Cinemex has clients' projects saved.
- **Diagnostic overlays** (`visualize.rs`):
  - Alt-drag clipping views;
  - mask overlay modes;
  - gamut warnings;
  - a sharpen-mask preview.

  The Alt-drag clipping view is cheap to add on top of Cinemex's histogram.
- **Ordered 8×8 Bayer dithering** when quantizing to 8-bit (`finish.rs:948-980`). It prevents banding in skies and gradients. ffmpeg equivalent: export at 10-bit, or `format=…:dither` in `zscale` (`dither=error_diffusion`).

---

## 4. Recommended Cinemex architecture for these features

1. **One TypeScript "develop" function** mirrors LightCraft's `finish` order for the **per-pixel** chain:
   WB matrix → exposure → calibration → display tone map (contrast/whites/blacks) → OkLab colour ops (mixer, point colour, vibrance/sat, B&W, grading) → gamut clamp → sRGB encode → curves (+ refine sat) → profile look deltas (resolved into the settings beforehand) → `.cube` LUT.
2. **Bake it into a 3D LUT** (33³ for preview, 65³ for export) whenever the settings change:
   - the preview uploads it as a WebGL2 3D texture (`TEXTURE_3D`, trilinear or tetrahedral in-shader);
   - the export writes a `.cube` and adds `lut3d=file=…:interp=tetrahedral` to `render.cjs`.

   This gives **preview/export parity by construction**, like LightCraft's shared `FinishParams`. Precision: do it on 16-bit or float frames where possible (`format=gbrpf32le` before `lut3d`, or `rgb48le`). Accuracy: for 8-bit Rec.709 video with a display-referred tone map, a 33³ LUT is visually exact **[guess, typical]**.
3. **Spatial ops** (highlights/shadows, clarity, texture, sharpen, dehaze, vignette, grain, masks) stay outside the LUT:
   - preview: WebGL passes (`gpu/src/wgsl/finish.wgsl`, `blur.wgsl` and `gauss.wgsl` are the reference to translate by hand);
   - export: ffmpeg `guided` / `gblur` / `blend all_expr` / `maskedmerge`.

   For exact LightCraft order, local tone sits **before** the tone map. Use LUT-A (WB+exposure, linear out) → spatial → LUT-B (tone and colour), or accept applying local tone before a single LUT **[simplification]**.
4. Keep Cinemex's 2D canvas for compositing. Run the colour stage in an offscreen WebGL2 canvas per clip frame, then `drawImage` the result. JS per-pixel at 1080p (2 M px × OkLab cube roots) is far too slow for 30 fps **[guess: >100 ms/frame]**.

---

## 5. Top 10 features to port to a video editor (ranked)

| # | Feature | Why for video | Preview | Export (ffmpeg) | Effort |
|---|---|---|---|---|---|
| 1 | **Baked LUT colour engine**: Kelvin/tint WB (Bradford), exposure, display tone map (contrast/whites/blacks) | Foundation for 2–5. Replaces the ad-hoc exposure/contrast/temperature with matched preview and export | WebGL2 3D-texture LUT | generated `.cube` → `lut3d` | M |
| 2 | **Colour Grading wheels** (shadows/mid/highlights/global, blending, balance) | Core of a "cinematic" grade, which clients ask for | in LUT | in LUT | S (after #1); M with the wheel UI |
| 3 | **Vibrance (skin-protected) + 8-band HSL mixer** | Skin-safe saturation and colour-targeted fixes (sky, grass, brand colour) | in LUT | in LUT | S |
| 4 | **21 looks as slider deltas with amount 0–200 %** | Immediately expands 7 looks to 21, editable underneath | data only | data only | S |
| 5 | **Tone curve**: parametric 4-region + point RGB curves (Fritsch–Carlson) + Refine Saturation | Standard grading tool; monotone, no overshoot | 1D LUTs / in LUT | in LUT (avoid `curves` overshoot) | M (curve editor UI) |
| 6 | **Highlights/Shadows** (guided-filter local tone, delta in stops) | Recover phone/drone skies and faces; the most-used Lightroom pair | WebGL fast guided filter | `guided` + `blend all_expr` | M–L |
| 7 | **Clarity / Texture / Sharpen** (log-luma bands) | "Pop" for real-estate and talking-head footage; shares #6's infrastructure | WebGL Gaussian passes | `gblur`/`unsharp`/`cas` + `blend` | M |
| 8 | **Auto Tone + Auto WB + Auto B&W** from a sampled frame | One-click starting point per clip; pure JS statistics | JS on `getImageData` | none (writes settings) | S |
| 9 | **Vignette (Lightroom post-crop) + per-frame film grain** | Cinematic finish; the current vignette is a single number | one shader | mask PNG + `blend` multiply/screen; grain plate or `noise` | S |
| 10 | **Masks: linear, radial, luminance range, colour range** with local exposure/temp/sat/clarity | Sky darkening, face lift, background desaturation | alpha in shader + mix | `maskedmerge` (+ `geq`-generated or PNG mask) | L (keyframes/tracking) |

Not in the top 10, but next:
- **Dehaze** (M; dark channel + per-clip airlight).
- **Lens distortion/CA** (S; `lenscorrection`).
- **Point Color** (S, in LUT).
- **Calibration primaries** (S, in LUT).
- **Perspective / auto-straighten** (L).
- **Lens Blur** (L; needs segmentation).
- **8×8 Bayer dither / 10-bit export** against banding (S).

Out of scope for video: SAM 3 (too slow per frame), AI Denoise (raw-only), Photo Merge, Fill/Heal (static shots only).

---

## 6. Facts vs guesses summary
- **Facts**: every formula, constant, range and file:line above, read from source HEAD 27b755a; the CLI help and the control count from the installed 0.18 binary; the absence in 0.18 of crystal grain, V8 detail-free base, joint colour NR and lens-blur transition (from binary string counts).
- **Guesses** (marked inline):
  - performance estimates (JS per-pixel, geq/blend speed, SAM 3 per frame);
  - the ffmpeg `lenscorrection` normalization matching LightCraft's;
  - the installed 0.18 being around process V6;
  - LUT 33³ accuracy;
  - auto-tone recipe values needing retuning for display-referred video;
  - per-clip airlight against flicker.
