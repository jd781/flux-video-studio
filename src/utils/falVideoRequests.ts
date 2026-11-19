import type {
  AspectRatio,
  ModelId,
  ModelResolution,
  QualityTier,
  WorkflowMode,
} from '../types/flux';
import { effectiveDuration, getModel, resolveOutputResolution } from './modelCatalog';

/**
 * fal.ai request builders for Kling 4.0, Wan 3.0 Prime, Luma Ray 3.2, Veo 3.1
 * (+ Fast) and Gemini Omni Flash.
 *
 * ONE implementation shared by the browser (Video Studio, lib/falClient.ts) and
 * the server (Production Pipeline, server/falHelpers.ts), so a model's field
 * names and limits are defined once. They differ from model to model, and fal
 * rejects fields it doesn't know, so everything here follows each endpoint's
 * OpenAPI schema (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>):
 *
 *  - Kling / Wan take start_image_url; Veo takes image_url and
 *    first_frame_url/last_frame_url; Luma and Gemini take image_url.
 *  - Luma and Veo durations are strings ("5s"); Kling, Wan and Gemini integers.
 *  - Veo spells 4K as "4k"; Wan's "auto" aspect ratio is "adaptive".
 *  - Gemini Omni Flash has no resolution, audio or seed field.
 *  - Only Veo (except reference-to-video) has a negative_prompt field. For the
 *    others a negative prompt is appended to the prompt text.
 */

export interface VideoRequestInput {
  modelId: ModelId;
  workflowMode: WorkflowMode;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  duration: number;
  qualityTier: QualityTier;
  resolution?: ModelResolution;
  nativeAudio: boolean;
  seed?: number;
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  sourceVideoUrl?: string | null;
  referenceImages?: string[];
  referenceVideos?: string[];
  /** Kling: character/object images sent as `elements`. */
  referenceElements?: string[];
  /** Wan: reference audio clips. */
  referenceAudioUrls?: string[];
}

/** Turns a local/data/asset URL into one fal can fetch; null when it can't. */
export type HostFn = (url: string | null | undefined) => Promise<string | null>;

export interface BuiltVideoRequest {
  endpointId: string;
  input: Record<string, unknown>;
  /** What the request actually asks for (used for the cost record). */
  resolution: ModelResolution;
  duration: number;
}

type Built = { endpointId: string; input: Record<string, unknown> };

/** True for the models this module builds requests for. */
export function usesSharedVideoBuilder(modelId: ModelId): boolean {
  const family = getModel(modelId).family;
  return (
    family === 'kling' ||
    family === 'wan' ||
    family === 'luma' ||
    family === 'veo' ||
    family === 'gemini-omni'
  );
}

async function hostAll(host: HostFn, urls: string[] | undefined): Promise<string[]> {
  const out = await Promise.all((urls ?? []).map((u) => host(u)));
  return out.filter((u): u is string => Boolean(u));
}

async function requireHosted(host: HostFn, url: string | null | undefined, error: string) {
  const hosted = await host(url);
  if (!hosted) throw new Error(error);
  return hosted;
}

function promptWithAvoid(p: VideoRequestInput): string {
  const base = p.prompt.trim();
  const neg = (p.negativePrompt ?? '').trim();
  return neg && base ? `${base}\nAvoid: ${neg}` : base;
}

const NEED_START = 'A start frame image is required for this mode. Upload or pick one first.';
const NEED_PAIR = 'Keyframe Pair needs both a start frame and an end frame.';
const needRefs = (what: string) =>
  `Reference to Video needs at least one reference ${what}. Add one first.`;
const needVideo = (what: string) => `${what} needs a source video. Upload one first.`;

function unsupported(p: VideoRequestInput): never {
  throw new Error(`${getModel(p.modelId).label} doesn’t support this workflow. Pick a different mode.`);
}

