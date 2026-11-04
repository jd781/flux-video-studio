/**
 * Client-side auth helpers. The session lives in an httpOnly cookie set by the
 * server; the client only reads identity via /api/me and triggers login/logout.
 */

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
  isAdmin: boolean;
}

export interface MeResponse {
  authenticated: boolean;
  user?: AuthUser;
}

/** Fetch the current session user, or null if not signed in. */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as MeResponse;
    return data.authenticated && data.user ? data.user : null;
  } catch {
    return null;
  }
}

/** Redirect the browser into the Google OAuth flow. */
export function login(): void {
  window.location.href = '/auth/google';
}

/** Destroy the session and reload. */
export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  } finally {
    window.location.href = '/';
  }
}

export interface UsageTotals {
  count: number;
  tokens: number;
  cost_usd: number;
}

export interface UsageGeneration {
  id: string;
  created_at: number;
  kind: string;
  model_id: string | null;
  resolution: string | null;
  duration: number | null;
  tokens: number;
  cost_usd: number;
  status: string;
  error?: string | null;
}

/** Fetch the current user's own usage totals + history. */
export async function fetchMyUsage(): Promise<{
  totals: UsageTotals;
  generations: UsageGeneration[];
} | null> {
  try {
    const res = await fetch('/api/usage/me', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as {
      totals: UsageTotals;
      generations: UsageGeneration[];
    };
  } catch {
    return null;
  }
}
