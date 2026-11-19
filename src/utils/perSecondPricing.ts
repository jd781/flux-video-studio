import type { ModelId, ModelResolution, WorkflowMode } from '../types/flux';

/**
 * Per-second pricing for the models that bill by output second (everything
 * except Seedance, which bills per token, and FLUX 3, see flux3.ts). Imported
 * by the browser (estimate shown before generating) and the server (figure
 * recorded afterwards) so the two always agree.
 *
 * fal's live Pricing API returns only ONE base rate per endpoint (for example
 * $0.157/s for Kling at any resolution), so it can't price resolution tiers.
 * The rates below come from the published fal.ai model pages (Nov 2026).
 * They are ESTIMATES: after the first real generation per model, compare the
 * "Cost" on fal's request page with what the app recorded and adjust.
 *
 * Sources:
 *  - Kling 4.0: $0.157/s 720p, $0.235/s 1080p. With a video input the rate is
 *    $0.094 / $0.141 per second, counted on input + output with a floor of
 *    twice the output.
 *  - Wan 3.0 Prime: $0.068 / $0.14 / $0.28 per second at 480p / 720p / 1080p.
 *  - Luma Ray 3.2: per 5s clip, text $0.50 / $1.00 / $2.00, image $0.15 /
 *    $0.30 / $1.20, video-to-video $0.72 / $1.08 / $2.16 (540p / 720p / 1080p).
 *    Reframe is billed per started source second: $0.06 / $0.12 / $0.36.
 *  - Veo 3.1: $0.40/s with audio, $0.20/s without (720p, 1080p); 4K is higher.
 *    The 4K figures and every Veo Fast figure other than $0.15/s with audio
 *    are NOT confirmed on fal. Verify them on the first 4K render.
 *  - Gemini Omni Flash: token billed, roughly $0.125-0.13/s at 720p.
 */

export type PerSecondModelId = Extract<
  ModelId,
  'kling-4.0' | 'wan-3.0-prime' | 'luma-ray-3.2' | 'veo-3.1' | 'veo-3.1-fast' | 'gemini-omni-flash'
>;

/** What the request does, as far as pricing is concerned. */
export type PricingKind = 'text' | 'image' | 'reference' | 'extend' | 'edit' | 'reframe';

type Rates = Partial<Record<ModelResolution, number>>;

const KLING: Rates = { '720p': 0.157, '1080p': 0.235 };
const KLING_WITH_VIDEO: Rates = { '720p': 0.094, '1080p': 0.141 };
const WAN: Rates = { '480p': 0.068, '720p': 0.14, '1080p': 0.28 };

const LUMA: Record<'text' | 'image' | 'edit' | 'reframe', Rates> = {
  text: { '540p': 0.1, '720p': 0.2, '1080p': 0.4 },
  image: { '540p': 0.03, '720p': 0.06, '1080p': 0.24 },
  edit: { '540p': 0.144, '720p': 0.216, '1080p': 0.432 },
  reframe: { '540p': 0.06, '720p': 0.12, '1080p': 0.36 },
};

const VEO: Record<'veo-3.1' | 'veo-3.1-fast', { audio: Rates; silent: Rates }> = {
  'veo-3.1': {
    audio: { '720p': 0.4, '1080p': 0.4, '2160p': 0.6 },
    silent: { '720p': 0.2, '1080p': 0.2, '2160p': 0.4 },
  },
  'veo-3.1-fast': {
    audio: { '720p': 0.15, '1080p': 0.15, '2160p': 0.35 },
    silent: { '720p': 0.1, '1080p': 0.1, '2160p': 0.3 },
  },
};

const GEMINI_TEXT = 0.125;
const GEMINI_OTHER = 0.13;

function pick(rates: Rates, resolution: ModelResolution): number {
  const direct = rates[resolution];
  if (direct !== undefined) return direct;
  // Unknown resolution for this table: use the highest listed rate so an
  // estimate never comes out low.
  return Math.max(...Object.values(rates).filter((v): v is number => v !== undefined));
}

export interface PerSecondCostInput {
  modelId: PerSecondModelId;
  kind: PricingKind;
  resolution: ModelResolution;
  /** Output seconds (for reframe: source seconds). */
  durationSeconds: number;
  /** Veo only: whether audio is generated. Defaults to true. */
  audio?: boolean;
  /** Kling only: a video is part of the request (edit, or reference with videos). */
  hasVideoInput?: boolean;
}