async function buildKling(p: VideoRequestInput, host: HostFn): Promise<Built> {
  const model = getModel(p.modelId);
  const mode = p.workflowMode;
  const prompt = promptWithAvoid(p);
  const resolution = resolveOutputResolution(p);
  const duration = effectiveDuration(p.modelId, mode, p.duration);
  const aspect = p.aspectRatio === 'auto' || p.aspectRatio === '2:1' ? undefined : p.aspectRatio;

  switch (mode) {
    case 'text_to_video':
      return {
        endpointId: model.endpoints.textToVideo,
        input: { prompt, duration, resolution, aspect_ratio: aspect ?? '16:9' },
      };

    case 'image_to_video':
    case 'first_last_frame': {
      // The shape comes from the start image; the endpoint has no aspect field.
      const input: Record<string, unknown> = {
        prompt,
        duration,
        resolution,
        start_image_url: await requireHosted(host, p.startFrameUrl, NEED_START),
      };
      if (mode === 'first_last_frame') {
        input.end_image_url = await requireHosted(host, p.endFrameUrl, NEED_PAIR);
      } else if (p.endFrameUrl) {
        const end = await host(p.endFrameUrl);
        if (end) input.end_image_url = end;
      }
      return { endpointId: model.endpoints.imageToVideo, input };
    }

    case 'reference_to_video': {
      const [images, videos, elements] = await Promise.all([
        hostAll(host, p.referenceImages),
        hostAll(host, [...(p.sourceVideoUrl ? [p.sourceVideoUrl] : []), ...(p.referenceVideos ?? [])]),
        hostAll(host, p.referenceElements),
      ]);
      if (images.length === 0 && videos.length === 0 && elements.length === 0) {
        throw new Error(needRefs('image, element or video'));
      }
      const input: Record<string, unknown> = { prompt, duration, resolution };
      if (aspect) input.aspect_ratio = aspect;
      else input.aspect_ratio = 'auto';
      if (images.length) input.image_urls = images.slice(0, model.maxReferenceImages);
      if (videos.length) input.video_urls = [...new Set(videos)].slice(0, model.maxReferenceVideos);
      if (elements.length) {
        input.elements = elements.slice(0, 7).map((url) => ({ frontal_image_url: url }));
      }
      return { endpointId: model.endpoints.referenceToVideo as string, input };
    }

    case 'video_edit':
    case 'video_extend': {
      // Output length follows the source clip, so no duration is sent.
      const input: Record<string, unknown> = {
        prompt,
        resolution,
        video_url: await requireHosted(host, p.sourceVideoUrl ?? p.referenceVideos?.[0], needVideo('Edit')),
      };
      const images = await hostAll(host, p.referenceImages);
      if (images.length) input.image_urls = images.slice(0, model.maxReferenceImages);
      return { endpointId: model.endpoints.videoEdit as string, input };
    }

    default:
      return unsupported(p);
  }
}

async function buildWan(p: VideoRequestInput, host: HostFn): Promise<Built> {
  const model = getModel(p.modelId);
  const mode = p.workflowMode;
  const base: Record<string, unknown> = {
    prompt: promptWithAvoid(p),
    resolution: resolveOutputResolution(p),
    duration: effectiveDuration(p.modelId, mode, p.duration),
    // Wan calls "let the model pick" adaptive, and takes no 21:9 or 2:1.
    aspect_ratio:
      p.aspectRatio === 'auto' || p.aspectRatio === '21:9' || p.aspectRatio === '2:1'
        ? 'adaptive'
        : p.aspectRatio,
    audio: p.nativeAudio,
  };
  if (typeof p.seed === 'number') base.seed = p.seed;

  switch (mode) {
    case 'text_to_video':
      return { endpointId: model.endpoints.textToVideo, input: base };

    case 'image_to_video':
    case 'first_last_frame': {
      const input: Record<string, unknown> = {
        ...base,
        start_image_url: await requireHosted(host, p.startFrameUrl, NEED_START),
      };
      if (mode === 'first_last_frame') {
        input.end_image_url = await requireHosted(host, p.endFrameUrl, NEED_PAIR);
      } else if (p.endFrameUrl) {
        const end = await host(p.endFrameUrl);
        if (end) input.end_image_url = end;
      }
      return { endpointId: model.endpoints.imageToVideo, input };
    }

    case 'reference_to_video': {
      const [images, videos, audio] = await Promise.all([
        hostAll(host, p.referenceImages),
        hostAll(host, [...(p.sourceVideoUrl ? [p.sourceVideoUrl] : []), ...(p.referenceVideos ?? [])]),
        hostAll(host, p.referenceAudioUrls),
      ]);
      if (images.length === 0 && videos.length === 0 && audio.length === 0) {
        throw new Error(needRefs('image, video or audio clip'));
      }
      const input: Record<string, unknown> = { ...base };
      if (images.length) input.reference_image_urls = images.slice(0, model.maxReferenceImages);
      if (videos.length) {
        input.reference_video_urls = [...new Set(videos)].slice(0, model.maxReferenceVideos);
      }
      if (audio.length) input.reference_audio_urls = audio.slice(0, 5);
      return { endpointId: model.endpoints.referenceToVideo as string, input };
    }

    default:
      return unsupported(p);
  }
}

