import { fal } from '@fal-ai/client';
import {
  clampStudioDuration,
  getStudioModel,
  keyframeFrameIndex,
  resolveStudioResolution,
  type StudioAspectRatio,
  type StudioModelId,
  type StudioQualityTier,
  type StudioReferenceTask,
  type StudioResolution,
  type StudioTimelineKeyframe,
  type StudioWorkflowMode,
  TOPAZ_UPSCALE_MODES,
  type TopazUpscaleMode,
} from '../src/utils/videoStudioCatalog.ts';
import type { StoryboardImageModel } from '../src/types/pipeline.ts';
import type { AspectRatio, ModelId, ModelResolution, WorkflowMode } from '../src/types/flux.ts';
import { buildSharedVideoRequest, usesSharedVideoBuilder } from '../src/utils/falVideoRequests.ts';
import { readAssetAsInlineData } from './projectStore.ts';

export interface StudioGenerateInput {
  projectId: string;
  modelId: StudioModelId;
  workflowMode: StudioWorkflowMode;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: StudioAspectRatio;
  duration: number;
  qualityTier: StudioQualityTier;
  resolution?: StudioResolution;
  nativeAudio: boolean;
  safetyTolerance: number;
  enableSafetyChecker?: boolean;
  seed: number;
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  keyframes?: StudioTimelineKeyframe[];
  sourceVideoUrl?: string | null;
  referenceImages?: string[];
  referenceElements?: string[];
  referenceVideos?: string[];
  referenceAudioUrl?: string | null;
  referenceTask?: StudioReferenceTask;
}

export async function uploadMediaRefToFal(
  projectId: string,
  urlOrDataUrl: string | null | undefined
): Promise<string | null> {
  if (!urlOrDataUrl) return null;

  if (/^https?:\/\//i.test(urlOrDataUrl)) {
    return urlOrDataUrl;
  }

  if (urlOrDataUrl.startsWith('data:')) {
    const match = urlOrDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const blob = new Blob([Buffer.from(match[2], 'base64')], { type: match[1] });
    return fal.storage.upload(blob);
  }

  const inline = await readAssetAsInlineData(projectId, urlOrDataUrl);
  if (!inline) return null;
  const blob = new Blob([Buffer.from(inline.data, 'base64')], {
    type: inline.mimeType,
  });
  return fal.storage.upload(blob);
}