/** USD per second for this request (before multiplying by duration). */
export function perSecondRate(i: PerSecondCostInput): number {
  switch (i.modelId) {
    case 'kling-4.0':
      return pick(
        i.hasVideoInput || i.kind === 'edit' ? KLING_WITH_VIDEO : KLING,
        i.resolution
      );
    case 'wan-3.0-prime':
      return pick(WAN, i.resolution);
    case 'luma-ray-3.2': {
      const table =
        i.kind === 'image' ? LUMA.image
        : i.kind === 'edit' ? LUMA.edit
        : i.kind === 'reframe' ? LUMA.reframe
        : LUMA.text;
      return pick(table, i.resolution);
    }
    case 'veo-3.1':
    case 'veo-3.1-fast': {
      const t = VEO[i.modelId];
      return pick(i.audio === false ? t.silent : t.audio, i.resolution);
    }
    case 'gemini-omni-flash':
      return i.kind === 'text' ? GEMINI_TEXT : GEMINI_OTHER;
  }
}

/** Estimated USD for the request, rounded to cents of a cent. */
export function perSecondCost(i: PerSecondCostInput): number {
  // Kling bills video-input requests on input + output with a floor of twice
  // the output. Input length isn't known here, so use the floor.
  const billedSeconds =
    i.modelId === 'kling-4.0' && (i.hasVideoInput || i.kind === 'edit')
      ? i.durationSeconds * 2
      : i.durationSeconds;
  return Math.round(perSecondRate(i) * billedSeconds * 10000) / 10000;
}

/** Workflow mode -> pricing kind. */
export function pricingKindForMode(mode: WorkflowMode): PricingKind {
  switch (mode) {
    case 'image_to_video':
    case 'first_last_frame':
    case 'keyframes_timeline':
      return 'image';
    case 'reference_to_video':
      return 'reference';
    case 'video_extend':
      return 'extend';
    case 'video_edit':
      return 'edit';
    case 'video_reframe':
      return 'reframe';
    default:
      return 'text';
  }
}

export function isPerSecondModel(modelId: ModelId): modelId is PerSecondModelId {
  return (
    modelId === 'kling-4.0' ||
    modelId === 'wan-3.0-prime' ||
    modelId === 'luma-ray-3.2' ||
    modelId === 'veo-3.1' ||
    modelId === 'veo-3.1-fast' ||
    modelId === 'gemini-omni-flash'
  );
}

/**
 * Identify a per-second endpoint id (used by the server for billing). Returns
 * null for Seedance / FLUX 3 / anything else.
 */
export function perSecondFromEndpoint(
  endpointId: string
): { modelId: PerSecondModelId; kind: PricingKind } | null {
  const kindOf = (tail: string): PricingKind => {
    if (tail === '' || tail === 'text-to-video') return 'text';
    if (tail === 'image-to-video' || tail === 'first-last-frame-to-video') return 'image';
    if (tail === 'reference-to-video') return 'reference';
    if (tail === 'extend-video') return 'extend';
    if (tail === 'video-to-video' || tail === 'video-to-video/edit' || tail === 'edit') {
      return 'edit';
    }
    if (tail === 'reframe') return 'reframe';
    return 'text';
  };
  const strip = (prefix: string) => endpointId.slice(prefix.length).replace(/^\//, '');
  const under = (prefix: string) =>
    endpointId === prefix || endpointId.startsWith(`${prefix}/`);

  if (under('kling/v4')) return { modelId: 'kling-4.0', kind: kindOf(strip('kling/v4')) };
  if (under('alibaba/wan-3.0-prime')) {
    return { modelId: 'wan-3.0-prime', kind: kindOf(strip('alibaba/wan-3.0-prime')) };
  }
  if (under('luma/agent/ray/v3.2')) {
    return { modelId: 'luma-ray-3.2', kind: kindOf(strip('luma/agent/ray/v3.2')) };
  }
  // Check Fast before the base Veo path (it is nested under it).
  if (under('fal-ai/veo3.1/fast')) {
    return { modelId: 'veo-3.1-fast', kind: kindOf(strip('fal-ai/veo3.1/fast')) };
  }
  if (under('fal-ai/veo3.1')) {
    return { modelId: 'veo-3.1', kind: kindOf(strip('fal-ai/veo3.1')) };
  }
  if (under('google/gemini-omni-flash')) {
    return { modelId: 'gemini-omni-flash', kind: kindOf(strip('google/gemini-omni-flash')) };
  }
  return null;
}
