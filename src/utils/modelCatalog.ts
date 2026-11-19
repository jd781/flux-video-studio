import {
  AspectRatio,
  DurationSeconds,
  FluxGenerationParams,
  ModelFamily,
  ModelId,
  ModelResolution,
  WorkflowMode,
} from '../types/flux';
import { FLUX3_ENDPOINTS, flux3Resolutions } from './flux3';

/**
 * Central capability registry for the selectable fal.ai video models.
 *
 * Both the UI (ControlsPanel, Header) and the fal client (lib/falClient.ts)
 * read from this so a model's real limits are defined in exactly one place.
 */
export interface ModelCapabilities {
  id: ModelId;
  family: ModelFamily;
  label: string;
  /** Short tagline shown in the model picker. */
  tagline: string;

  /** All resolutions the model can output, ascending. */
  resolutions: ModelResolution[];
  /** True when the user picks the Full Quality resolution (FLUX 3). */
  resolutionSelectable: boolean;
  /** Per-workflow subset of `resolutions` (where pricing/support differs). */
  resolutionsByMode?: Partial<Record<WorkflowMode, ModelResolution[]>>;

  /** Aspect ratios the model accepts. */
  aspectRatios: AspectRatio[];
  /** Per-workflow subset of `aspectRatios` (where the endpoints differ). */
  aspectRatiosByMode?: Partial<Record<WorkflowMode, AspectRatio[]>>;

  /** Quick-pick duration chips (seconds). */
  durations: DurationSeconds[];
  minDuration: number;
  maxDuration: number;
  /** When set, any whole second in this range is valid (adds a slider). */
  durationRange?: { min: number; max: number };
  /** True when ONLY the values in `durations` are valid (e.g. Luma 5/10, Veo 4/6/8). */
  discreteDurations?: boolean;
  /** Workflows whose endpoint accepts exactly one duration, regardless of the picker. */
  fixedDurationByMode?: Partial<Record<WorkflowMode, number>>;
  /** Workflows whose output length follows the source clip (duration only feeds the cost estimate). */
  durationFromSource?: WorkflowMode[];

  /**
   * Audio behaviour: 'toggle' = the API takes an on/off flag; 'always' = audio
   * is generated and can't be switched off; 'none' = no generated audio.
   */
  audio: 'toggle' | 'always' | 'none';

  /** Max reference images accepted by the reference endpoint. */
  maxReferenceImages: number;
  /** Max reference videos accepted by the reference endpoint. */
  maxReferenceVideos: number;
  /** Max files across images + videos + audio on the reference endpoint. */
  maxTotalReferences: number;
  /** Max size of a single reference/source video, in MB. */
  maxReferenceVideoMB: number;
  /** Max images on the Timeline workflow. */
  maxTimelineFrames: number;

  /** Workflow modes this model supports. */
  workflowModes: WorkflowMode[];

  /** Whether the model has a dedicated edit/extend task mode (Seedance 2.5). */
  supportsTaskMode: boolean;
  /** Whether the API accepts a seed (FLUX 3 does not). */
  supportsSeed: boolean;
  /** Whether the API has a safety_tolerance setting (FLUX 3). */
  supportsSafetyTolerance: boolean;
  /**
   * Draft quality uses cheap `/draft` endpoints that return a cache which can
   * later be re-rendered at full quality via draft-enhance (FLUX 3).
   */
  supportsDraftEnhance: boolean;

  /** fal.ai endpoint IDs per capability. */
  endpoints: {
    textToVideo: string;
    imageToVideo: string;
    referenceToVideo?: string;
    firstLastToVideo?: string;
    keyframesToVideo?: string;
    extendVideo?: string;
    draftEnhance?: string;
    /** Edit / restyle an existing video from a text instruction. */
    videoEdit?: string;
    /** Re-frame an existing video into a new aspect ratio. */
    reframe?: string;
  };

  /** Resolution used for the "draft" and default "final" quality tiers. */
  draftResolution: ModelResolution;
  finalResolution: ModelResolution;
}

