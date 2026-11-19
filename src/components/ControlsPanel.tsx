import React, { useState, useRef } from 'react';
import {
  Type,
  Image as ImageIcon,
  SplitSquareVertical,
  Clock,
  Film,
  Volume2,
  VolumeX,
  Sliders,
  ChevronDown,
  ChevronUp,
  Dices,
  Maximize2,
  Smartphone,
  Square,
  Sparkles,
  Images,
  RectangleHorizontal,
  RectangleVertical,
  Pencil,
  Crop,
} from 'lucide-react';
import {
  AspectRatio,
  FluxGenerationParams,
  ModelFamily,
  ModelId,
  ModelResolution,
  ReferenceTask,
  TimelineKeyframe,
  WorkflowMode,
} from '../types/flux';
import { MediaDropzones } from './MediaDropzones';
import { generateRandomSeed } from '../utils/fluxVideoUtils';
import {
  MODEL_FAMILIES,
  clampDurationForModel,
  getAvailableAspectRatios,
  getAvailableResolutions,
  getFamily,
  getModel,
  resolveOutputResolution,
} from '../utils/modelCatalog';
import { flux3KindForMode, flux3RatePerSecond } from '../utils/flux3';
import {
  isPerSecondModel,
  perSecondRate,
  pricingKindForMode,
} from '../utils/perSecondPricing';

const ASPECT_META: Record<AspectRatio, { label: string; icon: React.ElementType }> = {
  '16:9': { label: '16:9', icon: Maximize2 },
  '9:16': { label: '9:16', icon: Smartphone },
  '1:1': { label: '1:1', icon: Square },
  '21:9': { label: '21:9', icon: RectangleHorizontal },
  '2:1': { label: '2:1', icon: RectangleHorizontal },
  '4:3': { label: '4:3', icon: RectangleHorizontal },
  '3:4': { label: '3:4', icon: RectangleVertical },
  auto: { label: 'Auto', icon: Sparkles },
};

const RESOLUTION_LABEL: Record<ModelResolution, string> = {
  '480p': '480p',
  '540p': '540p',
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '2K',
  '2160p': '4K',
};

interface ControlsPanelProps {
  params: FluxGenerationParams;
  onChangeParams: (newParams: Partial<FluxGenerationParams>) => void;
  disabled?: boolean;
}

const WORKFLOW_TABS: {
  id: WorkflowMode;
  label: string;
  icon: React.ElementType;
}[] = [
  { id: 'text_to_video', label: 'Text to Video', icon: Type },
  { id: 'image_to_video', label: 'Image to Video', icon: ImageIcon },
  { id: 'first_last_frame', label: 'Keyframe Pair', icon: SplitSquareVertical },
  { id: 'keyframes_timeline', label: 'Timeline', icon: Clock },
  { id: 'reference_to_video', label: 'Reference', icon: Images },
  { id: 'video_extend', label: 'Extend & Edit', icon: Film },
  { id: 'video_edit', label: 'Edit', icon: Pencil },
  { id: 'video_reframe', label: 'Reframe', icon: Crop },
];

const REFERENCE_TASKS: { id: ReferenceTask; label: string; hint: string }[] = [
  { id: 'reference', label: 'Reference', hint: 'Use media as guidance' },
  { id: 'editing', label: 'Edit', hint: 'Modify a reference video' },
  { id: 'extension', label: 'Extend', hint: 'Continue a reference video' },
  { id: 'auto', label: 'Auto', hint: 'Let the model decide' },
];

