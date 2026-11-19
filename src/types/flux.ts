export type WorkflowMode =
  | 'text_to_video'
  | 'image_to_video'
  | 'first_last_frame'
  | 'keyframes_timeline'
  | 'reference_to_video'
  | 'video_extend'
  /** Restyle / edit an existing video from a text instruction (Kling, Luma, Gemini). */
  | 'video_edit'
  /** Re-frame an existing video into a new aspect ratio (Luma). */
  | 'video_reframe';

/**
 * Seedance 2.5 reference-to-video task mode.
 * - reference: use attached media as guidance (default)
 * - editing:   modify a reference video
 * - extension: continue a reference video
 * - auto:      let the model decide from prompt + references
 */
export type ReferenceTask = 'reference' | 'editing' | 'extension' | 'auto';

/**
 * Aspect ratios across all models. Each model advertises the subset it supports
 * in MODEL_CATALOG; 'auto' lets the model decide (FLUX 3).
 */
export type AspectRatio =
  | '16:9'
  | '9:16'
  | '1:1'
  | '21:9'
  | '2:1'
  | '4:3'
  | '3:4'
  | 'auto';

/** Whole seconds. Each model defines its own allowed range in MODEL_CATALOG. */
export type DurationSeconds = number;
export type QualityTier = 'draft' | 'final';

/** A provider/family of models, shown in the top "Model" dropdown. */
export type ModelFamily =
  | 'seedance'
  | 'flux-3'
  | 'kling'
  | 'wan'
  | 'luma'
  | 'veo'
  | 'gemini-omni';

/**
 * Which fal.ai video model to generate with. The UI and the fal client both
 * read capabilities from MODEL_CATALOG (see utils/modelCatalog.ts) keyed on this.
 */
export type ModelId =
  | 'seedance-2.0'
  | 'seedance-2.5'
  | 'flux-3'
  | 'kling-4.0'
  | 'wan-3.0-prime'
  | 'luma-ray-3.2'
  | 'veo-3.1'
  | 'veo-3.1-fast'
  | 'gemini-omni-flash';

export type ModelResolution = '480p' | '540p' | '720p' | '1080p' | '1440p' | '2160p';

export interface TimelineKeyframe {
  id: string;
  timeSeconds: number;
  imageUrl: string;
  label?: string;
  note?: string;
}

export interface FluxGenerationParams {
  /** Selected fal.ai video model. Drives both the UI and the generation request. */
  modelId: ModelId;
  workflowMode: WorkflowMode;
  prompt: string;
  negativePrompt?: string;
  nativeAudio: boolean;
  audioPrompt?: string;
  aspectRatio: AspectRatio;
  duration: DurationSeconds;
  qualityTier: QualityTier;
  // Advanced controls
  guidanceScale: number; // 1.0 - 8.0 (default 3.5)
  transformationStrength: number; // 0.0 - 1.0 (default 0.75)
  inferenceSteps: number; // 15 - 50 (default 30)
  seed: number; // integer >= 0, or randomized
  cameraMovement?: string;
  fps: 24 | 30 | 60;
  // Media slots
  startFrameUrl: string | null;
  endFrameUrl: string | null;
  keyframes: TimelineKeyframe[];
  sourceVideoUrl: string | null;
  sourceVideoName?: string;
  referenceImages?: string[];
  /** Reference videos for reference-to-video (@Video1..@VideoN). Seedance 2.5 allows up to 10. */
  referenceVideos?: string[];
  /** Seedance 2.5 reference-to-video task mode (only used in reference_to_video). */
  referenceTask?: ReferenceTask;
  /**
   * Output resolution for Full Quality on models that let you choose (FLUX 3).
   * Ignored by models with a fixed resolution per quality tier.
   */
  resolution?: ModelResolution;
  /** FLUX 3 content-filter strictness: 0 = strictest, 4 = most permissive (default 2). */
  safetyTolerance?: number;
}

export interface GenerationQueueStatus {
  isGenerating: boolean;
  progressPercent: number; // 0 - 100
  currentStep: number;
  totalSteps: number;
  phase: 'idle' | 'queued' | 'vram_allocation' | 'denoising' | 'audio_synthesis' | 'encoding' | 'completed' | 'failed';
  statusMessage: string;
  etaSeconds: number;
}

export interface UpscaleState {
  isUpscaling: boolean;
  takeId: string | null;
  targetResolution: '1080p' | '4K';
  progressPercent: number;
  stepMessage: string;
}

export interface BatchUpscaleState {
  isProcessing: boolean;
  currentIndex: number;
  totalCount: number;
  targetResolution: '1080p' | '4K';
  activeTakeId: string | null;
  completedCount: number;
}

export interface VideoTake {
  id: string;
  createdAt: number;
  title: string;
  videoUrl: string;
  posterUrl: string;
  duration: number;
  aspectRatio: AspectRatio;
  qualityTier: QualityTier;
  resolution: ModelResolution | '4K';
  prompt: string;
  params: FluxGenerationParams;
  hasAudio: boolean;
  costEstimate: number;
  isFavorite?: boolean;
  upscaledFromId?: string;
  /**
   * FLUX 3 draft takes keep the encrypted draft cache returned by fal. Passing
   * it to draft-enhance re-renders the same draft at full quality.
   */
  draftCacheUrl?: string;
  upscaleDetails?: {
    model: string; // e.g. 'fal-ai/video-upscaler'
    targetResolution: '1080p' | '4K';
    upscaledAt: number;
  };
}

export type SessionVisibility = 'private' | 'team' | 'shared';

export interface FluxProject {
  id: string;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  folder?: string;
  params: FluxGenerationParams;
  takes: VideoTake[];
  currentTakeId: string | null;
  thumbnailUrl?: string;
  isStarred?: boolean;
  // Server-backed sharing/ownership (populated from the sessions API).
  ownerEmail?: string;
  visibility?: SessionVisibility;
  sharedWith?: string[];
  isOwner?: boolean;
}

export interface TeamMember {
  email: string;
  name: string | null;
}

