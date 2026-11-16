import {
  FluxProject,
  SessionVisibility,
  TeamMember,
} from '../types/flux';
import { stripTakeInlineMedia } from '../utils/stripInlineMedia';

/**
 * Client for the server-backed sessions API. Sessions (studios) are persisted
 * in SQLite, owned by a user, and shareable (private / team / specific people).
 */

interface SessionDTO {
  id: string;
  ownerId: string;
  ownerEmail: string;
  title: string;
  description?: string;
  folder?: string;
  params: FluxProject['params'];
  takes: FluxProject['takes'];
  currentTakeId: string | null;
  thumbnailUrl?: string;
  visibility: SessionVisibility;
  isStarred: boolean;
  createdAt: number;
  updatedAt: number;
  sharedWith: string[];
  isOwner: boolean;
}

function dtoToProject(d: SessionDTO): FluxProject {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    folder: d.folder,
    params: d.params,
    takes: d.takes || [],
    currentTakeId: d.currentTakeId,
    thumbnailUrl: d.thumbnailUrl,
    isStarred: d.isStarred,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ownerEmail: d.ownerEmail,
    visibility: d.visibility,
    sharedWith: d.sharedWith || [],
    isOwner: d.isOwner,
  };
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** All sessions visible to the current user (owned + team + shared-with-me). */
export async function fetchSessions(): Promise<FluxProject[]> {
  const data = await req<{ sessions: SessionDTO[] }>('/api/sessions');
  return data.sessions.map(dtoToProject);
}

/** Team members for the share dropdown (everyone who has logged in). */
export async function fetchTeamMembers(): Promise<TeamMember[]> {
  const data = await req<{ members: TeamMember[] }>('/api/team');
  return data.members;
}

export async function createSessionRemote(
  project: FluxProject
): Promise<FluxProject> {
  const data = await req<{ session: SessionDTO }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: project.id,
      title: project.title,
      description: project.description,
      folder: project.folder,
      params: project.params,
      takes: stripTakeInlineMedia(project.takes),
      currentTakeId: project.currentTakeId,
      thumbnailUrl: project.thumbnailUrl,
      isStarred: project.isStarred,
    }),
  });
  return dtoToProject(data.session);
}

export async function updateSessionRemote(
  project: FluxProject
): Promise<FluxProject> {
  const data = await req<{ session: SessionDTO }>(
    `/api/sessions/${encodeURIComponent(project.id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        title: project.title,
        description: project.description,
        folder: project.folder,
        params: project.params,
        takes: stripTakeInlineMedia(project.takes),
        currentTakeId: project.currentTakeId,
        thumbnailUrl: project.thumbnailUrl,
        isStarred: project.isStarred,
      }),
    }
  );
  return dtoToProject(data.session);
}

export async function setSessionVisibilityRemote(
  sessionId: string,
  visibility: SessionVisibility,
  sharedWith: string[]
): Promise<FluxProject> {
  const data = await req<{ session: SessionDTO }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/visibility`,
    {
      method: 'PUT',
      body: JSON.stringify({ visibility, sharedWith }),
    }
  );
  return dtoToProject(data.session);
}

export async function deleteSessionRemote(sessionId: string): Promise<void> {
  await req<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' }
  );
}
