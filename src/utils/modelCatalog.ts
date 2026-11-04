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

  /** Quick-pick duration chips (seconds). */
  durations: DurationSeconds[];
  minDuration: number;
  maxDuration: number;
  /** When set, any whole second in this range is valid (adds a slider). */
  durationRange?: { min: number; max: number };

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
  return Math.min(model.maxDuration, Math.max(model.minDuration, whole));
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