async function buildLuma(p: VideoRequestInput, host: HostFn): Promise<Built> {
  const model = getModel(p.modelId);
  const mode = p.workflowMode;
  const prompt = mode === 'video_reframe' ? p.prompt.trim() : promptWithAvoid(p);
  const resolution = resolveOutputResolution(p);
  const duration = `${effectiveDuration(p.modelId, mode, p.duration)}s`;
  const aspect = p.aspectRatio === 'auto' || p.aspectRatio === '2:1' ? '16:9' : p.aspectRatio;

  switch (mode) {
    case 'text_to_video':
      return {
        endpointId: model.endpoints.textToVideo,
        input: { prompt, resolution, duration, aspect_ratio: aspect },
      };

    case 'image_to_video':
    case 'first_last_frame': {
      const input: Record<string, unknown> = {
        prompt,
        resolution,
        duration,
        aspect_ratio: aspect,
        image_url: await requireHosted(host, p.startFrameUrl, NEED_START),
      };
      if (mode === 'first_last_frame') {
        input.end_image_url = await requireHosted(host, p.endFrameUrl, NEED_PAIR);
      } else if (p.endFrameUrl) {
        const end = await host(p.endFrameUrl);
        if (end) input.end_image_url = end;
      }
      return { endpointId: model.endpoints.imageToVideo, input };
    }

    case 'video_edit':
      // Restyle keeps the source's look and motion, re-rendered at 5s or 10s.
      return {
        endpointId: model.endpoints.videoEdit as string,
        input: {
          prompt,
          resolution,
          duration,
          video_url: await requireHosted(host, p.sourceVideoUrl ?? p.referenceVideos?.[0], needVideo('Restyle')),
        },
      };

    case 'video_reframe':
      // Keeps the source footage frame for frame and outpaints the rest of the
      // new aspect ratio, so it takes no duration. A prompt is required.
      return {
        endpointId: model.endpoints.reframe as string,
        input: {
          prompt: prompt || 'Extend the scene naturally into the new frame.',
          resolution,
          aspect_ratio: aspect,
          video_url: await requireHosted(host, p.sourceVideoUrl ?? p.referenceVideos?.[0], needVideo('Reframe')),
        },
      };

    default:
      return unsupported(p);
  }
}