export async function buildFalVideoRequest(
  params: StudioGenerateInput
): Promise<{
  endpointId: string;
  input: Record<string, unknown>;
  resolvedResolution: StudioResolution;
  clampedDuration: number;
}> {
  const model = getStudioModel(params.modelId);
  const clampedDuration = clampStudioDuration(params.modelId, params.duration);
  const resolvedResolution = resolveStudioResolution({
    modelId: params.modelId,
    qualityTier: params.qualityTier,
    workflowMode: params.workflowMode,
    resolution: params.resolution,
  });

  const trimmedNeg = (params.negativePrompt || '').trim();

  // 1. FLUX 3 (Black Forest Labs) — preserved intact
  if (model.family === 'flux-3') {
    const draft = params.qualityTier === 'draft';
    const basePrompt = params.prompt.trim();
    const fluxPrompt =
      trimmedNeg && basePrompt ? `${basePrompt}\nAvoid: ${trimmedNeg}` : basePrompt;
    const input: Record<string, unknown> = {
      prompt: fluxPrompt,
      aspect_ratio: params.aspectRatio,
      duration: clampedDuration,
      generate_audio: params.nativeAudio,
      safety_tolerance: Math.min(4, Math.max(0, Math.round(params.safetyTolerance ?? 2))),
    };
    if (!draft) {
      input.resolution = resolvedResolution;
    }

    let endpoint = model.endpoints.textToVideo;
    switch (params.workflowMode) {
      case 'text_to_video':
        break;
      case 'image_to_video': {
        const start = await uploadMediaRefToFal(params.projectId, params.startFrameUrl);
        if (!start) throw new Error('Image to Video needs a start frame image.');
        input.image_url = start;
        endpoint = model.endpoints.imageToVideo;
        break;
      }
      case 'first_last_frame': {
        const [start, end] = await Promise.all([
          uploadMediaRefToFal(params.projectId, params.startFrameUrl),
          uploadMediaRefToFal(params.projectId, params.endFrameUrl),
        ]);
        if (!start || !end) {
          throw new Error('Keyframe Pair needs both a start frame and an end frame.');
        }
        input.start_image_url = start;
        input.end_image_url = end;
        endpoint = model.endpoints.firstLastToVideo || model.endpoints.imageToVideo;
        break;
      }
      case 'keyframes_timeline': {
        const filled = (params.keyframes || []).filter((k) => Boolean(k.imageUrl));
        const hosted = await Promise.all(
          filled.map(async (k) => ({
            time: k.timeSeconds,
            url: await uploadMediaRefToFal(params.projectId, k.imageUrl),
          }))
        );
        const frames = hosted
          .filter((h): h is { time: number; url: string } => Boolean(h.url))
          .map((h) => ({
            frame_index: keyframeFrameIndex(h.time, clampedDuration),
            image_url: h.url,
          }));
        if (frames.length === 0) {
          throw new Error('Timeline needs at least one frame with an image.');
        }
        if (new Set(frames.map((f) => f.frame_index)).size !== frames.length) {
          throw new Error(
            'Two timeline frames land on the same frame index. Adjust their timestamps.'
          );
        }
        frames.sort((a, b) => a.frame_index - b.frame_index);
        input.keyframes = frames.slice(0, model.maxTimelineFrames);
        endpoint = model.endpoints.keyframesToVideo || model.endpoints.imageToVideo;
        break;
      }
      case 'reference_to_video':
      case 'video_extend': {
        if (params.referenceImages && params.referenceImages.length > 0) {
          throw new Error(
            'FLUX 3 Video Extend does not accept reference images. Switch to Seedance 2.5, Kling 4.0, or Wan 3.0 Prime to combine reference images with video.'
          );
        }
        const vidCandidate = params.sourceVideoUrl || params.referenceVideos?.[0];
        const vid = await uploadMediaRefToFal(params.projectId, vidCandidate);
        if (!vid) {
          throw new Error('Video & Ref mode on FLUX 3 needs a video clip (or switch to Seedance 2.5 to use reference images).');
        }
        input.video_url = vid;
        endpoint = model.endpoints.extendVideo || model.endpoints.imageToVideo;
        break;
      }
      default:
        throw new Error('Unsupported workflow mode for FLUX 3.');
    }

    return {
      endpointId: draft ? `${endpoint}/draft` : endpoint,
      input,
      resolvedResolution,
      clampedDuration,
    };
  }

  // 2-6. Kling 4.0, Wan 3.0 Prime, Luma Ray 3.2, Veo 3.1 (+Fast), Gemini Omni Flash.
  // One builder shared with the browser (src/utils/falVideoRequests.ts); its field
  // names and limits follow each endpoint's fal.ai schema.
  if (usesSharedVideoBuilder(params.modelId as ModelId)) {
    const built = await buildSharedVideoRequest(
      {
        modelId: params.modelId as ModelId,
        workflowMode: params.workflowMode as WorkflowMode,
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        aspectRatio: params.aspectRatio as AspectRatio,
        duration: params.duration,
        qualityTier: params.qualityTier,
        resolution: params.resolution as ModelResolution | undefined,
        nativeAudio: params.nativeAudio,
        seed: params.seed,
        startFrameUrl: params.startFrameUrl,
        endFrameUrl: params.endFrameUrl,
        sourceVideoUrl: params.sourceVideoUrl,
        referenceImages: params.referenceImages,
        referenceVideos: params.referenceVideos,
        referenceElements: params.referenceElements,
        referenceAudioUrls: params.referenceAudioUrl ? [params.referenceAudioUrl] : [],
      },
      (url) => uploadMediaRefToFal(params.projectId, url)
    );
    return {
      endpointId: built.endpointId,
      input: built.input,
      resolvedResolution: built.resolution as StudioResolution,
      clampedDuration: built.duration,
    };
  }
  // 7. Seedance (2.5 or 2.0 Fast) — preserved intact
  const is25 = params.modelId === 'seedance-2.5';
  const referenceEndpoint = model.endpoints.referenceToVideo as string;
  const mappedAspect = params.aspectRatio === '2:1' ? '16:9' : params.aspectRatio;
  const base: Record<string, unknown> = {
    prompt: params.prompt.trim(),
    resolution: resolvedResolution,
    duration: String(clampedDuration),
    aspect_ratio: mappedAspect,
    generate_audio: params.nativeAudio,
    seed: params.seed,
    ...(trimmedNeg ? { negative_prompt: trimmedNeg } : {}),
  };

  if (params.workflowMode === 'keyframes_timeline') {
    const kfUrls = (
      await Promise.all(
        (params.keyframes || [])
          .filter((k) => Boolean(k.imageUrl))
          .map((k) => uploadMediaRefToFal(params.projectId, k.imageUrl))
      )
    ).filter((u): u is string => Boolean(u));
    if (kfUrls.length === 0) {
      throw new Error('Timeline needs at least one frame with an image.');
    }
    const input: Record<string, unknown> = {
      ...base,
      image_urls: kfUrls.slice(0, model.maxReferenceImages),
    };
    if (is25) input.task = 'reference';
    return {
      endpointId: referenceEndpoint,
      input,
      resolvedResolution,
      clampedDuration,
    };
  }

  if (params.workflowMode === 'image_to_video' || params.workflowMode === 'first_last_frame') {
    const start = await uploadMediaRefToFal(params.projectId, params.startFrameUrl);
    if (!start) {
      throw new Error('A start frame image is required for this mode.');
    }
    const input: Record<string, unknown> = { ...base, image_url: start };
    if (is25) input.aspect_ratio = 'auto';
    if (params.workflowMode === 'first_last_frame') {
      const end = await uploadMediaRefToFal(params.projectId, params.endFrameUrl);
      if (end) input.end_image_url = end;
    }
    return {
      endpointId: model.endpoints.imageToVideo,
      input,
      resolvedResolution,
      clampedDuration,
    };
  }

  if (params.workflowMode === 'reference_to_video' || params.workflowMode === 'video_extend') {
    const rawVideos = [
      ...(params.sourceVideoUrl ? [params.sourceVideoUrl] : []),
      ...(params.referenceVideos || []),
    ];
    const uniqueRawVideos = Array.from(new Set(rawVideos));
    const refImgs = (
      await Promise.all(
        (params.referenceImages || []).map((r) => uploadMediaRefToFal(params.projectId, r))
      )
    ).filter((u): u is string => Boolean(u));
    const refVids = (
      await Promise.all(
        uniqueRawVideos.map((r) => uploadMediaRefToFal(params.projectId, r))
      )
    ).filter((u): u is string => Boolean(u));
    if (refImgs.length === 0 && refVids.length === 0) {
      throw new Error('Add at least one video clip or reference image.');
    }
    const input: Record<string, unknown> = { ...base };
    if (refImgs.length > 0) input.image_urls = refImgs.slice(0, model.maxReferenceImages);
    if (refVids.length > 0) input.video_urls = refVids.slice(0, model.maxReferenceVideos);
    if (is25) {
      input.task =
        params.referenceTask ||
        (params.workflowMode === 'video_extend' ? 'extension' : 'reference');
    }
    return {
      endpointId: referenceEndpoint,
      input,
      resolvedResolution,
      clampedDuration,
    };
  }

  return {
    endpointId: model.endpoints.textToVideo,
    input: base,
    resolvedResolution,
    clampedDuration,
  };
}

