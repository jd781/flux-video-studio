import { fal } from '@fal-ai/client';
import {
  computeVideoCost,
  computeUpscaleCost,
  computeEnhanceCost,
  type ModelResolution,
} from './pricing';
import { FLUX3_ENDPOINTS } from '../src/utils/flux3';

/**
 * Server-side fal.ai generation + usage accounting.
 *
 * Generation runs here (not in the browser) so the server can attribute usage
 * to the logged-in user and record real token/cost figures. FAL_KEY is read
 * from the environment by the fal client automatically (server-side).
 *
 * Cost/token figures come from server/pricing.ts, which pulls live unit prices
 * from fal's Pricing API.
 *
 * The browser sends already-prepared, fal-ready input (hosted URLs, correct
 * field names per model) to /api/generate; this module just submits it and
 * does the bookkeeping.
 */

export type { ModelResolution };

export interface GeneratePayload {
  endpointId: string;
  input: Record<string, unknown>;
  // Metadata for usage accounting (client-supplied, validated loosely).
  modelId: string;
  resolution: ModelResolution;
  duration: number;
  aspectRatio: string;
}

export interface GenerateOutcome {
  videoUrl: string;
  seed: number | null;
  requestId: string;
  tokens: number;
  costUsd: number;
  /** FLUX 3 draft renders: cache to pass to draft-enhance. Absent otherwise. */
  draftCacheUrl: string | null;
}

/** Runs a video generation (Seedance or FLUX 3) server-side and returns result + usage. */
export async function runGeneration(
  payload: GeneratePayload
): Promise<GenerateOutcome> {
  const result = await fal.subscribe(payload.endpointId, {
    input: payload.input,
  });

  const data = result.data as {
    video?: { url?: string };
    seed?: number;
    draft_cache?: { url?: string } | null;
  };
  const videoUrl = data?.video?.url;
  if (!videoUrl) {
    throw new Error('fal.ai returned no video URL.');
  }

  const { tokens, costUsd } = await computeVideoCost(
    payload.endpointId,
    payload.resolution,
    payload.duration,
    payload.input
  );

  return {
    videoUrl,
    seed: typeof data.seed === 'number' ? data.seed : null,
    requestId: result.requestId,
    tokens,
    costUsd,
    draftCacheUrl: data.draft_cache?.url ?? null,
  };
}

export interface EnhancePayload {
  draftCacheUrl: string;
  durationSeconds: number;
  safetyTolerance: number;
}

export interface EnhanceOutcome {
  videoUrl: string;
  requestId: string;
  costUsd: number;
}

/**
 * Re-renders a FLUX 3 draft at full quality from its cache (same seed and
 * motion). The endpoint takes no prompt or resolution: everything is already
 * fixed by the draft.
 */
export async function runEnhance(payload: EnhancePayload): Promise<EnhanceOutcome> {
  const result = await fal.subscribe(FLUX3_ENDPOINTS.enhance, {
    input: {
      draft_cache_url: payload.draftCacheUrl,
      safety_tolerance: payload.safetyTolerance,
    },
  });

  const data = result.data as { video?: { url?: string } };
  const videoUrl = data?.video?.url;
  if (!videoUrl) {
    throw new Error('fal.ai returned no enhanced video URL.');
  }

  return {
    videoUrl,
    requestId: result.requestId,
    costUsd: computeEnhanceCost(payload.durationSeconds).costUsd,
  };
}

export interface UpscalePayload {
  videoUrl: string;
  targetResolution: '1080p' | '4K';
  // Output video duration in seconds (upscaler bills per output second).
  durationSeconds?: number;
}

export interface UpscaleOutcome {
  videoUrl: string;
  requestId: string;
  tokens: number;
  costUsd: number;
}

/** Runs a Topaz video upscale server-side. */
export async function runUpscale(
  payload: UpscalePayload
): Promise<UpscaleOutcome> {
  const upscaleFactor = payload.targetResolution === '4K' ? 4 : 2;
  const result = await fal.subscribe('fal-ai/topaz/upscale/video', {
    input: {
      video_url: payload.videoUrl,
      upscale_factor: upscaleFactor,
    },
  });

  const data = result.data as { video?: { url?: string } };
  const videoUrl = data?.video?.url;
  if (!videoUrl) {
    throw new Error('fal.ai upscaler returned no video URL.');
  }

  // Topaz bills per second of OUTPUT video. We don't always know the exact
  // output duration, so use the provided source duration as the best estimate.
  const { tokens, costUsd } = await computeUpscaleCost(
    payload.durationSeconds ?? 5
  );

  return {
    videoUrl,
    requestId: result.requestId,
    tokens,
    costUsd,
  };
}
