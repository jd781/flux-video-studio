# FLUX Video Studio

A video generation studio wired to real **fal.ai Seedance** models. It takes
the creative controls, keyframing, reference images, native audio, and upscaling
from the UI and sends them to fal.ai to produce actual videos.

## Model picker

Pick the generation model in the Controls panel. The UI adapts to each model's
real capabilities (resolution options, duration range, reference-image limit):

| Model          | Resolutions         | Max duration | Max ref images | Edit/extend task |
| -------------- | ------------------- | ------------ | -------------- | ---------------- |
| Seedance 2.0 Fast | 480p, 720p       | 15s          | 9              | no               |
| Seedance 2.5   | 480p, 720p, 1080p   | 30s          | 30             | yes              |

A **model family** dropdown sits above the model cards (Seedance, FLUX 3).

### FLUX 3 (Black Forest Labs, via fal)

Endpoints live under `blackforestlabs/flux-3/`: text-to-video, image-to-video,
first-last-frame-to-video, keyframes-to-video (24 fps frame indices), and
extend-video, each with a `/draft` twin (720p, cheap preview).

- Resolutions: 720p, 1080p, plus 2K/4K for text and image modes only.
- Duration 5-20s, aspect ratios incl. 21:9, 2:1, 4:3, 3:4, and auto.
- No seed input. `safety_tolerance` (0-4) is in Advanced.
- Draft takes can be enhanced to 1080p via `/api/enhance` (`draft-enhance`).
- Prices use fal's published per-second rates. fal's pricing API reports half
  of those; if real billing matches that, set `FLUX3_BILLING_SCALE = 0.5` in
  `src/utils/flux3.ts`.
- FLUX 3 Max uses a different schema and is not included.

Capabilities live in one place: `src/utils/modelCatalog.ts`. Both the UI and the
fal client read from it, so adding another model is a single catalog entry plus
its endpoint IDs.

> Previously this project was a proof-of-concept: generation and upscaling were
> simulated and uploaded files never left the browser. It now makes real API
> calls to fal.ai.

## How it works

- The browser never holds your fal.ai key. A small **Express proxy**
  (`server/index.ts`) keeps `FAL_KEY` server-side and forwards requests to fal.
- The frontend fal client is pointed at that proxy (`/api/fal/proxy`). In dev,
  Vite proxies `/api/fal` to the Express server.
- Uploaded images/videos (held in the browser as base64) are uploaded to fal
  storage first, then their hosted URLs are sent to the model.

### Workflow mode → fal.ai endpoint

Endpoint IDs come from the selected model's catalog entry. For Seedance 2.5 the
reference endpoint also sets a `task` (`reference` / `extension`).

| UI workflow mode    | Endpoint (per model)                             |
| ------------------- | ------------------------------------------------ |
| Text to Video       | `.../text-to-video`                              |
| Image to Video      | `.../image-to-video`                             |
| Keyframe Pair       | `.../image-to-video` (with `end_image_url`)      |
| Timeline            | `.../reference-to-video` (keyframes as refs)     |
| Extend & Edit       | `.../reference-to-video` (source video as ref; 2.5 uses `task: extension`) |
| Upscale (1080p/4K)  | `fal-ai/topaz/upscale/video` (factor 2 / 4)      |

### Parameter mapping notes

- **Resolution**: mapped per model. Draft tier → the model's lowest resolution
  (480p); Full Quality → the model's highest (720p for 2.0, 1080p for 2.5).
- **Duration**: clamped to the model's max (15s for 2.0, 30s for 2.5).
- **Native audio**: maps to Seedance `generate_audio`.
- **Reference field names** are `image_urls` / `video_urls` on both 2.0 and 2.5
  (only 2.5 also accepts `task`).
- **Failures**: the server translates fal errors into a plain reason plus a
  suggested fix (`server/errors.ts`), and the app runs a pre-flight check
  (`src/utils/validateGeneration.ts`) before submitting so missing inputs are
  caught without spending a generation.
- **Seed**: passed through; fal returns the actual seed used.
- `guidanceScale`, `transformationStrength`, and `inferenceSteps` are UI-side
  creative controls that Seedance's API does not expose, so they are not sent.
  They still drive the on-screen cost estimate and progress display.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add your fal.ai key. Copy the example env file and paste your real key:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env`:

   ```
   FAL_KEY="your-real-fal-key"
   ```

   Get a key at https://fal.ai/dashboard/keys. `.env` is gitignored.

3. Start both the proxy server and the dev server together:

   ```bash
   npm run dev
   ```

   - App: http://localhost:3000
   - Proxy: http://localhost:3001 (health check: `/api/health`)

## Scripts

| Script          | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `npm run dev`   | Runs the fal proxy and Vite dev server together         |
| `npm run server`| Runs only the fal proxy (`tsx watch`)                   |
| `npm run vite`  | Runs only the Vite dev server                           |
| `npm run build` | Production build of the frontend                        |
| `npm run lint`  | Type-check with `tsc --noEmit`                          |
| `npm run clean` | Remove the `dist` build output                          |

## Cost

Real generation bills your fal.ai account. See the Seedance 2.0 and Topaz
upscale pricing on fal.ai. The "credits"/dollar figures shown in the app are a
rough on-screen estimate only and are not tied to fal billing.

## Security

- `FAL_KEY` is only ever read server-side (in `server/index.ts`). It is never
  bundled into client code.
- The proxy is locked to the Seedance and Topaz endpoints this app uses, so it
  can't be used as an open relay against your account.
- For any public deployment, protect the proxy route with your own auth
  (see `isAuthenticated` / `allowUnauthorizedRequests` in the fal proxy config).