export async function buildTopazUpscaleRequest(params: {
  projectId: string;
  videoUrl: string;
  mode: TopazUpscaleMode;
  subModel?: string;
  scaleFactor: 2 | 4;
  creativity?: number;
}): Promise<{
  endpointId: string;
  input: Record<string, unknown>;
  resolvedSubModel: string;
  scaleFactor: 2 | 4;
}> {
  const hostedSource = await uploadMediaRefToFal(params.projectId, params.videoUrl);
  if (!hostedSource) {
    throw new Error('No video source was found to upscale.');
  }

  const modeSpec = TOPAZ_UPSCALE_MODES[params.mode] || TOPAZ_UPSCALE_MODES.precision;
  const resolvedSubModel =
    params.subModel && modeSpec.models.includes(params.subModel)
      ? params.subModel
      : modeSpec.defaultModel;
  const scaleFactor: 2 | 4 = params.scaleFactor === 4 ? 4 : 2;

  // Frame Rate Lock: intentionally omit `target_fps` so original cadence (e.g. 24fps/30fps) is preserved without interpolation
  const input: Record<string, unknown> = {
    video_url: hostedSource,
    upscale_factor: scaleFactor,
    H264_output: true,
  };

  if (modeSpec.id === 'creative') {
    input.model = 'Astra 2';
    input.creativity = Math.min(
      1.0,
      Math.max(0.0, typeof params.creativity === 'number' ? params.creativity : 0.5)
    );
  } else {
    input.model = resolvedSubModel;
  }

  return {
    endpointId: modeSpec.endpoint,
    input,
    resolvedSubModel,
    scaleFactor,
  };
}

