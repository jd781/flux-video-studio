import { fal } from '@fal-ai/client';
import {
  AspectRatio,
  FluxGenerationParams,
  ModelResolution,
  WorkflowMode,
} from '../types/flux';
import {
  clampDurationForModel,
  getModel,
  resolveOutputResolution,
} from '../utils/modelCatalog';
import { flux3KindForMode, keyframeFrameIndex } from '../utils/flux3';

/**
 * fal.ai client integration for FLUX Video Studio.
 *
 * The browser never sees FAL_KEY. All requests go through the local Express
 * proxy at /api/fal/proxy (see server/index.ts), which attaches the key.
 *
 * The specific Seedance model (2.0 or 2.5) and its endpoints come from the
 * model catalog (utils/modelCatalog.ts), keyed on params.modelId.
 */
fal.config({
  proxyUrl: '/api/fal/proxy',
  // Queue submits are NOT idempotent: a retried submit creates a second
  // generation (and a second charge) rather than recovering the first.
  // Disable automatic retries so one submit can never fan out into two.
  retry: { maxRetries: 0 },
});

// Module-level guard against a submit being issued twice for the same in-flight
// generation (e.g. a same-tick double trigger before React state updates).
let generationInFlight = false;

// Seedance aspect ratios overlap with the app's (16:9, 9:16, 1:1).
type SeedanceAspectRatio =
  | '21:9'
  | '16:9'
  | '4:3'
  | '1:1'
  | '3:4'
  | '9:16'
  | 'auto';

export interface FalProgress {
  /** 0-100 best-effort progress derived from queue status + logs. */
  percent: number;
  /** Human-readable status message to show in the progress UI. */
  message: string;
  /** Coarse phase mapped onto the existing GenerationQueueStatus phases. */
  phase: 'queued' | 'denoising' | 'encoding';
}

export interface GeneratedVideoResult {
  videoUrl: string;
  seed: number;
  resolution: ModelResolution;
  requestId: string;
  /** FLUX 3 draft renders only: pass to enhanceDraft() for a full-quality render. */
  draftCacheUrl: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDataUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('data:');
}

function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Convert a data: URL (base64) to a Blob so it can be uploaded to fal storage. */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * Ensures a media URL is a public, fal-reachable URL.
 * - data: URLs (user uploads held in the browser as base64) are uploaded to
 *   fal storage and replaced with the returned hosted URL.
 * - http(s) URLs (presets / already-hosted) are passed through unchanged.
 * Returns null for anything falsy.
 */
export async function ensureHostedUrl(
  url: string | null | undefined
): Promise<string | null> {
  if (!url) return null;
  if (isHttpUrl(url)) return url;
  if (isDataUrl(url)) {
    const blob = await dataUrlToBlob(url);
    return fal.storage.upload(blob);
  }
  // Unknown scheme (e.g. blob:) — try to fetch & upload, else drop it.
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return fal.storage.upload(blob);
  } catch {
    return null;
  }
}

/** Upload a list of media URLs, dropping any that fail. */
async function ensureHostedUrls(urls: string[]): Promise<string[]> {
  const results = await Promise.all(urls.map((u) => ensureHostedUrl(u)));
  return results.filter((u): u is string => Boolean(u));
}

/** Map the app's aspect ratio to a Seedance-accepted value. */
function mapAspectRatio(ar: AspectRatio): SeedanceAspectRatio {
  // Seedance accepts every app ratio except 2:1 (a FLUX 3 ratio).
  return ar === '2:1' ? '16:9' : ar;
}

// ---------------------------------------------------------------------------
// Input building per workflow mode + model
// ---------------------------------------------------------------------------

interface SeedanceInputBase {
  prompt: string;
  resolution: ModelResolution;
  // Seedance's duration field is a string enum ("4".."30" or "auto"), not a number.
  duration: string;
  aspect_ratio: SeedanceAspectRatio;
  generate_audio: boolean;
  seed?: number;
}

/**
 * Decides which endpoint to use for a given workflow mode under the selected
 * model, and builds the matching input payload. Uploads any local media to
 * fal storage first. Both Seedance 2.0 and 2.5 reference endpoints take
 * `image_urls` / `video_urls`; only 2.5 also supports the `task` field.
 */