const CAMERA_TAGS = [
  'Dolly In',
  'Dynamic Orbit',
  'Drone Flyover',
  'Pan Right',
  'Crane Up',
  'FPV Dive',
  'Anamorphic 35mm',
  'Hyperlapse',
];

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  params,
  onChangeParams,
  disabled = false,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const model = getModel(params.modelId);
  const family = getFamily(params.modelId);
  const visibleTabs = WORKFLOW_TABS.filter((tab) =>
    model.workflowModes.includes(tab.id)
  );

  // FLUX 3 specifics, derived from the model's capabilities.
  const safetyTolerance = params.safetyTolerance ?? 2;
  const effectiveResolution = resolveOutputResolution(params);
  // What Full Quality would render at, regardless of the tier currently selected.
  const finalResolution = resolveOutputResolution({ ...params, qualityTier: 'final' });
  const availableResolutions = getAvailableResolutions(
    params.modelId,
    params.workflowMode
  );
  const fluxKind = flux3KindForMode(params.workflowMode);
  const ratePerSecond =
    model.family === 'flux-3' && fluxKind
      ? flux3RatePerSecond(fluxKind, effectiveResolution, params.qualityTier === 'draft')
      : isPerSecondModel(params.modelId)
      ? perSecondRate({
          modelId: params.modelId,
          kind: pricingKindForMode(params.workflowMode),
          resolution: effectiveResolution,
          durationSeconds: params.duration,
          audio: params.nativeAudio,
          hasVideoInput:
            (['video_extend', 'video_edit', 'video_reframe'].includes(params.workflowMode) &&
              Boolean(params.sourceVideoUrl)) ||
            (params.workflowMode === 'reference_to_video' &&
              (params.referenceVideos?.length ?? 0) > 0),
        })
      : null;
  const availableAspectRatios = getAvailableAspectRatios(params.modelId, params.workflowMode);
  const fixedDuration = model.fixedDurationByMode?.[params.workflowMode];
  const durationFromSource = model.durationFromSource?.includes(params.workflowMode) ?? false;

  const handleModelChange = (modelId: ModelId) => {
    const next = getModel(modelId);

    // Keep the current duration if the new model allows it; otherwise snap to
    // the nearest value it does allow.
    const clamped = clampDurationForModel(modelId, params.duration);
    const duration =
      next.durationRange || next.durations.includes(clamped)
        ? clamped
        : next.durations.reduce(
            (best, d) =>
              Math.abs(d - clamped) < Math.abs(best - clamped) ? d : best,
            next.durations[0]
          );

    const workflowMode = next.workflowModes.includes(params.workflowMode)
      ? params.workflowMode
      : next.workflowModes[0];

    const nextRatios = getAvailableAspectRatios(modelId, workflowMode);
    const aspectRatio = nextRatios.includes(params.aspectRatio)
      ? params.aspectRatio
      : nextRatios.includes('16:9')
      ? '16:9'
      : nextRatios[0];

    // A chosen resolution only carries over if the new model/mode offers it.
    const keepResolution =
      next.resolutionSelectable &&
      params.resolution &&
      getAvailableResolutions(modelId, workflowMode).includes(params.resolution);

    onChangeParams({
      modelId,
      duration,
      workflowMode,
      aspectRatio,
      resolution: keepResolution ? params.resolution : undefined,
      safetyTolerance: params.safetyTolerance ?? 2,
    });
  };

  // Switching family jumps to that family's default version.
  const handleFamilyChange = (familyId: ModelFamily) => {
    if (familyId === model.family) return;
    handleModelChange(MODEL_FAMILIES[familyId].defaultModelId);
  };

  const handleModeChange = (mode: WorkflowMode) => {
    const patch: Partial<FluxGenerationParams> = { workflowMode: mode };
    // Some resolutions are only offered for certain workflows (FLUX 3).
    if (
      params.resolution &&
      !getAvailableResolutions(params.modelId, mode).includes(params.resolution)
    ) {
      patch.resolution = undefined;
    }
    // Some workflows accept a different set of aspect ratios (e.g. Veo
    // text-to-video has no "auto"); keep the choice if still valid, else snap.
    const ratios = getAvailableAspectRatios(params.modelId, mode);
    if (!ratios.includes(params.aspectRatio)) {
      patch.aspectRatio = ratios.includes('16:9') ? '16:9' : ratios[0];
    }
    onChangeParams(patch);
  };

  const handleAddCameraTag = (tag: string) => {
    const trimmed = params.prompt.trim();
    if (!trimmed.includes(tag)) {
      onChangeParams({
        prompt: trimmed ? `${trimmed}, ${tag}` : tag,
      });
    }
  };

  const handleRandomizeSeed = () => {
    const newSeed = generateRandomSeed();
    onChangeParams({ seed: newSeed });
  };

  // Insert a reference tag (e.g. "@Image1") at the textarea caret, or append to
  // the end if the caret position is unknown. Surrounding spaces are added only
  // where needed so the tag reads inline. Caret is restored after the tag.
  const handleInsertPromptTag = (tag: string) => {
    const el = promptRef.current;
    const current = params.prompt;

    // selectionStart/End persist even while the textarea is blurred, so a click
    // on a thumbnail still gives us the last caret position.
    const hasSelection =
      el && el.selectionStart != null && el.selectionEnd != null;
    const start = hasSelection ? el.selectionStart : current.length;
    const end = hasSelection ? el.selectionEnd : current.length;

    const before = current.slice(0, start);
    const after = current.slice(end);

    // Add a leading space if the char before isn't whitespace, and a trailing
    // space if the char after isn't whitespace (and isn't end-of-string + already spaced).
    const needLead = before.length > 0 && !/\s$/.test(before);
    const needTrail = after.length === 0 || !/^\s/.test(after);
    const insert = `${needLead ? ' ' : ''}${tag}${needTrail ? ' ' : ''}`;

    const next = before + insert + after;
    onChangeParams({ prompt: next });

    // Restore focus and place the caret right after the inserted tag.
    const caret = (before + insert).length;
    requestAnimationFrame(() => {
      const node = promptRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(caret, caret);
      }
    });
  };

  return (
    <div className="flex flex-col h-full bg-neutral-950 text-neutral-100 overflow-y-auto">
      {/* Panel Header */}
      <div className="px-5 py-3 border-b border-white/[0.08] flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400">
          Studio Controls
        </span>
        <span className="text-[10px] font-mono text-neutral-500">
          {model.label}
        </span>
      </div>

      <div className="p-4 sm:p-5 space-y-6 flex-1">
        {/* Model family (provider) dropdown */}
        <div className="space-y-2">
          <label
            htmlFor="model-family"
            className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400 block"
          >
            Model
          </label>
          <div className="relative">
            <select
              id="model-family"
              value={model.family}
              onChange={(e) => handleFamilyChange(e.target.value as ModelFamily)}
              disabled={disabled}
              className="w-full appearance-none bg-neutral-900 border border-white/10 rounded-xl pl-3 pr-9 py-2.5 text-xs font-medium text-white focus:outline-none focus:border-white/30 transition-colors disabled:opacity-50 cursor-pointer"
            >
              {Object.values(MODEL_FAMILIES).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-neutral-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <p className="text-[10px] text-neutral-500 leading-relaxed">
            {family.tagline}
          </p>
        </div>

        {/* Model version selector (within the chosen family) */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400 block">
            Generation Model
          </label>
          <div
            className="grid gap-1.5 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]"
            style={{
              gridTemplateColumns: `repeat(${family.modelIds.length}, minmax(0, 1fr))`,
            }}
          >
            {family.modelIds.map((id) => getModel(id)).map((m) => {
              const isActive = params.modelId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleModelChange(m.id)}
                  disabled={disabled}
                  className={`p-2.5 rounded-lg text-left transition-all ${
                    isActive
                      ? 'bg-neutral-800 text-white border border-white/15 shadow-xs'
                      : 'text-neutral-400 hover:text-white border border-transparent'
                  }`}
                  title={m.tagline}
                >
                  <div className="text-xs font-semibold text-white leading-tight">
                    {m.label}
                  </div>
                  <div className="text-[10px] text-neutral-400 mt-0.5 leading-tight">
                    {m.tagline}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Workflow Mode Selector */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400 block">
            Workflow Mode
          </label>
          <div
            className="grid gap-1 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]"
            style={{
              gridTemplateColumns: `repeat(${Math.min(visibleTabs.length, 6)}, minmax(0, 1fr))`,
            }}
          >
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = params.workflowMode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleModeChange(tab.id)}
                  disabled={disabled}
                  className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg transition-all ${
                    isActive
                      ? 'bg-neutral-800 text-white shadow-xs font-medium'
                      : 'text-neutral-400 hover:text-white hover:bg-white/5'
                  }`}
                  title={tab.label}
                >
                  <Icon className="w-3.5 h-3.5 mb-1" />
                  <span className="text-[10px] leading-tight text-center line-clamp-1">
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Media Dropzones */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400">
              Media Input
            </label>
            <span className="text-[10px] text-neutral-500 font-mono">Drag & Drop</span>
          </div>
          <MediaDropzones
            workflowMode={params.workflowMode}
            duration={params.duration}
            maxReferenceImages={model.maxReferenceImages}
            maxReferenceVideos={model.maxReferenceVideos}
            startFrameUrl={params.startFrameUrl}
            endFrameUrl={params.endFrameUrl}
            keyframes={params.keyframes}
            sourceVideoUrl={params.sourceVideoUrl}
            sourceVideoName={params.sourceVideoName}
            referenceImages={params.referenceImages || []}
            referenceVideos={params.referenceVideos || []}
            showFrameIndex={model.family === 'flux-3'}
            onUpdateStartFrame={(url) => onChangeParams({ startFrameUrl: url })}
            onUpdateEndFrame={(url) => onChangeParams({ endFrameUrl: url })}
            onUpdateKeyframes={(kfs: TimelineKeyframe[]) => onChangeParams({ keyframes: kfs })}
            onUpdateSourceVideo={(url, name) =>
              onChangeParams({ sourceVideoUrl: url, sourceVideoName: name })
            }
            onUpdateReferenceImages={(imgs) => onChangeParams({ referenceImages: imgs })}
            onUpdateReferenceVideos={(vids) => onChangeParams({ referenceVideos: vids })}
            onInsertPromptTag={handleInsertPromptTag}
          />
        </div>

        {/* Reference Task Mode (Seedance 2.5 reference-to-video only) */}
        {params.workflowMode === 'reference_to_video' && model.supportsTaskMode && (
          <div className="space-y-2">
            <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400 block">
              Reference Task
            </label>
            <div className="grid grid-cols-4 gap-1.5 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]">
              {REFERENCE_TASKS.map((t) => {
                const isActive = (params.referenceTask || 'reference') === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onChangeParams({ referenceTask: t.id })}
                    disabled={disabled}
                    className={`py-1.5 rounded-lg text-xs transition-all ${
                      isActive
                        ? 'bg-neutral-800 text-white font-semibold shadow-xs'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                    title={t.hint}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-neutral-500 leading-relaxed">
              Attach up to {model.maxReferenceImages} reference images (and a video)
              and refer to them in your prompt as{' '}
              <span className="font-mono text-neutral-400">@Image1</span>,{' '}
              <span className="font-mono text-neutral-400">@Video1</span>, etc.
            </p>
          </div>
        )}

        {/* Prompt & Audio Direction */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400">
              Prompt & Motion Direction
            </label>
            <span className="text-[10px] text-neutral-500 font-mono">
              {params.prompt.length} chars
            </span>
          </div>

          <div className="space-y-2">
            <textarea
              ref={promptRef}
              rows={3}
              value={params.prompt}
              disabled={disabled}
              onChange={(e) => onChangeParams({ prompt: e.target.value })}
              placeholder="Describe scene motion, camera dynamics, lighting, and narrative atmosphere..."
              className="w-full bg-neutral-900 border border-white/10 rounded-xl p-3 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-white/30 transition-all resize-y leading-relaxed"
            />

            {/* Subtle Camera Motion Pills */}
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              <span className="text-[10px] text-neutral-500 mr-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-neutral-400" /> Camera:
              </span>
              {CAMERA_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleAddCameraTag(tag)}
                  disabled={disabled}
                  className="text-[10px] px-2 py-0.5 rounded-md bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-white/[0.06] hover:border-white/20 transition-colors"
                >
                  +{tag}
                </button>
              ))}
            </div>
          </div>

          {/* Models whose API has no audio switch: say what they do instead */}
          {model.audio !== 'toggle' && (
            <div className="bg-neutral-900/60 border border-white/[0.08] rounded-xl p-3 flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-neutral-800 text-neutral-400">
                {model.audio === 'always' ? (
                  <Volume2 className="w-3.5 h-3.5" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
              </div>
              <div className="text-[11px] text-neutral-400">
                {model.audio === 'always'
                  ? `${model.label} generates audio automatically. It can’t be turned off.`
                  : `${model.label} doesn’t generate audio.`}
              </div>
            </div>
          )}

          {/* Sleek Apple Toggle: Native Audio */}
          {model.audio === 'toggle' && (
          <div className="bg-neutral-900/60 border border-white/[0.08] rounded-xl p-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div
                className={`p-1.5 rounded-lg ${
                  params.nativeAudio
                    ? 'bg-white/10 text-white'
                    : 'bg-neutral-800 text-neutral-400'
                }`}
              >
                {params.nativeAudio ? (
                  <Volume2 className="w-3.5 h-3.5" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
              </div>
              <div>
                <div className="text-xs font-medium text-white">
                  Native Sound Design
                </div>
                <div className="text-[11px] text-neutral-400">
                  Synthesize synced dialogue, ambient audio, and foley
                </div>
              </div>
            </div>

            {/* Apple style toggle switch */}
            <button
              type="button"
              role="switch"
              aria-checked={params.nativeAudio}
              disabled={disabled}
              onClick={() => onChangeParams({ nativeAudio: !params.nativeAudio })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                params.nativeAudio ? 'bg-white' : 'bg-neutral-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow-md ring-0 transition duration-200 ease-in-out mt-0.5 ${
                  params.nativeAudio
                    ? 'translate-x-4 bg-neutral-950'
                    : 'translate-x-0.5 bg-neutral-200'
                }`}
              />
            </button>
          </div>
          )}
        </div>

        {/* Format & Presets */}
        <div className="space-y-4">
          <label className="text-[11px] font-semibold tracking-wider uppercase text-neutral-400 block">
            Format & Quality
          </label>

          {/* Aspect Ratio Chips */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-300">Aspect Ratio</span>
              <span className="text-[10px] text-neutral-500 font-mono">{params.aspectRatio}</span>
            </div>
            <div
              className="grid gap-1.5 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]"
              style={{
                gridTemplateColumns: `repeat(${Math.min(availableAspectRatios.length, 4)}, minmax(0, 1fr))`,
              }}
            >
              {availableAspectRatios
                .map((id) => ({ id, ...ASPECT_META[id] }))
                .map((item) => {
                const Icon = item.icon;
                const isActive = params.aspectRatio === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChangeParams({ aspectRatio: item.id })}
                    disabled={disabled}
                    className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs transition-all ${
                      isActive
                        ? 'bg-neutral-800 text-white font-medium shadow-xs'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <Icon className="w-3 h-3" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Duration Chips */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-300">
                {durationFromSource ? 'Source length (cost estimate)' : 'Duration'}
              </span>
              <span className="text-[10px] text-neutral-500 font-mono">
                {fixedDuration ?? params.duration} seconds
              </span>
            </div>
            {fixedDuration !== undefined && (
              <p className="text-[10px] text-neutral-500 leading-relaxed">
                {model.label} renders a fixed {fixedDuration}s for this workflow.
              </p>
            )}
            {durationFromSource && (
              <p className="text-[10px] text-neutral-500 leading-relaxed">
                The output follows your source clip. This value only sets the cost estimate.
              </p>
            )}
            <div
              hidden={fixedDuration !== undefined}
              className="grid gap-1.5 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]"
              style={{
                gridTemplateColumns: `repeat(${model.durations.length}, minmax(0, 1fr))`,
              }}
            >
              {model.durations.map((dur) => {
                const isActive = params.duration === dur;
                return (
                  <button
                    key={dur}
                    type="button"
                    onClick={() => onChangeParams({ duration: dur })}
                    disabled={disabled}
                    className={`py-1.5 rounded-lg text-xs font-mono transition-all ${
                      isActive
                        ? 'bg-neutral-800 text-white font-semibold shadow-xs'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    {dur}s
                  </button>
                );
              })}
            </div>
            {/* Any whole second in the model's range (FLUX 3: 5-20s) */}
            {model.durationRange && fixedDuration === undefined && (
              <input
                type="range"
                min={model.durationRange.min}
                max={model.durationRange.max}
                step={1}
                value={params.duration}
                disabled={disabled}
                onChange={(e) =>
                  onChangeParams({ duration: parseInt(e.target.value, 10) })
                }
                className="w-full cursor-pointer"
                aria-label="Duration in seconds"
              />
            )}
          </div>

          {/* Quality Tier Selector */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-300">Resolution Quality</span>
              <span className="text-[10px] text-neutral-500 font-mono">
                {params.qualityTier === 'draft' ? 'Fast Preview' : 'Production Master'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]">
              {/* Draft (480p) */}
              <button
                type="button"
                onClick={() => onChangeParams({ qualityTier: 'draft' })}
                disabled={disabled}
                className={`p-2.5 rounded-lg text-left transition-all ${
                  params.qualityTier === 'draft'
                    ? 'bg-neutral-800 text-white border border-white/15 shadow-xs'
                    : 'text-neutral-400 hover:text-white border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-semibold text-white">
                    Draft ({model.draftResolution})
                  </span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-neutral-700/60 text-neutral-300 font-medium">
                    Fast
                  </span>
                </div>
                <div className="text-[11px] text-neutral-400 font-mono">
                  {model.supportsDraftEnhance
                    ? 'Cheap preview • enhance later'
                    : 'Faster preview'}
                </div>
              </button>

              {/* Full Quality (model-dependent) */}
              <button
                type="button"
                onClick={() => onChangeParams({ qualityTier: 'final' })}
                disabled={disabled}
                className={`p-2.5 rounded-lg text-left transition-all ${
                  params.qualityTier === 'final'
                    ? 'bg-neutral-800 text-white border border-white/15 shadow-xs'
                    : 'text-neutral-400 hover:text-white border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-semibold text-white">
                    Full Quality ({RESOLUTION_LABEL[finalResolution]})
                  </span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/15 text-white font-medium">
                    HD
                  </span>
                </div>
                <div className="text-[11px] text-neutral-400 font-mono">
                  Production master
                </div>
              </button>
            </div>

            {/* Output resolution (models that let you choose, e.g. FLUX 3) */}
            {model.resolutionSelectable && params.qualityTier === 'final' && (
              <div className="space-y-1.5 pt-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-300">Output Resolution</span>
                  {ratePerSecond !== null && (
                    <span className="text-[10px] text-neutral-500 font-mono">
                      ~${ratePerSecond.toFixed(2)}/sec
                    </span>
                  )}
                </div>
                <div
                  className="grid gap-1.5 p-1 bg-neutral-900/80 rounded-xl border border-white/[0.08]"
                  style={{
                    gridTemplateColumns: `repeat(${availableResolutions.length}, minmax(0, 1fr))`,
                  }}
                >
                  {availableResolutions.map((res) => {
                    const isActive = finalResolution === res;
                    return (
                      <button
                        key={res}
                        type="button"
                        onClick={() => onChangeParams({ resolution: res })}
                        disabled={disabled}
                        className={`py-1.5 rounded-lg text-xs font-mono transition-all ${
                          isActive
                            ? 'bg-neutral-800 text-white font-semibold shadow-xs'
                            : 'text-neutral-400 hover:text-white'
                        }`}
                        title={res}
                      >
                        {RESOLUTION_LABEL[res]}
                      </button>
                    );
                  })}
                </div>
                {availableResolutions.length < model.resolutions.length && (
                  <p className="text-[10px] text-neutral-500 leading-relaxed">
                    Some resolutions aren’t offered for this workflow.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Advanced Controls Accordion */}
        <div className="pt-2 border-t border-white/[0.08]">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-between py-2 text-xs font-medium text-neutral-400 hover:text-white transition-colors"
            aria-expanded={showAdvanced}
          >
            <span className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" />
              Advanced Parameters
            </span>
            <span>
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </span>
          </button>

          {showAdvanced && (
            <div className="mt-2 p-3.5 bg-neutral-900/60 border border-white/[0.08] rounded-xl space-y-4 text-xs">
              {/* Content filter strictness (FLUX 3 safety_tolerance) */}
              {model.supportsSafetyTolerance && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-300">Content Filter Strictness</span>
                    <span className="font-mono text-white text-[11px]">
                      {safetyTolerance}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="4"
                    step="1"
                    value={safetyTolerance}
                    disabled={disabled}
                    onChange={(e) =>
                      onChangeParams({ safetyTolerance: parseInt(e.target.value, 10) })
                    }
                    className="w-full cursor-pointer"
                    aria-label="Content filter strictness"
                  />
                  <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                    <span>Strictest (0)</span>
                    <span>Most permissive (4)</span>
                  </div>
                  <p className="text-[10px] text-neutral-500 leading-relaxed">
                    Default is 2. Higher values let more through the model’s content
                    filter; the provider still enforces its own usage policy.
                  </p>
                </div>
              )}

              {/* Seedance-style controls (not part of FLUX 3's API) */}
              {model.family !== 'flux-3' && (
              <>
              {/* Guidance Scale */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-300">Prompt Adherence</span>
                  <span className="font-mono text-white text-[11px]">{params.guidanceScale.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="1.0"
                  max="8.0"
                  step="0.1"
                  value={params.guidanceScale}
                  disabled={disabled}
                  onChange={(e) =>
                    onChangeParams({ guidanceScale: parseFloat(e.target.value) })
                  }
                  className="w-full cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                  <span>Natural Motion (1.0)</span>
                  <span>Strict (8.0)</span>
                </div>
              </div>

              {/* Transformation Strength */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-300">Transformation Strength</span>
                  <span className="font-mono text-white text-[11px]">{params.transformationStrength.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={params.transformationStrength}
                  disabled={disabled}
                  onChange={(e) =>
                    onChangeParams({ transformationStrength: parseFloat(e.target.value) })
                  }
                  className="w-full cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                  <span>Preserve Pixels</span>
                  <span>Full Reimagine</span>
                </div>
              </div>

              {/* Inference Steps */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-300">Inference Steps</span>
                  <span className="font-mono text-white text-[11px]">{params.inferenceSteps}</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="50"
                  step="1"
                  value={params.inferenceSteps}
                  disabled={disabled}
                  onChange={(e) =>
                    onChangeParams({ inferenceSteps: parseInt(e.target.value, 10) })
                  }
                  className="w-full cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                  <span>Fast (15)</span>
                  <span>High Detail (50)</span>
                </div>
              </div>

              </>
              )}

              {/* Seed (FLUX 3's API has no seed input) */}
              {model.supportsSeed && (
              <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-300">Generation Seed</span>
                  <button
                    type="button"
                    onClick={handleRandomizeSeed}
                    disabled={disabled}
                    className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 transition-colors"
                  >
                    <Dices className="w-3 h-3" />
                    <span>Randomize</span>
                  </button>
                </div>
                <input
                  type="number"
                  value={params.seed}
                  disabled={disabled}
                  onChange={(e) =>
                    onChangeParams({ seed: Math.max(0, parseInt(e.target.value, 10) || 0) })
                  }
                  className="w-full bg-neutral-950 border border-white/10 rounded-lg px-2.5 py-1 text-xs font-mono text-white focus:outline-none focus:border-white/30"
                />
              </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