export function describeFalFailure(err: unknown): {
  status: number;
  message: string;
} {
  const errObj = err as {
    status?: number;
    body?: { detail?: unknown; error_type?: string };
    message?: string;
  };

  const status = typeof errObj?.status === 'number' ? errObj.status : 500;
  let rawMsg = err instanceof Error ? err.message : '';
  const detail = errObj?.body?.detail;
  const types: string[] = [];

  if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const item of detail) {
      const o = (item ?? {}) as { type?: string; msg?: string };
      if (o.type) types.push(o.type);
      if (o.msg) parts.push(o.msg);
    }
    if (parts.length > 0) rawMsg = parts.join('; ');
  } else if (typeof detail === 'string') {
    rawMsg = detail;
    if (errObj.body?.error_type) types.push(errObj.body.error_type);
  }

  const lower = rawMsg.toLowerCase();
  if (/audio/.test(lower) && /sensitive/.test(lower)) {
    return {
      status: 422,
      message:
        'The generated audio was flagged by safety filters. Turn off Native Sound Design and generate again.',
    };
  }
  if (
    types.includes('content_policy_violation') ||
    /sensitive|policy|moderat|not allowed|prohibited/.test(lower)
  ) {
    return {
      status: 422,
      message:
        'fal.ai content filter blocked this request. Adjust the wording or try a different frame.',
    };
  }
  if (types.includes('generation_timeout')) {
    return {
      status: 504,
      message: 'Generation timed out on fal.ai. Try again or pick a shorter duration.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 401,
      message: 'fal.ai rejected the FAL_KEY. Add FAL_KEY to the server environment variables.',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      message: 'Too many requests running on fal.ai right now. Wait a moment and try again.',
    };
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    message: rawMsg || 'Generation failed on fal.ai.',
  };
}

export interface NanoBananaFalInput {
  projectId: string;
  model: StoryboardImageModel;
  prompt: string;
  aspectRatio?: '16:9' | '9:16' | '4:5' | '1:1' | '21:9' | '4:3' | '3:4';
  resolution?: '1K' | '2K';
  referenceImageUrls?: string[];
}

export async function generateNanoBananaImageViaFal(
  params: NanoBananaFalInput
): Promise<{
  imageUrl: string;
  endpointUsed: string;
  uploadedRefCount: number;
}> {
  const uniqueRefs = Array.from(
    new Set((params.referenceImageUrls || []).map((u) => u.trim()).filter(Boolean))
  ).slice(0, 14);

  const hostedRefs = (
    await Promise.all(
      uniqueRefs.map((refUrl) => uploadMediaRefToFal(params.projectId, refUrl))
    )
  ).filter((u): u is string => Boolean(u));

  const isEdit = hostedRefs.length > 0;
  const candidateEndpoints: string[] =
    params.model === 'nano-banana-pro'
      ? isEdit
        ? ['fal-ai/nano-banana-pro/edit', 'fal-ai/nano-banana-2/edit', 'fal-ai/nano-banana/edit']
        : ['fal-ai/nano-banana-pro', 'fal-ai/nano-banana-2', 'fal-ai/nano-banana']
      : params.model === 'nano-banana'
        ? isEdit
          ? ['fal-ai/nano-banana/edit']
          : ['fal-ai/nano-banana']
        : isEdit
          ? ['fal-ai/nano-banana-2/edit', 'fal-ai/nano-banana/edit']
          : ['fal-ai/nano-banana-2', 'fal-ai/nano-banana'];

  const ratio = params.aspectRatio || '16:9';
  const resolution = params.resolution === '2K' ? '2K' : '1K';

  let lastErr: unknown = null;
  for (let i = 0; i < candidateEndpoints.length; i++) {
    const endpointId = candidateEndpoints[i];
    const supportsResolution =
      endpointId.includes('nano-banana-2') || endpointId.includes('nano-banana-pro');
    const input: Record<string, unknown> = {
      prompt: params.prompt.trim(),
      aspect_ratio: ratio,
      output_format: 'png',
      num_images: 1,
      ...(supportsResolution ? { resolution } : {}),
      ...(isEdit ? { image_urls: hostedRefs } : {}),
    };

    try {
      const result = await fal.subscribe(endpointId, { input, logs: false });
      const data = result.data as {
        images?: Array<{ url?: string }>;
        image?: { url?: string };
      };
      const imageUrl = data?.images?.[0]?.url || data?.image?.url;
      if (!imageUrl) {
        throw new Error('fal.ai Nano Banana completed without returning an image.');
      }
      return {
        imageUrl,
        endpointUsed: endpointId,
        uploadedRefCount: hostedRefs.length,
      };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if ((status === 404 || status === 422) && i < candidateEndpoints.length - 1) {
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('Nano Banana generation failed on fal.ai.');
}