async function buildSeedanceRequest(
  params: FluxGenerationParams
): Promise<{ endpointId: string; input: Record<string, unknown> }> {
  const model = getModel(params.modelId);
  const is25 = params.modelId === 'seedance-2.5';
  // Every Seedance model defines a reference endpoint.
  const referenceEndpoint = model.endpoints.referenceToVideo as string;

  const base: SeedanceInputBase = {
    prompt: params.prompt.trim(),
    resolution: resolveOutputResolution(params),
    duration: String(clampDurationForModel(params.modelId, params.duration)),
    aspect_ratio: mapAspectRatio(params.aspectRatio),
    generate_audio: params.nativeAudio,
    seed: params.seed,
  };

  const mode: WorkflowMode = params.workflowMode;
  const maxRefs = model.maxReferenceImages;

  // Reference field names (same on 2.0 and 2.5, per each endpoint's schema).
  const refImagesField = 'image_urls';
  const refVideosField = 'video_urls';

  // Timeline keyframes -> reference-to-video (keyframes as reference images).
  if (mode === 'keyframes_timeline') {
    const kfUrls = await ensureHostedUrls(
      params.keyframes.map((k) => k.imageUrl).filter(Boolean)
    );
    if (kfUrls.length === 0) {
      throw new Error(
        'The timeline has no images. Add at least one frame with an image.'
      );
    }
    const input: Record<string, unknown> = {
      ...base,
      [refImagesField]: kfUrls.slice(0, maxRefs),
    };
    if (is25) input.task = 'reference';
    return { endpointId: referenceEndpoint, input };
  }

  // Image-to-video and first/last-frame use the image-to-video endpoint.
  if (mode === 'image_to_video' || mode === 'first_last_frame') {
    const startUrl = await ensureHostedUrl(params.startFrameUrl);
    if (!startUrl) {
      throw new Error(
        'A start frame image is required for this mode. Upload or pick one first.'
      );
    }
    const input: Record<string, unknown> = { ...base, image_url: startUrl };
    // image-to-video always uses auto aspect ratio (inferred from the image).
    if (is25) input.aspect_ratio = 'auto';
    if (mode === 'first_last_frame') {
      const endUrl = await ensureHostedUrl(params.endFrameUrl);
      if (endUrl) input.end_image_url = endUrl;
    }
    return { endpointId: model.endpoints.imageToVideo, input };
  }

  // Dedicated reference-to-video (Seedance 2.5). Full use of the endpoint:
  // up to 30 reference images and up to 10 reference videos, plus a task mode.
  // Reference them in the prompt as @Image1, @Video1, @Video2, etc.
  if (mode === 'reference_to_video') {
    const refImageUrls = await ensureHostedUrls(params.referenceImages || []);
    const refVideoUrls = await ensureHostedUrls(params.referenceVideos || []);
    if (refImageUrls.length === 0 && refVideoUrls.length === 0) {
      throw new Error(
        'Reference to Video needs at least one reference image or video. Add one first.'
      );
    }
    const input: Record<string, unknown> = { ...base };
    if (refImageUrls.length > 0) {
      input[refImagesField] = refImageUrls.slice(0, maxRefs);
    }
    if (refVideoUrls.length > 0) {
      input[refVideosField] = refVideoUrls.slice(0, model.maxReferenceVideos);
    }
    if (is25) {
      input.task = params.referenceTask || 'reference';
      // Editing/extension coerce aspect_ratio/duration to auto server-side;
      // leave our values, fal handles the coercion.
    }
    return { endpointId: referenceEndpoint, input };
  }

  // Video extend/edit: source video + any reference images as references.
  if (mode === 'video_extend') {
    const videoUrl = await ensureHostedUrl(params.sourceVideoUrl);
    const refImageUrls = await ensureHostedUrls(params.referenceImages || []);
    const input: Record<string, unknown> = { ...base };
    if (videoUrl) input[refVideosField] = [videoUrl];
    if (refImageUrls.length > 0) {
      input[refImagesField] = refImageUrls.slice(0, maxRefs);
    }
    // 2.5 has a dedicated extension task; 2.0 just uses reference-to-video.
    if (is25) input.task = videoUrl ? 'extension' : 'reference';
    if (!videoUrl) {
      // Don't silently switch to a different kind of generation.
      throw new Error(
        'Extend & Edit needs a source video. Upload one first.'
      );
    }
    return { endpointId: referenceEndpoint, input };
  }

  // text_to_video: a pure text prompt. Reference images are intentionally NOT
  // used here — if the user wants references to guide generation they pick a
  // reference-based workflow mode. This keeps the selected mode predictable.
  return {
    endpointId: model.endpoints.textToVideo,
    input: base as unknown as Record<string, unknown>,
  };
}

/**
 * FLUX 3 (Black Forest Labs). Five modes, each with a cheap `/draft` twin that
 * returns a cache the user can later enhance to full quality.
 *
 * All endpoints share: prompt, aspect_ratio, duration, generate_audio,
 * safety_tolerance (+ resolution on non-draft endpoints). There is no seed.
 */