export const MODEL_CATALOG: Record<ModelId, ModelCapabilities> = {
  'seedance-2.0': {
    id: 'seedance-2.0',
    family: 'seedance',
    label: 'Seedance 2.0 Fast',
    audio: 'toggle',
    tagline: 'Fast & lower cost • up to 720p, 15s',
    resolutions: ['480p', '720p'],
    resolutionSelectable: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10, 15],
    minDuration: 4,
    maxDuration: 15,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxTotalReferences: 12,
    maxReferenceVideoMB: 50,
    maxTimelineFrames: 9,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'keyframes_timeline',
      'video_extend',
    ],
    supportsTaskMode: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'bytedance/seedance-2.0/fast/text-to-video',
      imageToVideo: 'bytedance/seedance-2.0/fast/image-to-video',
      referenceToVideo: 'bytedance/seedance-2.0/fast/reference-to-video',
    },
    draftResolution: '480p',
    finalResolution: '720p',
  },
  'seedance-2.5': {
    id: 'seedance-2.5',
    family: 'seedance',
    label: 'Seedance 2.5',
    audio: 'toggle',
    tagline: 'Highest quality • up to 1080p, 30s, 30 refs',
    resolutions: ['480p', '720p', '1080p'],
    resolutionSelectable: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10, 15, 20, 25, 30],
    minDuration: 4,
    maxDuration: 30,
    maxReferenceImages: 30,
    maxReferenceVideos: 10,
    maxTotalReferences: 50,
    maxReferenceVideoMB: 200,
    maxTimelineFrames: 10,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'keyframes_timeline',
      'reference_to_video',
      'video_extend',
    ],
    supportsTaskMode: true,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      // US-hosted region. Drop the `/us` segment for the default region.
      textToVideo: 'bytedance/seedance-2.5/us/text-to-video',
      imageToVideo: 'bytedance/seedance-2.5/us/image-to-video',
      referenceToVideo: 'bytedance/seedance-2.5/us/reference-to-video',
    },
    draftResolution: '480p',
    finalResolution: '1080p',
  },
  'flux-3': {
    id: 'flux-3',
    family: 'flux-3',
    label: 'FLUX 3',
    audio: 'toggle',
    tagline: 'Black Forest Labs • native audio, 5–20s, up to 4K',
    resolutions: ['720p', '1080p', '1440p', '2160p'],
    resolutionSelectable: true,
    // 1440p/2160p are only offered where fal publishes a price for them.
    resolutionsByMode: {
      text_to_video: flux3Resolutions('text'),
      image_to_video: flux3Resolutions('image'),
      first_last_frame: flux3Resolutions('first_last'),
      keyframes_timeline: flux3Resolutions('keyframes'),
      video_extend: flux3Resolutions('extend'),
    },
    aspectRatios: ['auto', '16:9', '9:16', '1:1', '21:9', '2:1', '4:3', '3:4'],
    durations: [5, 10, 15, 20],
    minDuration: 5,
    maxDuration: 20,
    durationRange: { min: 5, max: 20 },
    // FLUX 3 has no reference-to-video endpoint.
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxTotalReferences: 0,
    maxReferenceVideoMB: 50, // extend-video: MP4, under 50 MB and 15 s
    maxTimelineFrames: 10,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'keyframes_timeline',
      'video_extend',
    ],
    supportsTaskMode: false,
    supportsSeed: false,
    supportsSafetyTolerance: true,
    supportsDraftEnhance: true,
    endpoints: {
      textToVideo: FLUX3_ENDPOINTS.text,
      imageToVideo: FLUX3_ENDPOINTS.image,
      firstLastToVideo: FLUX3_ENDPOINTS.first_last,
      keyframesToVideo: FLUX3_ENDPOINTS.keyframes,
      extendVideo: FLUX3_ENDPOINTS.extend,
      draftEnhance: FLUX3_ENDPOINTS.enhance,
    },
    draftResolution: '720p',
    finalResolution: '1080p',
  },

  // -------------------------------------------------------------------------
  // Models below were added from the 52Launch pipeline fork. Limits and field
  // names were checked against each endpoint's OpenAPI schema on fal.ai
  // (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>).
  // Request building lives in lib/falClient.ts; prices in utils/perSecondPricing.ts.
  // -------------------------------------------------------------------------
  'kling-4.0': {
    id: 'kling-4.0',
    family: 'kling',
    label: 'Kling 4.0',
    audio: 'always',
    tagline: '3–30s • start/end frames, references, video edit',
    resolutions: ['720p', '1080p'],
    resolutionSelectable: true,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    aspectRatiosByMode: {
      // Image-to-video and edit take the shape from the source media.
      image_to_video: ['auto'],
      first_last_frame: ['auto'],
      video_edit: ['auto'],
      reference_to_video: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    },
    durations: [5, 10, 15, 20, 30],
    minDuration: 3,
    maxDuration: 30,
    durationRange: { min: 3, max: 30 },
    durationFromSource: ['video_edit'],
    // fal schema: up to 10 reference images and 5 reference videos (3-30s each,
    // 300 MB), 15 references in total with elements.
    maxReferenceImages: 10,
    maxReferenceVideos: 5,
    maxTotalReferences: 15,
    maxReferenceVideoMB: 300,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'reference_to_video',
      'video_edit',
    ],
    supportsTaskMode: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'kling/v4/text-to-video',
      imageToVideo: 'kling/v4/image-to-video',
      referenceToVideo: 'kling/v4/reference-to-video',
      videoEdit: 'kling/v4/video-to-video/edit',
    },
    draftResolution: '720p',
    finalResolution: '1080p',
  },
  'wan-3.0-prime': {
    id: 'wan-3.0-prime',
    family: 'wan',
    label: 'Wan 3.0 Prime',
    audio: 'toggle',
    tagline: 'Alibaba • up to 1080p, 30s, references',
    resolutions: ['480p', '720p', '1080p'],
    resolutionSelectable: true,
    // 'auto' is sent to fal as "adaptive".
    aspectRatios: ['auto', '16:9', '4:3', '1:1', '3:4', '9:16'],
    durations: [5, 10, 15, 30],
    minDuration: 2,
    maxDuration: 30,
    durationRange: { min: 2, max: 30 },
    // fal schema: up to 10 reference images, 5 reference videos (15s combined)
    // and 5 audio clips.
    maxReferenceImages: 10,
    maxReferenceVideos: 5,
    maxTotalReferences: 20,
    maxReferenceVideoMB: 100,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'reference_to_video',
    ],
    supportsTaskMode: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'alibaba/wan-3.0-prime/text-to-video',
      imageToVideo: 'alibaba/wan-3.0-prime/image-to-video',
      referenceToVideo: 'alibaba/wan-3.0-prime/reference-to-video',
    },
    draftResolution: '480p',
    finalResolution: '1080p',
  },
  'luma-ray-3.2': {
    id: 'luma-ray-3.2',
    family: 'luma',
    label: 'Luma Ray 3.2',
    audio: 'none',
    tagline: '5 or 10s • start/end frames, restyle, reframe',
    resolutions: ['540p', '720p', '1080p'],
    resolutionSelectable: true,
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'],
    aspectRatiosByMode: {
      // Restyle keeps the source clip's shape.
      video_edit: ['auto'],
    },
    durations: [5, 10],
    minDuration: 5,
    maxDuration: 10,
    discreteDurations: true,
    durationFromSource: ['video_reframe'],
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxTotalReferences: 0,
    maxReferenceVideoMB: 100,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'video_edit',
      'video_reframe',
    ],
    supportsTaskMode: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'luma/agent/ray/v3.2/text-to-video',
      imageToVideo: 'luma/agent/ray/v3.2/image-to-video',
      videoEdit: 'luma/agent/ray/v3.2/video-to-video',
      reframe: 'luma/agent/ray/v3.2/reframe',
    },
    draftResolution: '540p',
    finalResolution: '720p',
  },
  'veo-3.1': {
    id: 'veo-3.1',
    family: 'veo',
    label: 'Google Veo 3.1',
    audio: 'toggle',
    tagline: 'Google • 4–8s, up to 4K, native audio, references',
    resolutions: ['720p', '1080p', '2160p'],
    resolutionsByMode: {
      video_extend: ['720p'],
    },
    resolutionSelectable: true,
    aspectRatios: ['auto', '16:9', '9:16'],
    aspectRatiosByMode: {
      text_to_video: ['16:9', '9:16'],
      reference_to_video: ['16:9', '9:16'],
    },
    durations: [4, 6, 8],
    minDuration: 4,
    maxDuration: 8,
    discreteDurations: true,
    // Reference-to-video renders 8s; extend adds a fixed 7s.
    fixedDurationByMode: { reference_to_video: 8, video_extend: 7 },
    maxReferenceImages: 3,
    maxReferenceVideos: 0,
    maxTotalReferences: 3,
    maxReferenceVideoMB: 100,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'reference_to_video',
      'video_extend',
    ],
    supportsTaskMode: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'fal-ai/veo3.1',
      imageToVideo: 'fal-ai/veo3.1/image-to-video',
      firstLastToVideo: 'fal-ai/veo3.1/first-last-frame-to-video',
      referenceToVideo: 'fal-ai/veo3.1/reference-to-video',
      extendVideo: 'fal-ai/veo3.1/extend-video',
    },
    draftResolution: '720p',
    finalResolution: '1080p',
  },
  'veo-3.1-fast': {
    id: 'veo-3.1-fast',
    family: 'veo',
    label: 'Google Veo 3.1 Fast',
    audio: 'toggle',
    tagline: 'Google • faster, lower cost, up to 4K',
    resolutions: ['720p', '1080p', '2160p'],
    resolutionsByMode: {
      video_extend: ['720p'],
    },
    resolutionSelectable: true,
    aspectRatios: ['auto', '16:9', '9:16'],
    aspectRatiosByMode: {
      text_to_video: ['16:9', '9:16'],
    },
    durations: [4, 6, 8],
    minDuration: 4,
    maxDuration: 8,
    discreteDurations: true,
    fixedDurationByMode: { video_extend: 7 },
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxTotalReferences: 0,
    maxReferenceVideoMB: 100,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'video_extend',
    ],
    supportsTaskMode: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'fal-ai/veo3.1/fast',
      imageToVideo: 'fal-ai/veo3.1/fast/image-to-video',
      firstLastToVideo: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
      extendVideo: 'fal-ai/veo3.1/fast/extend-video',
    },
    draftResolution: '720p',
    finalResolution: '1080p',
  },
  'gemini-omni-flash': {
    id: 'gemini-omni-flash',
    family: 'gemini-omni',
    label: 'Google Gemini Omni Flash',
    audio: 'always',
    tagline: 'Google • 3–10s, image references, video edit, audio',
    // These endpoints take no resolution field. 720p is the nominal tier used
    // for labels and cost; fal decides the actual output size.
    resolutions: ['720p'],
    resolutionSelectable: false,
    aspectRatios: ['16:9', '9:16'],
    aspectRatiosByMode: {
      video_edit: ['auto'],
    },
    durations: [3, 5, 8, 10],
    minDuration: 3,
    maxDuration: 10,
    durationRange: { min: 3, max: 10 },
    durationFromSource: ['video_edit'],
    maxReferenceImages: 10,
    maxReferenceVideos: 0,
    maxTotalReferences: 10,
    maxReferenceVideoMB: 100,
    maxTimelineFrames: 0,
    workflowModes: [
      'text_to_video',
      'image_to_video',
      'reference_to_video',
      'video_edit',
    ],
    supportsTaskMode: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsDraftEnhance: false,
    endpoints: {
      textToVideo: 'google/gemini-omni-flash',
      imageToVideo: 'google/gemini-omni-flash/image-to-video',
      referenceToVideo: 'google/gemini-omni-flash/reference-to-video',
      videoEdit: 'google/gemini-omni-flash/edit',
    },
    draftResolution: '720p',
    finalResolution: '720p',
  },
};

