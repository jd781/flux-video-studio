import { FluxGenerationParams } from '../types/flux';
import { getAvailableAspectRatios, getModel } from './modelCatalog';
import { keyframeFrameIndex } from './flux3';

/**
 * Pre-flight checks that run BEFORE a generation is submitted, so problems are
 * caught on the user's screen instead of becoming a failed (wasted) request.
 *
 *  - errors   : the request cannot succeed as configured. Submission is blocked.
 *  - warnings : the request will probably be rejected, or is likely not what
 *               the user intends. The user can choose to generate anyway.
 */

export interface PreflightIssue {
  id: string;
  /** What's wrong. */
  message: string;
  /** How to fix it. */
  fix?: string;
}

export interface PreflightResult {
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
}

const IMAGE_MAX_MB = 30;

/** Approximate decoded size of a data: URL in MB (0 for hosted URLs we can't size). */
function approxMB(url: string): number {
  if (!url.startsWith('data:')) return 0;
  const comma = url.indexOf(',');
  const b64Len = url.length - (comma + 1);
  return (b64Len * 3) / 4 / (1024 * 1024);
}

/**
 * Common profanity that Seedance's moderation tends to reject. This is a
 * heuristic only (it can't see what the model will actually generate), so it
 * produces a warning, never a hard block.
 */
const PROFANITY =
  /\b(f+u+c+k\w*|sh[i1]t\w*|bullshit|bitch\w*|asshole\w*|bastard\w*|cunt\w*|dickhead\w*|motherf\w+|pussy|slut\w*|whore\w*)\b/gi;

export function findProfanity(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PROFANITY)) found.add(m[0].toLowerCase());
  return [...found];
}

/** @ImageN / @VideoN tags that point past the media actually attached. */
function badTags(prompt: string, imageCount: number, videoCount: number): string[] {
  const bad: string[] = [];
  for (const m of prompt.matchAll(/@image(\d+)/gi)) {
    const n = Number(m[1]);
    if (n < 1 || n > imageCount) bad.push(`@Image${n}`);
  }
  for (const m of prompt.matchAll(/@video(\d+)/gi)) {
    const n = Number(m[1]);
    if (n < 1 || n > videoCount) bad.push(`@Video${n}`);
  }
  return [...new Set(bad)];
}

