/**
 * Captures a real thumbnail (first frame) from a generated video as a JPEG
 * data URL, for use as a take's poster.
 *
 * Cross-origin videos taint a canvas unless the host sends permissive CORS
 * headers, which breaks toDataURL(). To avoid depending on that, we stream the
 * video bytes through our own same-origin proxy (/api/video-proxy), build a
 * blob URL, and capture from it — a same-origin source never taints the canvas.
 *
 * Returns null on any failure; the caller keeps the existing poster.
 */
export async function captureVideoThumbnail(
  videoUrl: string,
  opts: { seekTime?: number; maxWidth?: number; timeoutMs?: number } = {}
): Promise<string | null> {
  const { seekTime = 0.15, maxWidth = 640, timeoutMs = 20000 } = opts;

  let blobUrl: string | null = null;
  try {
    // Fetch the video through our same-origin proxy so the canvas isn't tainted.
    const res = await fetch(
      `/api/video-proxy?url=${encodeURIComponent(videoUrl)}`,
      { credentials: 'include' }
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    blobUrl = URL.createObjectURL(blob);

    return await captureFromSource(blobUrl, seekTime, maxWidth, timeoutMs);
  } catch {
    return null;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

function captureFromSource(
  src: string,
  seekTime: number,
  maxWidth: number,
  timeoutMs: number
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = src;

    const timer = setTimeout(() => finish(null), timeoutMs);

    const grabFrame = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return finish(null);
        const scale = Math.min(1, maxWidth / vw);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vw * scale);
        canvas.height = Math.round(vh * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.75));
      } catch {
        finish(null);
      }
    };

    video.addEventListener('loadeddata', () => {
      const dur = video.duration;
      const target = Math.min(seekTime, Math.max(0, (dur || seekTime) - 0.05));
      if (Number.isFinite(target) && target > 0) {
        try {
          video.currentTime = target;
        } catch {
          grabFrame();
        }
      } else {
        grabFrame();
      }
    });
    video.addEventListener('seeked', grabFrame);
    video.addEventListener('error', () => finish(null));
  });
}