export const DEFAULT_MODEL_ID: ModelId = 'seedance-2.5';

export function getModel(modelId: ModelId): ModelCapabilities {
  return MODEL_CATALOG[modelId] ?? MODEL_CATALOG[DEFAULT_MODEL_ID];
}

// ---------------------------------------------------------------------------
// Model families (the top "Model" dropdown)
// ---------------------------------------------------------------------------

export interface FamilyInfo {
  id: ModelFamily;
  label: string;
  tagline: string;
  /** Versions of this family, in display order. */
  modelIds: ModelId[];
  defaultModelId: ModelId;
}

export const MODEL_FAMILIES: Record<ModelFamily, FamilyInfo> = {
  seedance: {
    id: 'seedance',
    label: 'Seedance (ByteDance)',
    tagline: 'Reference images & videos, edit/extend tasks, up to 30s',
    modelIds: ['seedance-2.0', 'seedance-2.5'],
    defaultModelId: 'seedance-2.5',
  },
  'flux-3': {
    id: 'flux-3',
    label: 'FLUX 3 (Black Forest Labs)',
    tagline: 'Draft & enhance, keyframes, up to 4K with native audio',
    modelIds: ['flux-3'],
    defaultModelId: 'flux-3',
  },
  kling: {
    id: 'kling',
    label: 'Kling 4.0',
    tagline: 'Start/end frames, up to 15 references, 3–30s, video edit',
    modelIds: ['kling-4.0'],
    defaultModelId: 'kling-4.0',
  },
  wan: {
    id: 'wan',
    label: 'Wan 3.0 Prime (Alibaba)',
    tagline: 'Start/end frames and reference media, up to 1080p',
    modelIds: ['wan-3.0-prime'],
    defaultModelId: 'wan-3.0-prime',
  },
  luma: {
    id: 'luma',
    label: 'Luma Ray 3.2',
    tagline: 'Start/end frames, video restyle and reframe (outpaint)',
    modelIds: ['luma-ray-3.2'],
    defaultModelId: 'luma-ray-3.2',
  },
  veo: {
    id: 'veo',
    label: 'Google Veo 3.1',
    tagline: 'Up to 4K with synchronized audio, reference images, extend',
    modelIds: ['veo-3.1', 'veo-3.1-fast'],
    defaultModelId: 'veo-3.1',
  },
  'gemini-omni': {
    id: 'gemini-omni',
    label: 'Google Gemini Omni Flash',
    tagline: 'Text, image and reference to video, plus conversational edit',
    modelIds: ['gemini-omni-flash'],
    defaultModelId: 'gemini-omni-flash',
  },
};