export function validateGeneration(params: FluxGenerationParams): PreflightResult {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  const model = getModel(params.modelId);
  const mode = params.workflowMode;
  const prompt = (params.prompt ?? '').trim();
  const images = (params.referenceImages ?? []).filter(Boolean);
  const videos = (params.referenceVideos ?? []).filter(Boolean);

  const checkSize = (label: string, urls: string[], maxMB: number) => {
    urls.forEach((u, i) => {
      if (approxMB(u) > maxMB) {
        errors.push({
          id: `size-${label}-${i}`,
          message: `${label}${urls.length > 1 ? ` #${i + 1}` : ''} is larger than ${maxMB} MB.`,
          fix: 'Use a smaller or more compressed file.',
        });
      }
    });
  };

  // Mode must exist on the selected model.
  if (!model.workflowModes.includes(mode)) {
    errors.push({
      id: 'mode',
      message: `This workflow isn’t available on ${model.label}.`,
      fix: 'Pick a different workflow mode or switch models.',
    });
  }

  // Aspect ratio must be one the model accepts (e.g. after switching models).
  if (!getAvailableAspectRatios(params.modelId, mode).includes(params.aspectRatio)) {
    errors.push({
      id: 'aspect',
      message: `${model.label} doesn’t support the ${params.aspectRatio} aspect ratio.`,
      fix: 'Pick one of the aspect ratios shown for this model.',
    });
  }

  // Prompt
  if (!prompt) {
    errors.push({
      id: 'prompt',
      message: 'The prompt is empty.',
      fix: 'Describe the scene, motion, and camera you want.',
    });
  }

  // Mode-specific media requirements
  switch (mode) {
    case 'image_to_video':
      if (!params.startFrameUrl) {
        errors.push({
          id: 'start',
          message: 'Image to Video needs an image.',
          fix: 'Upload the image you want to animate.',
        });
      }
      break;

    case 'first_last_frame':
      if (!params.startFrameUrl) {
        errors.push({
          id: 'start',
          message: 'Keyframe Pair needs a start frame.',
          fix: 'Upload the opening image.',
        });
      }
      if (!params.endFrameUrl) {
        errors.push({
          id: 'end',
          message: 'Keyframe Pair needs an end frame.',
          fix: 'Upload the closing image, or switch to Image to Video if you only have one.',
        });
      }
      break;

    case 'keyframes_timeline': {
      const filled = params.keyframes.filter((k) => k.imageUrl);
      if (filled.length === 0) {
        errors.push({
          id: 'timeline-empty',
          message: 'The timeline has no images.',
          fix: 'Click Add Frame and upload at least one image.',
        });
      } else if (filled.length < params.keyframes.length) {
        warnings.push({
          id: 'timeline-blank',
          message: `${params.keyframes.length - filled.length} timeline frame(s) have no image and will be skipped.`,
          fix: 'Upload an image for each frame, or remove the empty ones.',
        });
      }
      if (filled.length > model.maxTimelineFrames) {
        errors.push({
          id: 'timeline-many',
          message: `${model.label} accepts at most ${model.maxTimelineFrames} timeline frames.`,
          fix: 'Remove some timeline frames.',
        });
      }
      // FLUX 3 pins each image to an exact frame, so positions must be valid
      // and unique (frame_index <= duration x 24, no two on the same frame).
      if (model.family === 'flux-3') {
        const late = filled.find((k) => k.timeSeconds > params.duration);
        if (late) {
          errors.push({
            id: 'timeline-late',
            message: `A timeline frame is at ${late.timeSeconds}s, after the end of a ${params.duration}s video.`,
            fix: 'Move it earlier or choose a longer duration.',
          });
        }
        const indices = filled.map((k) =>
          keyframeFrameIndex(k.timeSeconds, params.duration)
        );
        if (new Set(indices).size !== indices.length) {
          errors.push({
            id: 'timeline-dup',
            message: 'Two timeline frames land on the same frame.',
            fix: 'Give each frame its own time.',
          });
        }
      }
      checkSize('Timeline image', filled.map((k) => k.imageUrl), IMAGE_MAX_MB);
      break;
    }

    case 'reference_to_video':
      if (images.length === 0 && videos.length === 0) {
        errors.push({
          id: 'refs-empty',
          message: 'Reference to Video needs at least one reference image or video.',
          fix: 'Add a reference image or video in the Media Input section.',
        });
      }
      if (images.length > model.maxReferenceImages) {
        errors.push({
          id: 'refs-images-many',
          message: `${model.label} accepts at most ${model.maxReferenceImages} reference images (you have ${images.length}).`,
          fix: 'Remove some reference images.',
        });
      }
      if (videos.length > model.maxReferenceVideos) {
        errors.push({
          id: 'refs-videos-many',
          message: `${model.label} accepts at most ${model.maxReferenceVideos} reference videos (you have ${videos.length}).`,
          fix: 'Remove some reference videos.',
        });
      }
      if (images.length + videos.length > model.maxTotalReferences) {
        errors.push({
          id: 'refs-total',
          message: `${model.label} accepts at most ${model.maxTotalReferences} reference files in total.`,
          fix: 'Remove some references.',
        });
      }
      checkSize('Reference image', images, IMAGE_MAX_MB);
      checkSize('Reference video', videos, model.maxReferenceVideoMB);
      {
        const tags = badTags(prompt, images.length, videos.length);
        if (tags.length > 0) {
          errors.push({
            id: 'tags',
            message: `The prompt mentions ${tags.join(', ')} but that reference isn’t attached.`,
            fix: 'Attach the missing reference, or fix the tag. Tags are numbered by position.',
          });
        }
      }
      break;

    case 'video_extend':
    case 'video_edit':
    case 'video_reframe':
      if (!params.sourceVideoUrl) {
        const label =
          mode === 'video_edit'
            ? 'Edit'
            : mode === 'video_reframe'
            ? 'Reframe'
            : 'Extend & Edit';
        errors.push({
          id: 'source',
          message: `${label} needs a source video.`,
          fix: 'Upload the clip you want to extend, edit or reframe.',
        });
      }
      if (params.sourceVideoUrl) {
        checkSize('Source video', [params.sourceVideoUrl], model.maxReferenceVideoMB);
        if (
          model.family === 'flux-3' &&
          params.sourceVideoUrl.startsWith('data:') &&
          !params.sourceVideoUrl.startsWith('data:video/mp4')
        ) {
          errors.push({
            id: 'source-format',
            message: 'FLUX 3 can only extend MP4 videos.',
            fix: 'Convert the clip to MP4 (under 50 MB and 15 seconds).',
          });
        }
      }
      {
        const tags = badTags(prompt, images.length, params.sourceVideoUrl ? 1 : 0);
        if (tags.length > 0) {
          errors.push({
            id: 'tags',
            message: `The prompt mentions ${tags.join(', ')} but that reference isn’t attached.`,
            fix: 'Attach the missing reference, or fix the tag.',
          });
        }
      }
      break;

    default:
      break;
  }

  // Start / end frame size (image modes)
  if (mode === 'image_to_video' || mode === 'first_last_frame') {
    if (params.startFrameUrl) checkSize('Start frame', [params.startFrameUrl], IMAGE_MAX_MB);
    if (params.endFrameUrl) checkSize('End frame', [params.endFrameUrl], IMAGE_MAX_MB);
  }

  // Profanity: a likely rejection, but only a heuristic, so warn rather than block.
  const profane = findProfanity(prompt);
  if (profane.length > 0) {
    warnings.push({
      id: 'profanity',
      message: `The prompt contains language Seedance often rejects (“${profane.join('”, “')}”).`,
      fix: params.nativeAudio
        ? 'Reword it, or turn off Native Sound Design. The generated audio is moderated too.'
        : 'Reword it to avoid a content-filter rejection.',
    });
  }

  return { errors, warnings };
}