async function buildFlux3Request(
  params: FluxGenerationParams
): Promise<{ endpointId: string; input: Record<string, unknown> }> {
  const model = getModel(params.modelId);
  const kind = flux3KindForMode(params.workflowMode);
  if (!kind) {
    throw new Error('FLUX 3 doesn’t support this workflow. Pick a different mode.');
  }
  const draft = params.qualityTier === 'draft';
  const duration = clampDurationForModel(params.modelId, params.duration);

  const input: Record<string, unknown> = {
    prompt: params.prompt.trim(),
    aspect_ratio: params.aspectRatio,
    duration,
    generate_audio: params.nativeAudio,
    safety_tolerance: Math.min(4, Math.max(0, Math.round(params.safetyTolerance ?? 2))),
  };
  // Draft endpoints have no resolution field; they always render 720p.
  if (!draft) input.resolution = resolveOutputResolution(params);

  let endpoint = model.endpoints.textToVideo;

  switch (kind) {
    case 'text':
      break;

    case 'image': {
      const url = await ensureHostedUrl(params.startFrameUrl);
      if (!url) throw new Error('Image to Video needs an image. Upload one first.');
      input.image_url = url;
      endpoint = model.endpoints.imageToVideo;
      break;
    }

    case 'first_last': {
      const [start, end] = await Promise.all([
        ensureHostedUrl(params.startFrameUrl),
        ensureHostedUrl(params.endFrameUrl),
      ]);
      if (!start || !end) {
        throw new Error('Keyframe Pair needs both a start frame and an end frame.');
      }
      input.start_image_url = start;
      input.end_image_url = end;
      endpoint = model.endpoints.firstLastToVideo as string;
      break;
    }

    case 'keyframes': {
      const filled = params.keyframes.filter((k) => k.imageUrl);
      const hosted = await Promise.all(
        filled.map(async (k) => ({
          time: k.timeSeconds,
          url: await ensureHostedUrl(k.imageUrl),
        }))
      );
      const frames = hosted
        .filter((h): h is { time: number; url: string } => Boolean(h.url))
        .map((h) => ({
          frame_index: keyframeFrameIndex(h.time, duration),
          image_url: h.url,
        }));
      if (frames.length === 0) {
        throw new Error('The timeline has no images. Add at least one frame with an image.');
      }
      if (new Set(frames.map((f) => f.frame_index)).size !== frames.length) {
        throw new Error(
          'Two timeline frames land on the same frame. Move one to a different time.'
        );
      }
      frames.sort((a, b) => a.frame_index - b.frame_index);
      input.keyframes = frames.slice(0, model.maxTimelineFrames);
      endpoint = model.endpoints.keyframesToVideo as string;
      break;
    }

    case 'extend': {
      const url = await ensureHostedUrl(params.sourceVideoUrl);
      if (!url) throw new Error('Extend & Edit needs a source video. Upload one first.');
      input.video_url = url;
      endpoint = model.endpoints.extendVideo as string;
      break;
    }
  }

  return { endpointId: draft ? `${endpoint}/draft` : endpoint, input };
}