export function getFamily(modelId: ModelId): FamilyInfo {
  return MODEL_FAMILIES[getModel(modelId).family];
}

// ---------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------

/** Clamp a requested duration into the model's supported whole-second range. */
export function clampDurationForModel(modelId: ModelId, duration: number): number {
  const model = getModel(modelId);
  const whole = Math.round(duration);
  const clamped = Math.min(model.maxDuration, Math.max(model.minDuration, whole));
  if (!model.discreteDurations) return clamped;
  // Only the listed values are valid: snap to the nearest one.
  return model.durations.reduce(
    (best, d) => (Math.abs(d - clamped) < Math.abs(best - clamped) ? d : best),
    model.durations[0]
  );
}

/**
 * The duration a generation will actually be requested with: the endpoint's
 * fixed value when it has one (e.g. Veo reference-to-video is always 8s),
 * otherwise the user's choice clamped to what the model accepts.
 */
export function effectiveDuration(
  modelId: ModelId,
  mode: WorkflowMode,
  duration: number
): number {
  const fixed = getModel(modelId).fixedDurationByMode?.[mode];
  return fixed ?? clampDurationForModel(modelId, duration);
}

/** Aspect ratios available for a model in a given workflow mode. */
export function getAvailableAspectRatios(
  modelId: ModelId,
  mode: WorkflowMode
): AspectRatio[] {
  const model = getModel(modelId);
  return model.aspectRatiosByMode?.[mode] ?? model.aspectRatios;
}

