/**
 * Take snapshots (`takes[].params`) are only used to restore settings. They
 * used to embed full base64 images (data: URLs), which bloated every saved
 * session to tens of MB. These helpers drop inline data: URLs from the take
 * snapshots. The session's own live `params` is left untouched.
 */

function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('data:') ? '' : value;
  }
  if (Array.isArray(value)) return value.map(stripDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDeep(v);
    }
    return out;
  }
  return value;
}

/** Returns takes with inline data: URLs removed from each take's `params`. */
export function stripTakeInlineMedia<T>(takes: T): T {
  if (!Array.isArray(takes)) return takes;
  return takes.map((t) => {
    if (t && typeof t === 'object' && 'params' in (t as object)) {
      return { ...(t as object), params: stripDeep((t as { params: unknown }).params) };
    }
    return t;
  }) as unknown as T;
}