/** Picks the right request builder for the selected model family. */
async function buildRequest(
  params: FluxGenerationParams
): Promise<{ endpointId: string; input: Record<string, unknown> }> {
  return getModel(params.modelId).family === 'flux-3'
    ? buildFlux3Request(params)
    : buildSeedanceRequest(params);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs a smooth client-side progress animation while a server request is in
 * flight. The actual fal queue updates happen server-side now, so we can't
 * stream them; this ramps toward ~90% and holds until the result returns.
 */
function startProgressRamp(
  onProgress: ((p: FalProgress) => void) | undefined,
  estSeconds: number
): () => void {
  if (!onProgress) return () => {};
  const start = Date.now();
  const totalMs = Math.max(4000, estSeconds * 1000);
  onProgress({ percent: 3, message: 'Submitting to fal.ai...', phase: 'queued' });
  const timer = setInterval(() => {
    const elapsed = Date.now() - start;
    const pct = Math.min(90, 5 + (elapsed / totalMs) * 85);
    onProgress({
      percent: pct,
      message:
        pct < 20
          ? 'Queued on fal cluster...'
          : 'Synthesizing video on fal.ai...',
      phase: pct < 20 ? 'queued' : 'denoising',
    });
  }, 400);
  return () => clearInterval(timer);
}

/**
 * A failure with a user-facing reason and a suggested fix. The server fills
 * `hint`/`code`/`detail` in from fal's error response (see server/errors.ts).
 */
export class GenerationError extends Error {
  hint?: string;
  code?: string;
  detail?: string;
  retryable?: boolean;

  constructor(
    message: string,
    extra: { hint?: string; code?: string; detail?: string; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = 'GenerationError';
    this.hint = extra.hint;
    this.code = extra.code;
    this.detail = extra.detail;
    this.retryable = extra.retryable;
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  abortSignal?: AbortSignal
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (res.status === 401) {
    throw new GenerationError('Your session expired.', {
      hint: 'Sign in again, then retry.',
      code: 'unauthenticated',
    });
  }
  if (!res.ok) {
    let message = `The request failed (${res.status}).`;
    let extra: { hint?: string; code?: string; detail?: string; retryable?: boolean } = {};
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
      extra = {
        hint: data?.hint,
        code: data?.code,
        detail: data?.detail,
        retryable: data?.retryable,
      };
    } catch {
      /* body wasn't JSON; keep the generic message */
    }
    throw new GenerationError(message, extra);
  }
  return res.json() as Promise<T>;
}

/**
 * Generates a video. Media is uploaded to fal storage (via the authenticated
 * proxy) and the fal input is assembled client-side, then the actual
 * generation runs SERVER-SIDE (POST /api/generate) so usage is tracked.
 */
export async function generateVideo(
  params: FluxGenerationParams,
  onProgress?: (p: FalProgress) => void,
  abortSignal?: AbortSignal
): Promise<GeneratedVideoResult> {
  if (generationInFlight) {
    throw new Error('A generation is already in progress.');
  }
  generationInFlight = true;

  const stopRamp = startProgressRamp(onProgress, params.duration * 3);
  try {
    const { endpointId, input } = await buildRequest(params);

    const result = await postJson<{
      videoUrl: string;
      seed: number | null;
      requestId: string;
      resolution: ModelResolution;
      tokens: number;
      costUsd: number;
      draftCacheUrl?: string | null;
    }>(
      '/api/generate',
      {
        endpointId,
        input,
        modelId: params.modelId,
        resolution: resolveOutputResolution(params),
        duration: clampDurationForModel(params.modelId, params.duration),
        aspectRatio: params.aspectRatio,
      },
      abortSignal
    );

    if (onProgress) {
      onProgress({ percent: 100, message: 'Completed', phase: 'encoding' });
    }

    return {
      videoUrl: result.videoUrl,
      seed: typeof result.seed === 'number' ? result.seed : params.seed,
      resolution: result.resolution,
      requestId: result.requestId,
      draftCacheUrl: result.draftCacheUrl ?? null,
    };
  } finally {
    stopRamp();
    generationInFlight = false;
  }
}

export interface UpscaleResult {
  videoUrl: string;
  requestId: string;
}

/**
 * Upscales an existing video. Runs server-side (POST /api/upscale) so usage is
 * tracked. The source URL is uploaded to fal storage first if it isn't already
 * a hosted URL.
 */
export async function upscaleVideo(
  sourceVideoUrl: string,
  targetResolution: '1080p' | '4K',
  onProgress?: (p: FalProgress) => void,
  abortSignal?: AbortSignal
): Promise<UpscaleResult> {
  const hostedSource = await ensureHostedUrl(sourceVideoUrl);
  if (!hostedSource) {
    throw new Error('Could not resolve the source video for upscaling.');
  }

  const stopRamp = startProgressRamp(onProgress, 20);
  try {
    const result = await postJson<{ videoUrl: string; requestId: string }>(
      '/api/upscale',
      { videoUrl: hostedSource, targetResolution },
      abortSignal
    );
    if (onProgress) {
      onProgress({ percent: 100, message: 'Completed', phase: 'encoding' });
    }
    return { videoUrl: result.videoUrl, requestId: result.requestId };
  } finally {
    stopRamp();
  }
}

export interface EnhanceResult {
  videoUrl: string;
  requestId: string;
  costUsd: number;
}

/**
 * Re-renders a FLUX 3 draft at full quality (draft-enhance). It reuses the
 * draft's own cache, so you get the clip you approved: same seed, same motion.
 * Runs server-side (POST /api/enhance) so usage is tracked.
 */
export async function enhanceDraft(
  draftCacheUrl: string,
  durationSeconds: number,
  safetyTolerance: number | undefined,
  onProgress?: (p: FalProgress) => void,
  abortSignal?: AbortSignal
): Promise<EnhanceResult> {
  const stopRamp = startProgressRamp(onProgress, Math.max(20, durationSeconds * 4));
  try {
    const result = await postJson<EnhanceResult>(
      '/api/enhance',
      { draftCacheUrl, durationSeconds, safetyTolerance },
      abortSignal
    );
    if (onProgress) {
      onProgress({ percent: 100, message: 'Completed', phase: 'encoding' });
    }
    return result;
  } finally {
    stopRamp();
  }
}
