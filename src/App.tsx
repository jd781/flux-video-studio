import React, { useState, useRef, useEffect } from 'react';
import {
  DEFAULT_FLUX_PARAMS,
  INITIAL_TAKES,
  calculateCost,
  generateRandomSeed,
  prepareExtendVideoState,
} from './utils/fluxVideoUtils';
import {
  generateVideo,
  upscaleVideo,
  enhanceDraft,
  GenerationError,
} from './lib/falClient';
import { flux3EnhanceCost } from './utils/flux3';
import { getModel } from './utils/modelCatalog';
import { captureVideoThumbnail } from './utils/videoThumbnail';
import { validateGeneration } from './utils/validateGeneration';
import { GenerationNotice, GenerationNoticeData } from './components/GenerationNotice';
import {
  createNewProject,
  duplicateProject,
  LAST_ACTIVE_PROJECT_KEY,
} from './utils/projectUtils';
import {
  fetchSessions,
  fetchTeamMembers,
  createSessionRemote,
  updateSessionRemote,
  setSessionVisibilityRemote,
  deleteSessionRemote,
} from './lib/sessionsApi';
import {
  AspectRatio,
  DurationSeconds,
  FluxGenerationParams,
  GenerationQueueStatus,
  UpscaleState,
  BatchUpscaleState,
  VideoTake,
  FluxProject,
  SessionVisibility,
  TeamMember,
} from './types/flux';
import { Header } from './components/Header';
import { ControlsPanel } from './components/ControlsPanel';
import { StagePreview } from './components/StagePreview';
import { GenerationProgress } from './components/GenerationProgress';
import { ActionBar } from './components/ActionBar';
import { UpscaleBanner } from './components/UpscaleBanner';
import { GenerationsGallery } from './components/GenerationsGallery';
import { ProjectSessionModal, SessionModalView } from './components/ProjectSessionModal';
import { UsageModal } from './components/UsageModal';
import { AuthUser } from './lib/auth';
import { CheckCircle2, AlertCircle, History, Sparkles, Layers, Grid, ChevronDown, ChevronUp } from 'lucide-react';

interface AppProps {
  currentUser: AuthUser;
  /** Opens the Production Pipeline (storyboards, brand bible, call sheets). */
  onSwitchToPipeline?: () => void;
}

