import { ApiError } from '@fal-ai/client';

/**
 * Turns fal.ai failures into a short plain-English reason plus a suggested fix,
 * and sanity-checks generation requests before they are sent to fal.
 *
 * fal returns errors as `detail: [{ type, msg, loc, ... }]`. Per fal's docs,
 * `type` is the field to branch on; `msg` is shown as supporting detail only.
 * See https://fal.ai/docs/documentation/model-apis/errors
 */

export interface FalFailure {
  /** HTTP status returned to our client. 422 = fixable by the user, 502 = upstream. */
  status: number;
  /** Stable machine-readable code. */
  code: string;
  /** Short reason shown to the user. */
  message: string;
  /** What the user can do about it. */
  hint?: string;
  /** fal's own message, kept for support/debugging. */
  detail?: string;
  /** Whether retrying the same request unchanged might succeed. */
  retryable: boolean;
}

interface FalErrorItem {
  type?: string;
  msg?: string;
  loc?: unknown[];
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Guards that run BEFORE anything is sent to fal (so nothing is wasted).
// ---------------------------------------------------------------------------

/** Only Seedance endpoints may be called through /api/generate. */
const ALLOWED_GENERATION_PREFIXES = [
  'bytedance/seedance-2.0/',
  'bytedance/seedance-2.5/',
  'blackforestlabs/flux-3/',
];

export function isAllowedGenerationEndpoint(endpointId: string): boolean {
  return ALLOWED_GENERATION_PREFIXES.some((p) => endpointId.startsWith(p));
}

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const reject = (code: string, message: string, hint: string): FalFailure => ({
  status: 422,
  code,
  message,
  hint,
  retryable: false,
});

/** Returns a failure if the request is obviously incomplete, else null. */
export function checkGeneratePayload(
  endpointId: string,
  input: Record<string, unknown>
): FalFailure | null {
  // FLUX 3 draft twins (".../draft") need the same inputs as their parent.
  const tail = endpointId.endsWith('/draft')
    ? endpointId.slice(0, -'/draft'.length)
    : endpointId;
  const isFlux = endpointId.startsWith('blackforestlabs/flux-3/');

  if (tail.endsWith('/draft-enhance')) {
    if (!nonEmptyString(input.draft_cache_url)) {
      return reject(
        'missing_draft_cache',
        'No draft was included to enhance.',
        'Enhance a draft take that has a saved cache.'
      );
    }
    return null;
  }

  if (tail.endsWith('/reference-to-video')) {
    if (!nonEmptyList(input.image_urls) && !nonEmptyList(input.video_urls)) {
      return reject(
        'missing_reference',
        'No reference image or video was included.',
        'Attach at least one reference image or video, then generate again.'
      );
    }
  }

  if (tail.endsWith('/image-to-video') && !nonEmptyString(input.image_url)) {
    return reject(
      'missing_start_image',
      'No start frame image was included.',
      'Add a start frame image, then generate again.'
    );
  }

  if (tail.endsWith('/first-last-frame-to-video')) {
    if (!nonEmptyString(input.start_image_url) || !nonEmptyString(input.end_image_url)) {
      return reject(
        'missing_frames',
        'Both a start frame and an end frame are required.',
        'Add both images, then generate again.'
      );
    }
  }

  if (tail.endsWith('/keyframes-to-video')) {
    const kfs = input.keyframes;
    if (!Array.isArray(kfs) || kfs.length === 0) {
      return reject(
        'missing_keyframes',
        'The timeline has no keyframes.',
        'Add at least one frame with an image, then generate again.'
      );
    }
    const seen = new Set<number>();
    const limit = typeof input.duration === 'number' ? input.duration * 24 : Infinity;
    for (const k of kfs as Array<Record<string, unknown>>) {
      const idx = k?.frame_index;
      if (!nonEmptyString(k?.image_url) || typeof idx !== 'number' || !Number.isInteger(idx)) {
        return reject(
          'bad_keyframe',
          'A timeline keyframe is missing its image or position.',
          'Check each timeline frame has an image, then generate again.'
        );
      }
      if (idx < 0 || idx > limit) {
        return reject(
          'keyframe_out_of_range',
          'A timeline keyframe is placed after the end of the video.',
          'Move it earlier or choose a longer duration.'
        );
      }
      if (seen.has(idx)) {
        return reject(
          'duplicate_keyframe',
          'Two timeline keyframes land on the same frame.',
          'Move one of them to a different time.'
        );
      }
      seen.add(idx);
    }
  }

  if (tail.endsWith('/extend-video') && !nonEmptyString(input.video_url)) {
    return reject(
      'missing_source_video',
      'No source video was included.',
      'Upload the clip you want to extend, then generate again.'
    );
  }

  // Text prompts are required on every text-to-video endpoint and on all FLUX 3
  // generation endpoints.
  if ((tail.endsWith('/text-to-video') || isFlux) && !nonEmptyString(input.prompt)) {
    return reject(
      'missing_prompt',
      'The prompt is empty.',
      'Describe the scene you want, then generate again.'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Translating fal errors
// ---------------------------------------------------------------------------

const BY_TYPE: Record<string, { message: string; hint?: string }> = {
  content_policy_violation: {
    message: 'fal’s content filter blocked this request.',
    hint:
      'Reword the prompt and avoid profanity, violence, sexual content, real people’s likeness, or copyrighted characters. If you used reference images or videos, try different ones.',
  },
  no_media_generated: {
    message: 'The model finished but did not produce a video.',
    hint: 'Try rewording the prompt or changing the seed.',
  },
  file_download_error: {
    message: 'fal could not download one of your files.',
    hint: 'Remove and re-upload the file, then try again.',
  },
  file_too_large: {
    message: 'One of your files is too large.',
    hint: 'Use a smaller file (images up to 30 MB; reference videos have lower limits).',
  },
  image_too_large: {
    message: 'One of your images has too many pixels.',
    hint: 'Resize the image and try again.',
  },
  image_too_small: {
    message: 'One of your images is too small.',
    hint: 'Use a higher-resolution image.',
  },
  image_load_error: {
    message: 'fal could not read one of your images.',
    hint: 'Re-save it as a JPG or PNG and upload it again.',
  },
  unsupported_image_format: {
    message: 'One of your images is in an unsupported format.',
    hint: 'Use JPG, PNG, or WebP.',
  },
  unsupported_video_format: {
    message: 'One of your videos is in an unsupported format.',
    hint: 'Use MP4 or MOV.',
  },
  unsupported_audio_format: {
    message: 'One of your audio files is in an unsupported format.',
    hint: 'Use MP3 or WAV.',
  },
  video_duration_too_long: {
    message: 'A reference video is too long.',
    hint: 'Trim it. Combined reference video length must stay within the model’s limit.',
  },
  video_duration_too_short: {
    message: 'A reference video is too short.',
    hint: 'Reference videos need to be at least about 2 seconds long.',
  },
  sequence_too_long: {
    message: 'Too many files were attached.',
    hint: 'Remove some reference images or videos.',
  },
  sequence_too_short: {
    message: 'Not enough files were attached.',
    hint: 'Add the missing images or videos.',
  },
  feature_not_supported: {
    message: 'This combination of settings isn’t supported by the model.',
    hint: 'Try a different workflow mode, resolution, or duration.',
  },
  generation_timeout: {
    message: 'The generation took too long and timed out.',
    hint: 'Try again, or use a shorter duration or lower resolution.',
  },
};

function extract(err: unknown): { status?: number; items: FalErrorItem[] } {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown; error_type?: string } | undefined;
    const detail = body?.detail;
    let items: FalErrorItem[] = [];
    if (Array.isArray(detail)) {
      items = detail.map((d) => {
        const o = (d ?? {}) as Record<string, unknown>;
        return {
          type: typeof o.type === 'string' ? o.type : undefined,
          msg: typeof o.msg === 'string' ? o.msg : undefined,
          loc: Array.isArray(o.loc) ? o.loc : undefined,
          categories: Array.isArray(o.categories) ? (o.categories as string[]) : undefined,
        };
      });
    } else if (typeof detail === 'string') {
      items = [{ type: body?.error_type, msg: detail }];
    } else if (err.message) {
      items = [{ msg: err.message }];
    }
    return { status: err.status, items };
  }
  if (err instanceof Error) return { items: [{ msg: err.message }] };
  return { items: [] };
}

/** Convert any thrown error from a fal call into a user-facing failure. */
export function describeFalFailure(err: unknown): FalFailure {
  const { status, items } = extract(err);
  const rawMsg = items.map((i) => i.msg).filter(Boolean).join('; ');
  const detail = rawMsg ? rawMsg.slice(0, 300) : undefined;
  const text = rawMsg.toLowerCase();
  const types = items.map((i) => i.type).filter(Boolean) as string[];

  // 1) Generated audio flagged by moderation (the "Output audio has sensitive content" case).
  if (/audio/.test(text) && /sensitive/.test(text)) {
    return {
      status: 422,
      code: 'audio_moderation',
      message: 'The generated audio was flagged as sensitive content.',
      hint:
        'Turn off Native Sound Design and generate again. Profanity, shouting, or spoken dialogue in the prompt can trigger this, so removing those helps too.',
      detail,
      retryable: false,
    };
  }

  // 2) No references reached the model.
  if (/reference/.test(text) && /required/.test(text)) {
    return {
      status: 422,
      code: 'missing_reference',
      message: 'The model did not receive any reference image or video.',
      hint: 'Attach at least one reference image or video, then generate again.',
      detail,
      retryable: false,
    };
  }

  // 3) Known fal error types.
  for (const t of types) {
    const known = BY_TYPE[t];
    if (known) {
      return { status: 422, code: t, ...known, detail, retryable: false };
    }
  }

  // 4) Other moderation wording without a typed error.
  if (/sensitive|policy|moderat|not allowed|prohibited/.test(text)) {
    return {
      status: 422,
      code: 'content_policy_violation',
      ...BY_TYPE.content_policy_violation,
      detail,
      retryable: false,
    };
  }

  // 5) A required field was missing.
  if (types.includes('missing')) {
    const loc = items.find((i) => i.type === 'missing')?.loc;
    const field = Array.isArray(loc) && loc.length > 1 ? String(loc[loc.length - 1]) : '';
    return {
      status: 422,
      code: 'missing',
      message: field
        ? `A required input is missing: ${field}.`
        : 'A required input is missing.',
      hint: 'Check that every required field and media slot is filled in.',
      detail,
      retryable: false,
    };
  }

  // 6) Rate limiting / temporary upstream problems.
  if (status === 429) {
    return {
      status: 502,
      code: 'rate_limited',
      message: 'Too many requests are running at once.',
      hint: 'Wait a minute and try again.',
      detail,
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      status: 502,
      code: 'upstream_error',
      message: 'fal.ai had a temporary problem processing this request.',
      hint: 'Wait a moment and try again. Server-side errors are not billed by fal.',
      detail,
      retryable: true,
    };
  }

  // 7) Anything else: pass fal's own wording through rather than hiding it.
  const clientError = status !== undefined && status >= 400 && status < 500;
  return {
    status: clientError ? 422 : 502,
    code: types[0] ?? 'unknown',
    message: detail ?? 'The generation failed for an unknown reason.',
    hint: clientError
      ? 'Check your prompt and media, then try again.'
      : 'Try again in a moment. If it keeps failing, contact the admin.',
    detail,
    retryable: !clientError,
  };
}

/** One-line summary stored in the database for the admin view. */
export function failureForLog(f: FalFailure): string {
  const base = f.detail && f.detail !== f.message ? `${f.message} (fal: ${f.detail})` : f.message;
  return base.slice(0, 500);
}
