import type { Request } from 'express';
import { randomUUID } from 'crypto';
import type { SessionUser } from './auth';
import { recordGeneration } from './db';
import { computeEnhanceCost, computeUpscaleCost, computeVideoCost, getUnitPrice } from './pricing';
import { failureForLog, describeFalFailure } from './errors';

/**
 * Usage records for fal.ai calls made by the Production Pipeline, written to
 * the same table the Video Studio uses so /admin and "My Usage" cover both.
 *
 * Recording must never break a user's request: every function swallows its own
 * errors (and logs them).
 */

type Kind = 'generate' | 'upscale' | 'enhance' | 'image';

interface Base {
  kind: Kind;
  modelId: string | null;
  endpoint: string;
  resolution?: string | null;
  duration?: number | null;
  aspectRatio?: string | null;
}

function userOf(req: Request): SessionUser | null {
  const u = req.user as SessionUser | undefined;
  return u?.id && u.email ? u : null;
}

function write(
  req: Request,
  base: Base,
  outcome: {
    requestId?: string | null;
    tokens?: number;
    costUsd?: number;
    status: 'completed' | 'failed';
    error?: string | null;
  }
): void {
  const user = userOf(req);
  if (!user) return;
  try {
    recordGeneration({
      id: randomUUID(),
      user_id: user.id,
      user_email: user.email,
      kind: base.kind,
      model_id: base.modelId,
      endpoint: base.endpoint,
      request_id: outcome.requestId ?? null,
      resolution: base.resolution ?? null,
      duration: base.duration ?? null,
      aspect_ratio: base.aspectRatio ?? null,
      tokens: outcome.tokens ?? 0,
      cost_usd: outcome.costUsd ?? 0,
      status: outcome.status,
      error: outcome.error ?? null,
    });
  } catch (err) {
    console.error('[usage] could not record fal usage:', err);
  }
}

/** A finished video generation. Call right after fal returns, before any file work. */
export async function trackVideoUsage(
  req: Request,
  p: {
    modelId: string;
    endpointId: string;
    resolution: string;
    duration: number;
    aspectRatio?: string;
    requestId?: string;
    input: Record<string, unknown>;
  }
): Promise<void> {
  let cost = { tokens: 0, costUsd: 0 };
  try {
    cost = await computeVideoCost(p.endpointId, p.resolution as never, p.duration, p.input);
  } catch (err) {
    console.error('[usage] cost lookup failed, recording $0:', err);
  }
  write(
    req,
    {
      kind: 'generate',
      modelId: p.modelId,
      endpoint: p.endpointId,
      resolution: p.resolution,
      duration: p.duration,
      aspectRatio: p.aspectRatio,
    },
    { requestId: p.requestId, tokens: cost.tokens, costUsd: cost.costUsd, status: 'completed' }
  );
}

export function trackEnhanceUsage(
  req: Request,
  p: { endpointId: string; durationSeconds: number; requestId?: string }
): void {
  write(
    req,
    {
      kind: 'enhance',
      modelId: 'flux-3',
      endpoint: p.endpointId,
      resolution: '1080p',
      duration: p.durationSeconds,
    },
    {
      requestId: p.requestId,
      costUsd: computeEnhanceCost(p.durationSeconds).costUsd,
      status: 'completed',
    }
  );
}

export async function trackUpscaleUsage(
  req: Request,
  p: { endpointId: string; durationSeconds: number; scaleFactor: number; requestId?: string }
): Promise<void> {
  let costUsd = 0;
  try {
    costUsd = (await computeUpscaleCost(p.durationSeconds)).costUsd;
  } catch (err) {
    console.error('[usage] upscale cost lookup failed, recording $0:', err);
  }
  write(
    req,
    {
      kind: 'upscale',
      modelId: null,
      endpoint: p.endpointId,
      resolution: p.scaleFactor === 4 ? '4K' : '2x',
      duration: p.durationSeconds,
    },
    { requestId: p.requestId, costUsd, status: 'completed' }
  );
}

// Per-image rates used when fal's Pricing API doesn't answer. Estimates.
const IMAGE_FALLBACK_USD: Array<[string, number]> = [
  ['nano-banana-pro', 0.15],
  ['nano-banana-2', 0.08],
  ['nano-banana', 0.039],
];

/** One storyboard image (Nano Banana). */
export async function trackImageUsage(
  req: Request,
  p: { endpointId: string; resolution?: string; aspectRatio?: string }
): Promise<void> {
  let costUsd = 0;
  try {
    const price = await getUnitPrice(p.endpointId);
    if (price && /image/i.test(price.unit)) costUsd = price.unitPrice;
    else costUsd = IMAGE_FALLBACK_USD.find(([k]) => p.endpointId.includes(k))?.[1] ?? 0;
  } catch {
    costUsd = IMAGE_FALLBACK_USD.find(([k]) => p.endpointId.includes(k))?.[1] ?? 0;
  }
  write(
    req,
    {
      kind: 'image',
      modelId: p.endpointId,
      endpoint: p.endpointId,
      resolution: p.resolution ?? null,
      aspectRatio: p.aspectRatio ?? null,
    },
    { costUsd, status: 'completed' }
  );
}

/** A fal call that threw. Costs nothing (fal doesn't bill failed requests). */
export function trackFalFailure(
  req: Request,
  p: Base & { err: unknown }
): void {
  const failure = describeFalFailure(p.err);
  write(req, p, { status: 'failed', error: failureForLog(failure) });
}