async function buildVeo(p: VideoRequestInput, host: HostFn): Promise<Built> {
  const model = getModel(p.modelId);
  const mode = p.workflowMode;
  const neg = (p.negativePrompt ?? '').trim();
  const base: Record<string, unknown> = {
    prompt: p.prompt.trim(),
    // fal spells 4K as "4k".
    resolution: ((): string => {
      const r = resolveOutputResolution(p);
      return r === '2160p' ? '4k' : r;
    })(),
    duration: `${effectiveDuration(p.modelId, mode, p.duration)}s`,
    generate_audio: p.nativeAudio,
  };
  if (typeof p.seed === 'number') base.seed = p.seed;
  if (neg) base.negative_prompt = neg;
  // 'auto' is valid on every Veo endpoint except text-to-video and reference-to-video.
  const aspect = p.aspectRatio === '9:16' ? '9:16' : p.aspectRatio === '16:9' ? '16:9' : 'auto';
  const aspectNoAuto = aspect === 'auto' ? '16:9' : aspect;

  switch (mode) {
    case 'text_to_video':
      return { endpointId: model.endpoints.textToVideo, input: { ...base, aspect_ratio: aspectNoAuto } };

    case 'image_to_video': {
      const start = await requireHosted(host, p.startFrameUrl, NEED_START);
      // An end frame turns this into first/last-frame interpolation.
      if (p.endFrameUrl && model.endpoints.firstLastToVideo) {
        const end = await host(p.endFrameUrl);
        if (end) {
          return {
            endpointId: model.endpoints.firstLastToVideo,
            input: { ...base, aspect_ratio: aspect, first_frame_url: start, last_frame_url: end },
          };
        }
      }
      return {
        endpointId: model.endpoints.imageToVideo,
        input: { ...base, aspect_ratio: aspect, image_url: start },
      };
    }

    case 'first_last_frame': {
      const [first, last] = await Promise.all([host(p.startFrameUrl), host(p.endFrameUrl)]);
      if (!first || !last) throw new Error(NEED_PAIR);
      return {
        endpointId: model.endpoints.firstLastToVideo as string,
        input: { ...base, aspect_ratio: aspect, first_frame_url: first, last_frame_url: last },
      };
    }

    case 'reference_to_video': {
      const raw = p.referenceImages?.length ? p.referenceImages : p.startFrameUrl ? [p.startFrameUrl] : [];
      const images = await hostAll(host, raw.slice(0, Math.max(1, model.maxReferenceImages)));
      if (images.length === 0) throw new Error(needRefs('image'));
      // This endpoint takes no seed and no negative prompt.
      const { seed: _seed, negative_prompt: _neg, ...rest } = base;
      return {
        endpointId: model.endpoints.referenceToVideo as string,
        input: { ...rest, aspect_ratio: aspectNoAuto, image_urls: images },
      };
    }

    case 'video_extend':
      return {
        endpointId: model.endpoints.extendVideo as string,
        input: {
          ...base,
          resolution: '720p',
          aspect_ratio: aspect,
          video_url: await requireHosted(host, p.sourceVideoUrl ?? p.referenceVideos?.[0], needVideo('Extend')),
        },
      };

    default:
      return unsupported(p);
  }
}

async function buildGeminiOmni(p: VideoRequestInput, host: HostFn): Promise<Built> {
  const model = getModel(p.modelId);
  const mode = p.workflowMode;
  const prompt = promptWithAvoid(p);
  // These endpoints take no resolution, audio or seed field.
  const common = {
    prompt,
    duration: effectiveDuration(p.modelId, mode, p.duration),
    aspect_ratio: p.aspectRatio === '9:16' ? '9:16' : '16:9',
  };

  switch (mode) {
    case 'text_to_video':
      return { endpointId: model.endpoints.textToVideo, input: common };

    case 'image_to_video':
      return {
        endpointId: model.endpoints.imageToVideo,
        input: { ...common, image_url: await requireHosted(host, p.startFrameUrl, NEED_START) },
      };

    case 'reference_to_video': {
      const raw = p.referenceImages?.length ? p.referenceImages : p.startFrameUrl ? [p.startFrameUrl] : [];
      const images = await hostAll(host, raw);
      if (images.length === 0) throw new Error(needRefs('image'));
      return {
        endpointId: model.endpoints.referenceToVideo as string,
        input: { ...common, image_urls: images.slice(0, model.maxReferenceImages) },
      };
    }

    case 'video_edit':
    case 'video_extend':
      // The edit endpoint takes only the source video and the instruction.
      return {
        endpointId: model.endpoints.videoEdit as string,
        input: {
          prompt,
          video_url: await requireHosted(host, p.sourceVideoUrl ?? p.referenceVideos?.[0], needVideo('Edit')),
        },
      };

    default:
      return unsupported(p);
  }
}

/**
 * Builds the endpoint id and input for one of the supported models.
 * `host` uploads local media to fal storage (browser: through the auth'd proxy;
 * server: directly).
 */
export async function buildSharedVideoRequest(
  p: VideoRequestInput,
  host: HostFn
): Promise<BuiltVideoRequest> {
  const model = getModel(p.modelId);
  let built: Built;
  switch (model.family) {
    case 'kling':
      built = await buildKling(p, host);
      break;
    case 'wan':
      built = await buildWan(p, host);
      break;
    case 'luma':
      built = await buildLuma(p, host);
      break;
    case 'veo':
      built = await buildVeo(p, host);
      break;
    case 'gemini-omni':
      built = await buildGeminiOmni(p, host);
      break;
    default:
      throw new Error(`${model.label} is not built by the shared video request builder.`);
  }
  return {
    ...built,
    resolution: resolveOutputResolution(p),
    duration: effectiveDuration(p.modelId, p.workflowMode, p.duration),
  };
}
