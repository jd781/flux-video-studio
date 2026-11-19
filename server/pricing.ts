/**
 * Accurate fal.ai cost calculation.
 *
 * Unit prices are fetched live from fal's Pricing API and cached. Seedance
 * video models bill per 1,000 tokens, where
 *   tokens = (width * height * duration * fps) / 1024
 * fal pads the real output dimensions, so instead of guessing the pixel grid
 * we calibrate tokens-per-second per resolution against a known real charge
 * (a 480p/5s Seedance 2.0 generation billed $0.57 at $0.0112/1k tokens =>
 * 50,893 tokens => 10,179 tokens/sec at 480p). Higher resolutions scale by
 * pixel-area ratio. This matches fal's actual billing to within rounding.
 *
 * The Topaz upscaler bills per second of output.
 */

import type { ModelResolution } from '../src/types/flux';
import {
  flux3Cost,
  flux3EnhanceCost,
  flux3FromEndpoint,
} from '../src/utils/flux3';
import { perSecondCost, perSecondFromEndpoint } from '../src/utils/perSecondPricing';

export type { ModelResolution };

const PRICING_API = 'https://api.fal.ai/v1/models/pricing';

// Calibrated tokens/second by resolution (see note above). 480p is measured;
// 720p and 1080p scale by output pixel-area relative to 480p. (Seedance only;
// FLUX 3 bills per second of output, see utils/flux3.ts.)
const TOKENS_PER_SECOND: Partial<Record<ModelResolution, number>> = {
  '480p': 10179,
  '720p': 27130, // ~2.666x (1280x720 / 864x504)
  '1080p': 61074, // ~6.0x
};

interface PriceInfo {
  unitPrice: number;
  unit: string; // e.g. "1000 tokens" or "seconds"
}

// endpointId -> { price, fetchedAt }
const priceCache = new Map<string, { info: PriceInfo; fetchedAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

/** Fetch (and cache) the live unit price for a fal endpoint. */
export async function getUnitPrice(endpointId: string): Promise<PriceInfo | null> {
  const cached = priceCache.get(endpointId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.info;
  }
  const key = process.env.FAL_KEY;
  if (!key) return cached?.info ?? null;

  try {
    const res = await fetch(
      `${PRICING_API}?endpoint_id=${encodeURIComponent(endpointId)}`,
      { headers: { Authorization: `Key ${key}` } }
    );
    if (!res.ok) return cached?.info ?? null;
    const data = (await res.json()) as {
      prices?: Array<{ unit_price: number; unit: string }>;
    };
    const row = data.prices?.[0];
    if (!row) return cached?.info ?? null;
    const info: PriceInfo = { unitPrice: row.unit_price, unit: row.unit };
    priceCache.set(endpointId, { info, fetchedAt: Date.now() });
    return info;
  } catch {
    return cached?.info ?? null;
  }
}

// Fallback unit prices if the API is unreachable (from fal Pricing API,
// observed values). Keeps cost non-zero if a price lookup fails.
const FALLBACK_UNIT_PRICE: Record<string, number> = {
  'bytedance/seedance-2.0': 0.0112, // per 1000 tokens
  'bytedance/seedance-2.5': 0.0214, // per 1000 tokens
  'fal-ai/topaz/upscale/video': 0.01, // per second
};

function fallbackFor(endpointId: string): number {
  for (const prefix of Object.keys(FALLBACK_UNIT_PRICE)) {
    if (endpointId.startsWith(prefix)) return FALLBACK_UNIT_PRICE[prefix];
  }
  return 0;
}

export interface VideoCost {
  tokens: number;
  costUsd: number;
}

/**
 * Accurate cost for a Seedance video generation: tokens derived from calibrated
 * per-resolution token rate × duration, priced at the live per-1000-token rate.
 */
export async function computeVideoCost(
  endpointId: string,
  resolution: ModelResolution,
  durationSeconds: number,
  input: Record<string, unknown> = {}
): Promise<VideoCost> {
  // Kling, Wan, Luma, Veo and Gemini Omni bill per second of output at a rate
  // that depends on resolution (see utils/perSecondPricing.ts). They must not
  // fall through to the Seedance token math below.
  const perSecond = perSecondFromEndpoint(endpointId);
  if (perSecond) {
    const hasVideoInput =
      typeof input.video_url === 'string' ||
      (Array.isArray(input.video_urls) && input.video_urls.length > 0);
    return {
      tokens: 0,
      costUsd: perSecondCost({
        modelId: perSecond.modelId,
        kind: perSecond.kind,
        resolution,
        durationSeconds,
        audio: input.generate_audio !== false,
        hasVideoInput,
      }),
    };
  }

  // FLUX 3 is billed per second of output (not per token), at a published rate
  // that depends on the endpoint and resolution. Drafts are a flat cheap rate.
  const flux = flux3FromEndpoint(endpointId);
  if (flux && flux.kind !== 'enhance') {
    return {
      tokens: 0,
      costUsd: flux3Cost(flux.kind, resolution, durationSeconds, flux.draft),
    };
  }

  const tps = TOKENS_PER_SECOND[resolution] ?? 27130;
  const tokens = Math.round(tps * durationSeconds);

  const price = await getUnitPrice(endpointId);
  const perThousand =
    price && /token/i.test(price.unit)
      ? price.unitPrice
      : fallbackFor(endpointId);

  const costUsd = Math.round((tokens / 1000) * perThousand * 10000) / 10000;
  return { tokens, costUsd };
}

/** Cost of a FLUX 3 draft-enhance: per second of the enhanced (1080p) output. */
export function computeEnhanceCost(durationSeconds: number): VideoCost {
  return { tokens: 0, costUsd: flux3EnhanceCost(durationSeconds) };
}

/** Accurate cost for a Topaz upscale: per-second of OUTPUT video. */
export async function computeUpscaleCost(
  durationSeconds: number
): Promise<VideoCost> {
  const price = await getUnitPrice('fal-ai/topaz/upscale/video');
  const perSecond =
    price && /second/i.test(price.unit)
      ? price.unitPrice
      : fallbackFor('fal-ai/topaz/upscale/video');
  const costUsd = Math.round(durationSeconds * perSecond * 10000) / 10000;
  // Upscale is not token-billed; report tokens as 0.
  return { tokens: 0, costUsd };
}

/** Client-facing estimate (no network): used to keep the UI estimate aligned. */
export function estimateVideoCostOffline(
  modelId: string,
  resolution: ModelResolution,
  durationSeconds: number
): VideoCost {
  const tps = TOKENS_PER_SECOND[resolution] ?? 27130;
  const tokens = Math.round(tps * durationSeconds);
  const perThousand = modelId === 'seedance-2.5' ? 0.0214 : 0.0112;
  const costUsd = Math.round((tokens / 1000) * perThousand * 10000) / 10000;
  return { tokens, costUsd };
}
