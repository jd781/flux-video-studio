import React, { useState } from 'react';
import { Lock, Users, UserPlus, Check } from 'lucide-react';
import {
  FluxProject,
  SessionVisibility,
  TeamMember,
} from '../types/flux';

interface ShareControlProps {
  project: FluxProject;
  teamMembers: TeamMember[];
  currentUserEmail: string;
  onClose: () => void;
  onChangeVisibility: (
    projectId: string,
    visibility: SessionVisibility,
    sharedWith: string[]
  ) => void;
}

/**
 * Popover for a session owner to control sharing:
 *  - Private: only the owner
 *  - Team: all @52launch.com members
 *  - Specific people: multi-select from the team list
 */
export const ShareControl: React.FC<ShareControlProps> = ({
  project,
  teamMembers,
  currentUserEmail,
  onClose,
  onChangeVisibility,
}) => {
  const [visibility, setVisibility] = useState<SessionVisibility>(
    project.visibility ?? 'private'
  );
  const [sharedWith, setSharedWith] = useState<string[]>(
    project.sharedWith ?? []
  );

  // Candidate people = all team members except the owner (themselves).
  const candidates = teamMembers.filter(
    (m) => m.email.toLowerCase() !== currentUserEmail.toLowerCase()
  );

  const toggleEmail = (email: string) => {
    setSharedWith((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]
    );
  };

  const apply = () => {
    onChangeVisibility(
      project.id,
      visibility,
      visibility === 'shared' ? sharedWith : []
    );
    onClose();
  };

  const options: {
    id: SessionVisibility;
    label: string;
    desc: string;
    icon: React.ElementType;
  }[] = [
    { id: 'private', label: 'Private', desc: 'Only you', icon: Lock },
    { id: 'team', label: 'Team', desc: 'All 52launch members', icon: Users },
    {
      id: 'shared',
      label: 'Specific people',
      desc: 'Choose who can access',
      icon: UserPlus,
    },
  ];

  return (
    <>
      {/* Dim backdrop + centered dialog. Fixed positioning so it's never clipped
          by the session card's overflow-hidden. */}
      <div
        className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="w-72 max-h-[80vh] overflow-y-auto bg-neutral-900/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-xl text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-white/[0.08] text-[11px] font-semibold text-white">
            Share “{project.title}”
          </div>

        <div className="p-1.5 space-y-0.5">
          {options.map((opt) => {
            const Icon = opt.icon;
            const active = visibility === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setVisibility(opt.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  active ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                <Icon className="w-3.5 h-3.5 text-neutral-300 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-white leading-tight">
                    {opt.label}
                  </span>
                  <span className="block text-[10px] text-neutral-400 leading-tight">
                    {opt.desc}
                  </span>
                </span>
                {active && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </button>
            );
          })}
        </div>

        {/* Specific-people multi-select */}
        {visibility === 'shared' && (
          <div className="border-t border-white/[0.08] max-h-44 overflow-y-auto p-1.5">
            {candidates.length === 0 ? (
              <p className="text-[11px] text-neutral-500 px-2 py-2">
                No other team members have signed in yet.
              </p>
            ) : (
              candidates.map((m) => {
                const checked = sharedWith.includes(m.email);
                return (
                  <button
                    key={m.email}
                    type="button"
                    onClick={() => toggleEmail(m.email)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        checked
                          ? 'bg-emerald-500 border-emerald-500'
                          : 'border-white/25'
                      }`}
                    >
                      {checked && <Check className="w-2.5 h-2.5 text-neutral-950" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-white truncate leading-tight">
                        {m.name || m.email}
                      </span>
                      {m.name && (
                        <span className="block text-[10px] text-neutral-400 font-mono truncate leading-tight">
                          {m.email}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}

        <div className="p-2 border-t border-white/[0.08] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded-lg text-[11px] text-neutral-300 hover:text-white hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white text-neutral-950 hover:bg-neutral-200 transition-colors"
          >
            Apply
          </button>
          </div>
        </div>
      </div>
    </>
  );
};