/** Resolutions available for a model in a given workflow mode. */
export function getAvailableResolutions(
  modelId: ModelId,
  mode: WorkflowMode
): ModelResolution[] {
  const model = getModel(modelId);
  return model.resolutionsByMode?.[mode] ?? model.resolutions;
}

/** Resolution for a quality tier under a given model (ignores user selection). */
export function resolutionForTier(
  modelId: ModelId,
  qualityTier: 'draft' | 'final'
): ModelResolution {
  const model = getModel(modelId);
  return qualityTier === 'draft' ? model.draftResolution : model.finalResolution;
}

/**
 * The resolution a generation will actually be requested at. Draft is always
 * the model's draft resolution. Full Quality honours the user's choice on
 * models that allow one, falling back to a valid default for the mode.
 */
export function resolveOutputResolution(
  p: Pick<FluxGenerationParams, 'modelId' | 'qualityTier' | 'workflowMode' | 'resolution'>
): ModelResolution {
  const model = getModel(p.modelId);
  if (p.qualityTier === 'draft') return model.draftResolution;
  if (!model.resolutionSelectable) return model.finalResolution;

  const available = getAvailableResolutions(p.modelId, p.workflowMode);
  if (p.resolution && available.includes(p.resolution)) return p.resolution;
  return available.includes(model.finalResolution)
    ? model.finalResolution
    : available[available.length - 1];
}

/** True when a Draft-tier generation can later be enhanced to full quality. */
export function isDraftEnhanceModel(modelId: ModelId): boolean {
  return getModel(modelId).supportsDraftEnhance;
}
