import type { ModelResolution, WorkflowMode } from '../types/flux';

/**
 * FLUX 3 (Black Forest Labs, served by fal.ai) endpoints, pricing, and
 * keyframe math. Imported by BOTH the browser UI and the server so the cost
 * shown before generating always matches the cost recorded afterwards.
 *
 * Source of truth: each endpoint's schema at
 *   https://fal.ai/models/blackforestlabs/flux-3/<endpoint>/llms.txt
 */

export const FLUX3_BASE = 'blackforestlabs/flux-3';
export const FLUX3_FPS = 24;

export const FLUX3_ENDPOINTS = {
  text: `${FLUX3_BASE}/text-to-video`,
  image: `${FLUX3_BASE}/image-to-video`,
  first_last: `${FLUX3_BASE}/first-last-frame-to-video`,
  keyframes: `${FLUX3_BASE}/keyframes-to-video`,
  extend: `${FLUX3_BASE}/extend-video`,
  enhance: `${FLUX3_BASE}/draft-enhance`,
} as const;

export type Flux3Kind = 'text' | 'image' | 'first_last' | 'keyframes' | 'extend';

/**
 * Multiplier applied to every FLUX 3 dollar figure.
 *
 * fal's published per-second rates ($0.17 / $0.29 ...) are what's used here.
 * fal's live Pricing API currently reports exactly HALF of those for every
 * FLUX 3 endpoint ($0.085/s for text-to-video). It isn't known which one fal
 * actually bills, so estimates use the higher published rate. After the first
 * real generation, compare the "Cost" on fal's request page with the estimate
 * and, if fal charged half, set this to 0.5.
 */
export const FLUX3_BILLING_SCALE = 1;

/** Workflow mode -> FLUX 3 endpoint kind (null when FLUX 3 has no such mode). */
export function flux3KindForMode(mode: WorkflowMode): Flux3Kind | null {
  switch (mode) {
    case 'text_to_video':
      return 'text';
    case 'image_to_video':
      return 'image';
    case 'first_last_frame':
      return 'first_last';
    case 'keyframes_timeline':
      return 'keyframes';
    case 'video_extend':
      return 'extend';
    default:
      return null;
  }
}

/** Identify a FLUX 3 endpoint id (used by the server for billing/validation). */
export function flux3FromEndpoint(
  endpointId: string
): { kind: Flux3Kind | 'enhance'; draft: boolean } | null {
  if (!endpointId.startsWith(`${FLUX3_BASE}/`)) return null;
  if (endpointId === FLUX3_ENDPOINTS.enhance) return { kind: 'enhance', draft: false };
  const draft = endpointId.endsWith('/draft');
  const id = draft ? endpointId.slice(0, -'/draft'.length) : endpointId;
  for (const kind of ['text', 'image', 'first_last', 'keyframes', 'extend'] as const) {
    if (FLUX3_ENDPOINTS[kind] === id) return { kind, draft };
  }
  return null;
}

// --- Published per-second rates (USD) -------------------------------------
const STANDARD_RATES: Partial<Record<ModelResolution, number>> = {
  '720p': 0.17,
  '1080p': 0.29,
  '1440p': 0.32,
  '2160p': 0.47,
};
// First/last-frame and keyframes list 1440p/2160p as accepted values but fal
// publishes no price for them, so they are not offered.
const STANDARD_RATES_TO_1080: Partial<Record<ModelResolution, number>> = {
  '720p': 0.17,
  '1080p': 0.29,
};
const EXTEND_RATES: Partial<Record<ModelResolution, number>> = {
  '720p': 0.41,
  '1080p': 0.53,
};
const DRAFT_RATE = 0.06; // 720p preview
const DRAFT_EXTEND_RATE = 0.12;
const ENHANCE_RATE = 0.29; // full-quality 1080p, audio included

function ratesFor(kind: Flux3Kind): Partial<Record<ModelResolution, number>> {
  if (kind === 'extend') return EXTEND_RATES;
  if (kind === 'text' || kind === 'image') return STANDARD_RATES;
  return STANDARD_RATES_TO_1080;
}

/** Resolutions that have a published price for this endpoint kind (ascending). */
export function flux3Resolutions(kind: Flux3Kind): ModelResolution[] {
  return Object.keys(ratesFor(kind)) as ModelResolution[];
}

/** USD per second of output for a FLUX 3 endpoint kind. */
export function flux3RatePerSecond(
  kind: Flux3Kind,
  resolution: ModelResolution,
  draft = false
): number {
  if (draft) return (kind === 'extend' ? DRAFT_EXTEND_RATE : DRAFT_RATE) * FLUX3_BILLING_SCALE;
  const table = ratesFor(kind);
  const available = Object.keys(table) as ModelResolution[];
  // Unpublished resolution for this kind: fall back to the highest priced one.
  const rate = table[resolution] ?? table[available[available.length - 1]] ?? 0;
  return rate * FLUX3_BILLING_SCALE;
}

export function flux3Cost(
  kind: Flux3Kind,
  resolution: ModelResolution,
  durationSeconds: number,
  draft = false
): number {
  return Math.round(flux3RatePerSecond(kind, resolution, draft) * durationSeconds * 10000) / 10000;
}

/** Cost of re-rendering a draft at full quality (priced per output second). */
export function flux3EnhanceCost(durationSeconds: number): number {
  return Math.round(ENHANCE_RATE * FLUX3_BILLING_SCALE * durationSeconds * 10000) / 10000;
}

export function flux3EnhanceRatePerSecond(): number {
  return ENHANCE_RATE * FLUX3_BILLING_SCALE;
}

/**
 * Frame index (24 fps) for a timeline keyframe at `timeSeconds`.
 * fal requires 0 <= frame_index <= duration * 24 and unique indices. The very
 * last frame of a clip of N frames is N - 1, so the index is capped there.
 */
export function keyframeFrameIndex(timeSeconds: number, durationSeconds: number): number {
  const raw = Math.round(timeSeconds * FLUX3_FPS);
  const last = Math.max(0, Math.round(durationSeconds * FLUX3_FPS) - 1);
  return Math.min(Math.max(0, raw), last);
}