export default function App({ currentUser, onSwitchToPipeline }: AppProps) {
  // Server-backed sessions (studios). Loaded from the API on mount.
  const [projects, setProjects] = useState<FluxProject[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState<boolean>(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(LAST_ACTIVE_PROJECT_KEY) || '';
    }
    return '';
  });

  // App Startup Greeting & Saved Sessions Modal
  const [isSessionModalOpen, setIsSessionModalOpen] = useState<boolean>(true);
  const [sessionModalView, setSessionModalView] = useState<SessionModalView>('welcome');

  // Active studio working state. Starts from defaults; hydrated when a session
  // is opened or loaded from the server.
  const [params, setParams] = useState<FluxGenerationParams>(DEFAULT_FLUX_PARAMS);
  const [takes, setTakes] = useState<VideoTake[]>([]);
  const [currentTake, setCurrentTake] = useState<VideoTake | null>(null);

  const [currentView, setCurrentView] = useState<'studio' | 'gallery'>('studio');
  // Persistent pre-flight / failure card (stays until dismissed, unlike a toast).
  const [notice, setNotice] = useState<GenerationNoticeData | null>(null);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'info' | 'error';
  } | null>(null);

  const [upscaleState, setUpscaleState] = useState<UpscaleState>({
    isUpscaling: false,
    takeId: null,
    targetResolution: '1080p',
    progressPercent: 0,
    stepMessage: '',
  });

  const [batchUpscaleState, setBatchUpscaleState] = useState<BatchUpscaleState>({
    isProcessing: false,
    currentIndex: 0,
    totalCount: 0,
    targetResolution: '1080p',
    activeTakeId: null,
    completedCount: 0,
  });

  const [queueStatus, setQueueStatus] = useState<GenerationQueueStatus>({
    isGenerating: false,
    progressPercent: 0,
    currentStep: 0,
    totalSteps: DEFAULT_FLUX_PARAMS.inferenceSteps,
    phase: 'idle',
    statusMessage: 'Ready',
    etaSeconds: 0,
  });

  // Holds the AbortController for an in-flight fal.ai generation so it can be cancelled.
  const generationAbortRef = useRef<AbortController | null>(null);

  // Clear toast after timeout
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const showToast = (text: string, type: 'success' | 'info' | 'error' = 'info') => {
    setToastMessage({ text, type });
  };

  const activeProject =
    projects.find((p) => p.id === currentProjectId) || projects[0];

  // Load this user's sessions (owned + team + shared-with-them) + team members.
  useEffect(() => {
    let active = true;
    Promise.all([fetchSessions(), fetchTeamMembers()])
      .then(([sessions, members]) => {
        if (!active) return;
        setTeamMembers(members);
        setProjects(sessions);
        // Pick the last-active session if still visible, else the newest.
        const lastId =
          typeof window !== 'undefined'
            ? localStorage.getItem(LAST_ACTIVE_PROJECT_KEY)
            : null;
        const target =
          sessions.find((s) => s.id === lastId) || sessions[0] || null;
        if (target) {
          setCurrentProjectId(target.id);
          setParams(target.params);
          setTakes(target.takes);
          setCurrentTake(
            target.takes.find((t) => t.id === target.currentTakeId) ||
              target.takes[0] ||
              null
          );
        }
        setSessionsLoaded(true);
      })
      .catch((err) => {
        console.error('[sessions] load failed:', err);
        setSessionsLoaded(true);
        showToast('Could not load your sessions.', 'error');
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-Save Effect: debounced persist of the active session to the server.
  const isInitialMount = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (!sessionsLoaded || !currentProjectId) return;

    // Update local copy immediately for snappy UI.
    const thumbnailUrl =
      takes.length > 0 ? takes[0].posterUrl : params.startFrameUrl || undefined;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === currentProjectId
          ? {
              ...p,
              params,
              takes,
              currentTakeId: currentTake?.id || null,
              thumbnailUrl,
              updatedAt: Date.now(),
            }
          : p
      )
    );

    // Debounce the network save (generations mutate state rapidly).
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const current = projectsRef.current.find((p) => p.id === currentProjectId);
      if (!current) return;
      updateSessionRemote({
        ...current,
        params,
        takes,
        currentTakeId: currentTake?.id || null,
        thumbnailUrl,
      }).catch((err) => console.error('[sessions] save failed:', err));
    }, 800);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, takes, currentTake, currentProjectId, sessionsLoaded]);

  // Keep a ref of the latest projects for the debounced save closure.
  const projectsRef = useRef<FluxProject[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // Project Management Actions
  const handleOpenProject = (projectId: string) => {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;

    setCurrentProjectId(target.id);
    setParams(target.params);
    setTakes(target.takes);
    const foundTake =
      target.takes.find((t) => t.id === target.currentTakeId) || target.takes[0] || null;
    setCurrentTake(foundTake);

    if (typeof window !== 'undefined') {
      localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, target.id);
    }
    showToast(`Loaded session "${target.title}"`, 'success');
  };

  const handleCreateProject = async (
    title: string,
    template?: Partial<FluxGenerationParams>,
    folder?: string
  ) => {
    const draft = createNewProject(title, template, folder);
    // Mark as owned/private locally; server is the source of truth.
    const local: FluxProject = {
      ...draft,
      ownerEmail: currentUser.email,
      visibility: 'private',
      sharedWith: [],
      isOwner: true,
    };
    setProjects((prev) => [local, ...prev]);
    setCurrentProjectId(local.id);
    setParams(local.params);
    setTakes(local.takes);
    setCurrentTake(null);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, local.id);
    }
    setCurrentView('studio');

    try {
      const saved = await createSessionRemote(local);
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      showToast(`Created session "${saved.title}"`, 'success');
    } catch (err) {
      console.error('[sessions] create failed:', err);
      showToast('Could not create session on the server.', 'error');
    }
  };

  const handleDuplicateProject = async (project: FluxProject) => {
    const copy = duplicateProject(project);
    const local: FluxProject = {
      ...copy,
      ownerEmail: currentUser.email,
      visibility: 'private',
      sharedWith: [],
      isOwner: true,
    };
    setProjects((prev) => [local, ...prev]);
    try {
      const saved = await createSessionRemote(local);
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      showToast(`Duplicated "${project.title}"`, 'success');
    } catch (err) {
      console.error('[sessions] duplicate failed:', err);
      showToast('Could not duplicate session.', 'error');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const target = projects.find((p) => p.id === projectId);
    if (target && target.isOwner === false) {
      showToast('Only the owner can delete this session.', 'error');
      return;
    }
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (currentProjectId === projectId && remaining[0]) {
      handleOpenProject(remaining[0].id);
    } else if (remaining.length === 0) {
      setCurrentProjectId('');
      setTakes([]);
      setCurrentTake(null);
    }
    try {
      await deleteSessionRemote(projectId);
      showToast('Session deleted.', 'info');
    } catch (err) {
      console.error('[sessions] delete failed:', err);
      showToast('Could not delete session.', 'error');
    }
  };

  const handleRenameProject = (projectId: string, newTitle: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, title: newTitle, updatedAt: Date.now() } : p
      )
    );
    const target = projects.find((p) => p.id === projectId);
    if (target) {
      updateSessionRemote({ ...target, title: newTitle }).catch((err) =>
        console.error('[sessions] rename failed:', err)
      );
    }
    showToast(`Renamed to "${newTitle}"`, 'success');
  };

  // Change a session's visibility / sharing (owner only).
  const handleChangeVisibility = async (
    projectId: string,
    visibility: SessionVisibility,
    sharedWith: string[]
  ) => {
    try {
      const saved = await setSessionVisibilityRemote(
        projectId,
        visibility,
        sharedWith
      );
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      const label =
        visibility === 'private'
          ? 'Private'
          : visibility === 'team'
          ? 'Shared with the team'
          : `Shared with ${sharedWith.length} ${
              sharedWith.length === 1 ? 'person' : 'people'
            }`;
      showToast(`Visibility: ${label}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update sharing.';
      showToast(msg, 'error');
    }
  };

  const handleUpdateParams = (newParams: Partial<FluxGenerationParams>) => {
    setParams((prev) => ({ ...prev, ...newParams }));
  };

  const handleLoadPreset = (preset: {
    prompt: string;
    aspectRatio: AspectRatio;
    duration: DurationSeconds;
    title: string;
  }) => {
    setParams((prev) => ({
      ...prev,
      prompt: preset.prompt,
      aspectRatio: preset.aspectRatio,
      duration: preset.duration,
    }));
    showToast(`Loaded "${preset.title}" preset`, 'info');
  };

  // Cost calculation (estimate; server records the authoritative figure)
  const currentCost = calculateCost(
    params.modelId,
    params.duration,
    params.qualityTier,
    {
      workflowMode: params.workflowMode,
      resolution: params.resolution,
      nativeAudio: params.nativeAudio,
      // Only the clips this workflow actually sends count (stale slots from
      // another mode are ignored).
      hasVideoInput:
        (['video_extend', 'video_edit', 'video_reframe'].includes(params.workflowMode) &&
          Boolean(params.sourceVideoUrl)) ||
        (params.workflowMode === 'reference_to_video' &&
          (params.referenceVideos?.length ?? 0) > 0),
    }
  );

  // Captures a real first-frame thumbnail from a video and patches the take's
  // posterUrl (both in the takes list and currentTake if selected).
  const captureAndApplyThumbnail = async (takeId: string, videoUrl: string) => {
    const thumb = await captureVideoThumbnail(videoUrl);
    if (!thumb) return;
    setTakes((prev) =>
      prev.map((t) => (t.id === takeId ? { ...t, posterUrl: thumb } : t))
    );
    setCurrentTake((prev) =>
      prev && prev.id === takeId ? { ...prev, posterUrl: thumb } : prev
    );
  };

  // A pre-flight notice is stale as soon as the user changes anything.
  useEffect(() => {
    setNotice((n) => (n && n.kind === 'preflight' ? null : n));
  }, [params]);

  // Show a failure with its reason and suggested fix (persistent card + short toast).
  const reportFailure = (err: unknown, what: 'Generation' | 'Upscale' | 'Enhance') => {
    if (err instanceof GenerationError) {
      setNotice({
        kind: 'failed',
        title: `${what} failed`,
        message: err.message,
        hint: err.hint,
        detail: err.detail,
      });
      showToast(`${what} failed: ${err.message}`, 'error');
    } else {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setNotice({
        kind: 'failed',
        title: `${what} failed`,
        message,
        hint: 'Try again. If it keeps happening, contact the admin.',
      });
      showToast(`${what} failed: ${message}`, 'error');
    }
  };

  // Generate Video Flow — real fal.ai Seedance call.
  // NOTE: this is bound to a button's onClick, which passes the click event as the
  // first argument, so the "proceed anyway" flag must be an explicit named option.
  const handleGenerate = async (opts?: { ignoreWarnings?: boolean }) => {
    if (queueStatus.isGenerating) return;

    // Pre-flight: catch missing/invalid inputs BEFORE anything is submitted.
    const check = validateGeneration(params);
    if (
      check.errors.length > 0 ||
      (check.warnings.length > 0 && opts?.ignoreWarnings !== true)
    ) {
      setNotice({
        kind: 'preflight',
        errors: check.errors,
        warnings: check.warnings,
      });
      return;
    }
    setNotice(null);

    // Ensure there's an active session to attach the generation to.
    if (!currentProjectId) {
      await handleCreateProject('Untitled Session');
    }

    const totalSteps = params.inferenceSteps;
    const abortController = new AbortController();
    generationAbortRef.current = abortController;

    setQueueStatus({
      isGenerating: true,
      progressPercent: 2,
      currentStep: 0,
      totalSteps,
      phase: 'queued',
      statusMessage: 'Uploading media & submitting to fal.ai...',
      etaSeconds: Math.max(10, params.duration * 3),
    });

    try {
      const result = await generateVideo(
        params,
        (p) => {
          setQueueStatus((prev) => ({
            ...prev,
            isGenerating: true,
            progressPercent: p.percent,
            currentStep: Math.round((p.percent / 100) * totalSteps),
            totalSteps,
            phase: p.phase,
            statusMessage: p.message,
            etaSeconds: Math.max(0, Math.round(((100 - p.percent) / 100) * params.duration * 3)),
          }));
        },
        abortController.signal
      );

      const posterUrl =
        params.startFrameUrl ||
        (params.keyframes.length > 0
          ? params.keyframes[0].imageUrl
          : INITIAL_TAKES[0].posterUrl);

      const isFlux3Draft =
        params.modelId === 'flux-3' && params.qualityTier === 'draft';

      const newTake: VideoTake = {
        id: `take-${Date.now()}`,
        createdAt: Date.now(),
        title: `Take ${takes.length + 1} • ${result.resolution}${
          isFlux3Draft ? ' Draft' : ''
        } (${params.workflowMode.replace(/_/g, ' ').toUpperCase()})`,
        videoUrl: result.videoUrl,
        posterUrl,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        qualityTier: params.qualityTier,
        resolution: result.resolution,
        prompt: params.prompt,
        params: { ...params, seed: result.seed },
        // Some models always (or never) produce audio regardless of the toggle.
        hasAudio:
          getModel(params.modelId).audio === 'toggle'
            ? params.nativeAudio
            : getModel(params.modelId).audio === 'always',
        costEstimate: currentCost.dollars,
        // FLUX 3 drafts keep their cache so they can be enhanced later.
        draftCacheUrl: result.draftCacheUrl ?? undefined,
      };

      setTakes((prev) => [newTake, ...prev]);
      setCurrentTake(newTake);

      // Capture a real thumbnail from the generated video's first frame and
      // patch it in once ready (falls back to the placeholder poster on failure).
      void captureAndApplyThumbnail(newTake.id, newTake.videoUrl);

      setQueueStatus({
        isGenerating: false,
        progressPercent: 100,
        currentStep: totalSteps,
        totalSteps,
        phase: 'completed',
        statusMessage: 'Completed',
        etaSeconds: 0,
      });

      showToast(`Video generated successfully with ${getModel(params.modelId).label}!`, 'success');
    } catch (err) {
      const aborted =
        abortController.signal.aborted ||
        (err instanceof Error && /abort/i.test(err.message));
      setQueueStatus({
        isGenerating: false,
        progressPercent: 0,
        currentStep: 0,
        totalSteps,
        phase: aborted ? 'idle' : 'failed',
        statusMessage: aborted ? 'Generation cancelled' : 'Generation failed',
        etaSeconds: 0,
      });
      if (!aborted) {
        reportFailure(err, 'Generation');
        console.error('[fal generate] error:', err);
      }
    } finally {
      generationAbortRef.current = null;
    }
  };

  // Upscale Workflow — real fal.ai Topaz video upscaler.
  const handleUpscale = async (targetResolution: '1080p' | '4K') => {
    if (!currentTake || upscaleState.isUpscaling) return;

    const sourceTake = currentTake;

    setUpscaleState({
      isUpscaling: true,
      takeId: sourceTake.id,
      targetResolution,
      progressPercent: 5,
      stepMessage: 'Submitting to fal-ai/topaz video upscaler...',
    });

    try {
      const { videoUrl } = await upscaleVideo(
        sourceTake.videoUrl,
        targetResolution,
        (p) => {
          setUpscaleState((prev) => ({
            ...prev,
            progressPercent: p.percent,
            stepMessage: p.message,
          }));
        }
      );

      const upscaledTake: VideoTake = {
        ...sourceTake,
        id: `take-upscaled-${Date.now()}`,
        createdAt: Date.now(),
        title: `${sourceTake.title.replace(/\[.*\]/, '').trim()} [${targetResolution}]`,
        videoUrl,
        qualityTier: 'final',
        resolution: targetResolution,
        upscaledFromId: sourceTake.id,
        upscaleDetails: {
          model: 'fal-ai/topaz/upscale/video',
          targetResolution,
          upscaledAt: Date.now(),
        },
      };

      // Keep the original take in history; add the upscaled one and select it.
      setTakes((prev) => [upscaledTake, ...prev]);
      setCurrentTake(upscaledTake);
      void captureAndApplyThumbnail(upscaledTake.id, upscaledTake.videoUrl);
      showToast(`Upscaled to ${targetResolution} via fal-ai/topaz!`, 'success');
    } catch (err) {
      reportFailure(err, 'Upscale');
      console.error('[fal upscale] error:', err);
    } finally {
      setUpscaleState({
        isUpscaling: false,
        takeId: null,
        targetResolution: '1080p',
        progressPercent: 0,
        stepMessage: '',
      });
    }
  };

  // FLUX 3 Draft Enhance: re-render the approved draft at full quality from its
  // cache (same motion, no re-planning). Reuses the upscale progress state.
  const handleEnhance = async () => {
    const source = currentTake;
    if (!source?.draftCacheUrl || upscaleState.isUpscaling) return;

    setUpscaleState({
      isUpscaling: true,
      takeId: source.id,
      targetResolution: '1080p',
      progressPercent: 5,
      stepMessage: 'Enhancing draft to full-quality 1080p...',
    });

    try {
      const { videoUrl, costUsd } = await enhanceDraft(
        source.draftCacheUrl,
        source.duration,
        source.params.safetyTolerance,
        (p) => {
          setUpscaleState((prev) => ({
            ...prev,
            progressPercent: p.percent,
            stepMessage: p.message,
          }));
        }
      );

      const enhanced: VideoTake = {
        ...source,
        id: `take-enhanced-${Date.now()}`,
        createdAt: Date.now(),
        title: `${source.title.replace(' Draft', '')} [1080p Enhanced]`,
        videoUrl,
        draftCacheUrl: undefined,
        qualityTier: 'final',
        resolution: '1080p',
        params: { ...source.params, qualityTier: 'final' },
        costEstimate: costUsd,
        upscaledFromId: source.id,
        upscaleDetails: {
          model: 'blackforestlabs/flux-3/draft-enhance',
          targetResolution: '1080p',
          upscaledAt: Date.now(),
        },
      };

      // Keep the draft in history; add the enhanced take and select it.
      setTakes((prev) => [enhanced, ...prev]);
      setCurrentTake(enhanced);
      void captureAndApplyThumbnail(enhanced.id, enhanced.videoUrl);
      showToast('Draft enhanced to full-quality 1080p!', 'success');
    } catch (err) {
      reportFailure(err, 'Enhance');
      console.error('[fal enhance] error:', err);
    } finally {
      setUpscaleState({
        isUpscaling: false,
        takeId: null,
        targetResolution: '1080p',
        progressPercent: 0,
        stepMessage: '',
      });
    }
  };

  const handleCompareWithDraft = (draftId: string) => {
    const draft = takes.find((t) => t.id === draftId);
    if (draft) {
      setCurrentTake(draft);
      showToast('Switched to original 480p draft for comparison', 'info');
    }
  };

  // Find original draft if currentTake is upscaled
  const originalDraftTake = currentTake?.upscaledFromId
    ? takes.find((t) => t.id === currentTake.upscaledFromId) || null
    : null;

  // Extend Video
  const handleExtend = () => {
    if (!currentTake) return;
    const extendState = prepareExtendVideoState(currentTake);
    setParams((prev) => ({
      ...prev,
      workflowMode: extendState.workflowMode,
      startFrameUrl: extendState.startFrameUrl,
      sourceVideoUrl: extendState.sourceVideoUrl,
      sourceVideoName: extendState.sourceVideoName,
      prompt: extendState.prompt,
    }));
    showToast('Loaded final keyframe into Start slot for continuous extension', 'info');
  };

  // Variations Flow
  const handleVariations = () => {
    const newSeed = generateRandomSeed();
    handleUpdateParams({ seed: newSeed });
    showToast(`New variation seed generated: #${newSeed}`, 'info');
    setTimeout(() => {
      handleGenerate();
    }, 200);
  };

  // Direct Download MP4
  const handleDownload = () => {
    if (!currentTake) return;
    const link = document.createElement('a');
    link.href = currentTake.videoUrl;
    link.download = `52VideoStudio_Take_${currentTake.id}_${currentTake.aspectRatio.replace(':', 'x')}.mp4`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Downloading ${currentTake.title} (.mp4)`, 'success');
  };

  // Cancel generation — aborts the in-flight fal.ai request.
  const handleCancel = () => {
    if (generationAbortRef.current) {
      generationAbortRef.current.abort();
    }
    setQueueStatus({
      isGenerating: false,
      progressPercent: 0,
      currentStep: 0,
      totalSteps: params.inferenceSteps,
      phase: 'idle',
      statusMessage: 'Generation cancelled',
      etaSeconds: 0,
    });
    showToast('Generation cancelled', 'info');
  };

  // Toggle Favorite
  const handleToggleFavorite = (takeId: string) => {
    let nowFavorite = false;
    setTakes((prev) =>
      prev.map((take) => {
        if (take.id === takeId) {
          nowFavorite = !take.isFavorite;
          return { ...take, isFavorite: nowFavorite };
        }
        return take;
      })
    );
    if (currentTake?.id === takeId) {
      setCurrentTake((prev) => (prev ? { ...prev, isFavorite: !prev.isFavorite } : null));
    }
    showToast(
      nowFavorite ? 'Marked take as favorite (★)' : 'Removed take from favorites',
      'info'
    );
  };

  // Batch Upscale Queue Workflow — real fal.ai Topaz upscaler, one take at a time.
  const handleBatchUpscale = async (
    takeIds: string[],
    targetResolution: '1080p' | '4K'
  ) => {
    if (takeIds.length === 0 || batchUpscaleState.isProcessing) return;

    setBatchUpscaleState({
      isProcessing: true,
      currentIndex: 1,
      totalCount: takeIds.length,
      targetResolution,
      activeTakeId: takeIds[0],
      completedCount: 0,
    });

    showToast(
      `Starting batch upscale of ${takeIds.length} videos to ${targetResolution}...`,
      'info'
    );

    let completed = 0;
    let failed = 0;
    for (let i = 0; i < takeIds.length; i++) {
      const targetId = takeIds[i];
      setBatchUpscaleState((prev) => ({
        ...prev,
        currentIndex: i + 1,
        activeTakeId: targetId,
      }));

      const targetTake = takes.find((t) => t.id === targetId);
      if (targetTake) {
        try {
          const { videoUrl } = await upscaleVideo(targetTake.videoUrl, targetResolution);
          completed += 1;

          const upscaleDetails = {
            model: 'fal-ai/topaz/upscale/video',
            targetResolution,
            upscaledAt: Date.now(),
          };

          // Replace take in place: update resolution, badge, URL, and upscale details
          setTakes((prev) =>
            prev.map((t) =>
              t.id === targetId
                ? {
                    ...t,
                    title: `${t.title.replace(/\[.*\]/, '').trim()} [${targetResolution}]`,
                    resolution: targetResolution,
                    qualityTier: 'final',
                    videoUrl,
                    upscaleDetails,
                  }
                : t
            )
          );

          if (currentTake?.id === targetId) {
            setCurrentTake((prev) =>
              prev
                ? {
                    ...prev,
                    title: `${prev.title.replace(/\[.*\]/, '').trim()} [${targetResolution}]`,
                    resolution: targetResolution,
                    qualityTier: 'final',
                    videoUrl,
                    upscaleDetails,
                  }
                : null
            );
          }

          setBatchUpscaleState((prev) => ({
            ...prev,
            completedCount: completed,
          }));
        } catch (err) {
          failed += 1;
          console.error(`Failed to upscale ${targetId}`, err);
        }
      }
    }

    setBatchUpscaleState({
      isProcessing: false,
      currentIndex: 0,
      totalCount: 0,
      targetResolution: '1080p',
      activeTakeId: null,
      completedCount: completed,
    });

    showToast(
      failed > 0
        ? `Batch upscale finished: ${completed} succeeded, ${failed} failed.`
        : `Batch upscale complete! ${completed} videos converted to ${targetResolution}.`,
      failed > 0 ? 'info' : 'success'
    );
  };

  // Delete take
  const handleDeleteTake = (takeId: string) => {
    setTakes((prev) => prev.filter((t) => t.id !== takeId));
    if (currentTake?.id === takeId) {
      setCurrentTake(takes.find((t) => t.id !== takeId) || null);
    }
    showToast('Take deleted', 'info');
  };

  const [mobileTab, setMobileTab] = useState<'controls' | 'stage'>('controls');
  const [isHistoryCollapsed, setIsHistoryCollapsed] = useState<boolean>(false);
  const [isUsageOpen, setIsUsageOpen] = useState<boolean>(false);

  return (
    <div className="h-screen bg-[#09090b] text-neutral-100 flex flex-col select-none antialiased overflow-hidden">
      {/* Studio Header with View Switcher & Session Manager */}
      <Header
        onLoadPreset={handleLoadPreset}
        currentUser={currentUser}
        onOpenPipeline={onSwitchToPipeline}
        onOpenUsage={() => setIsUsageOpen(true)}
        currentView={currentView}
        onChangeView={setCurrentView}
        takesCount={takes.length}
        favoritesCount={takes.filter((t) => t.isFavorite).length}
        activeProject={activeProject}
        allProjects={projects}
        onOpenSessionManager={(v) => {
          setSessionModalView(v);
          setIsSessionModalOpen(true);
        }}
        onSwitchProject={handleOpenProject}
        isAutoSaved={true}
      />

      {/* Main Content Area: Studio View vs Dedicated Gallery View */}
      {currentView === 'gallery' ? (
        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <GenerationsGallery
            takes={takes}
            selectedTakeId={currentTake?.id || null}
            batchUpscaleState={batchUpscaleState}
            onSelectTake={(take) => {
              setCurrentTake(take);
              setCurrentView('studio');
              showToast(`Loaded "${take.title}" in Studio player`, 'info');
            }}
            onToggleFavorite={handleToggleFavorite}
            onBatchUpscale={handleBatchUpscale}
            onDeleteTake={handleDeleteTake}
            compact={false}
          />
        </main>
      ) : (
        <>
          {/* Mobile Tab Switcher */}
          <div className="lg:hidden flex border-b border-white/[0.08] bg-neutral-900/90 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMobileTab('controls')}
              className={`flex-1 py-2.5 text-center transition-colors border-b-2 ${
                mobileTab === 'controls'
                  ? 'text-white border-white bg-white/5 font-semibold'
                  : 'text-neutral-400 border-transparent hover:text-white'
              }`}
            >
              Controls
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('stage')}
              className={`flex-1 py-2.5 text-center transition-colors border-b-2 ${
                mobileTab === 'stage'
                  ? 'text-white border-white bg-white/5 font-semibold'
                  : 'text-neutral-400 border-transparent hover:text-white'
              }`}
            >
              Preview Stage
            </button>
          </div>

          {/* Two-Column Studio Layout */}
          <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden relative">
            {/* Column 1: Controls (Left Panel) */}
            <section
              aria-label="Creative Controls"
              className={`w-full lg:w-[460px] xl:w-[480px] shrink-0 h-full min-h-0 border-b lg:border-b-0 lg:border-r border-white/[0.08] bg-neutral-950 flex flex-col overflow-hidden ${
                mobileTab === 'controls' ? 'flex' : 'hidden lg:flex'
              }`}
            >
              <ControlsPanel
                params={params}
                onChangeParams={handleUpdateParams}
                disabled={queueStatus.isGenerating}
              />
            </section>

            {/* Column 2: Stage & Export (Right Panel) */}
            <section
              aria-label="Preview & Stage"
              className={`flex-1 h-full min-h-0 flex flex-col p-4 sm:p-5 overflow-y-auto space-y-4 bg-neutral-950 ${
                mobileTab === 'stage' ? 'flex' : 'hidden lg:flex'
              }`}
            >
              {/* Pre-flight problems / failure reason (persistent until dismissed) */}
              {notice && (
                <div className="shrink-0">
                  <GenerationNotice
                    notice={notice}
                    onDismiss={() => setNotice(null)}
                    onProceed={() => {
                      setNotice(null);
                      void handleGenerate({ ignoreWarnings: true });
                    }}
                  />
                </div>
              )}

              {/* Real-time Generation Progress Bar */}
              <div className="shrink-0">
                <GenerationProgress status={queueStatus} onCancel={handleCancel} />
              </div>

              {/* Live Video Player Stage — never squeezed by content below it. */}
              <div className="shrink-0 flex flex-col min-h-[420px]">
                <StagePreview
                  currentTake={currentTake}
                  aspectRatio={params.aspectRatio}
                  fps={params.fps}
                  isGenerating={queueStatus.isGenerating}
                />
              </div>

              {/* Video Output & Upscale Bar */}
              <div className="shrink-0">
                <UpscaleBanner
                  currentTake={currentTake}
                  upscaleState={upscaleState}
                  onUpscale={handleUpscale}
                  onEnhance={handleEnhance}
                  enhanceCostUsd={
                    currentTake?.draftCacheUrl
                      ? flux3EnhanceCost(currentTake.duration)
                      : undefined
                  }
                  onCompareWithDraft={handleCompareWithDraft}
                  originalDraftTake={originalDraftTake}
                />
              </div>

              {/* Action Bar */}
              <div className="shrink-0">
                <ActionBar
                  onGenerate={handleGenerate}
                  onExtend={handleExtend}
                  onDownload={handleDownload}
                  costEstimate={currentCost}
                  isGenerating={queueStatus.isGenerating || upscaleState.isUpscaling}
                  canExtend={Boolean(currentTake)}
                  canDownload={Boolean(currentTake)}
                />
              </div>

              {/* Docked Generations Gallery Section — collapsible */}
              <div className="shrink-0 border border-white/[0.08] rounded-2xl overflow-hidden bg-neutral-900/60 shadow-lg">
                <div className="px-4 py-3 bg-neutral-900/80 border-b border-white/[0.08] flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => setIsHistoryCollapsed((v) => !v)}
                    className="flex items-center gap-2 text-white hover:text-neutral-200 transition-colors"
                    aria-expanded={!isHistoryCollapsed}
                    aria-controls="generations-history-panel"
                    title={isHistoryCollapsed ? 'Expand history' : 'Collapse history'}
                  >
                    {isHistoryCollapsed ? (
                      <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                    ) : (
                      <ChevronUp className="w-3.5 h-3.5 text-neutral-400" />
                    )}
                    <span className="font-semibold">
                      Generations History ({takes.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentView('gallery')}
                    className="text-[11px] font-medium text-neutral-400 hover:text-white flex items-center gap-1 transition-colors"
                  >
                    <span>Full Screen Gallery</span>
                    <Grid className="w-3 h-3" />
                  </button>
                </div>
                {!isHistoryCollapsed && (
                  <div
                    id="generations-history-panel"
                    className="max-h-[440px] overflow-y-auto"
                  >
                    <GenerationsGallery
                      takes={takes}
                      selectedTakeId={currentTake?.id || null}
                      batchUpscaleState={batchUpscaleState}
                      onSelectTake={setCurrentTake}
                      onToggleFavorite={handleToggleFavorite}
                      onBatchUpscale={handleBatchUpscale}
                      onDeleteTake={handleDeleteTake}
                      compact={true}
                    />
                  </div>
                )}
              </div>
            </section>
          </main>
        </>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl text-xs font-medium animate-in fade-in slide-in-from-bottom-2">
          {toastMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : (
            <AlertCircle className="w-4 h-4 text-orange-400" />
          )}
          <span className="text-zinc-100">{toastMessage.text}</span>
        </div>
      )}

      {/* My Usage Modal */}
      <UsageModal isOpen={isUsageOpen} onClose={() => setIsUsageOpen(false)} />

      {/* App Startup Greeting & Saved Sessions Library Modal */}
      <ProjectSessionModal
        isOpen={isSessionModalOpen}
        initialView={sessionModalView}
        projects={projects}
        currentProjectId={currentProjectId}
        onClose={() => setIsSessionModalOpen(false)}
        onOpenProject={(id) => {
          handleOpenProject(id);
          setIsSessionModalOpen(false);
        }}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onRenameProject={handleRenameProject}
        currentUserEmail={currentUser.email}
        teamMembers={teamMembers}
        onChangeVisibility={handleChangeVisibility}
      />
    </div>
  );
}
