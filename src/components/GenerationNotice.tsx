import React from 'react';
import { AlertCircle, AlertTriangle, X } from 'lucide-react';
import { PreflightIssue } from '../utils/validateGeneration';

/**
 * A persistent card for two situations:
 *  - preflight: something is missing/likely to fail, shown BEFORE submitting.
 *  - failed:    a submitted generation failed; shows the reason and the fix.
 * Unlike a toast it stays until dismissed, so the reason can actually be read.
 */
export type GenerationNoticeData =
  | { kind: 'preflight'; errors: PreflightIssue[]; warnings: PreflightIssue[] }
  | {
      kind: 'failed';
      title: string;
      message: string;
      hint?: string;
      detail?: string;
    };

interface GenerationNoticeProps {
  notice: GenerationNoticeData | null;
  onDismiss: () => void;
  /** Called when the user chooses to proceed despite warnings. */
  onProceed?: () => void;
}

export const GenerationNotice: React.FC<GenerationNoticeProps> = ({
  notice,
  onDismiss,
  onProceed,
}) => {
  if (!notice) return null;

  // ---- Failed generation -------------------------------------------------
  if (notice.kind === 'failed') {
    return (
      <div
        role="alert"
        className="bg-red-950/30 border border-red-500/30 rounded-2xl p-3.5 text-neutral-100 shadow-lg"
      >
        <div className="flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-xs font-semibold text-red-200">{notice.title}</div>
            <p className="text-xs text-white leading-relaxed">{notice.message}</p>
            {notice.hint && (
              <p className="text-xs text-neutral-300 leading-relaxed">
                <span className="font-semibold text-neutral-200">What to try: </span>
                {notice.hint}
              </p>
            )}
            {notice.detail && notice.detail !== notice.message && (
              <p className="text-[10px] text-neutral-500 font-mono leading-relaxed break-words">
                fal.ai said: {notice.detail}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1 text-neutral-400 hover:text-white transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // ---- Pre-flight --------------------------------------------------------
  const hasErrors = notice.errors.length > 0;
  const tone = hasErrors
    ? 'bg-red-950/30 border-red-500/30'
    : 'bg-amber-950/30 border-amber-500/30';

  return (
    <div
      role="alert"
      className={`${tone} border rounded-2xl p-3.5 text-neutral-100 shadow-lg`}
    >
      <div className="flex items-start gap-2.5">
        {hasErrors ? (
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <div
            className={`text-xs font-semibold ${
              hasErrors ? 'text-red-200' : 'text-amber-200'
            }`}
          >
            {hasErrors
              ? 'Fix this before generating (nothing was submitted)'
              : 'Heads up before you generate'}
          </div>

          {notice.errors.length > 0 && (
            <ul className="space-y-1.5">
              {notice.errors.map((issue) => (
                <li key={issue.id} className="text-xs leading-relaxed">
                  <span className="text-white">{issue.message}</span>
                  {issue.fix && (
                    <span className="text-neutral-400"> {issue.fix}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {notice.warnings.length > 0 && (
            <ul className="space-y-1.5">
              {notice.warnings.map((issue) => (
                <li key={issue.id} className="text-xs leading-relaxed">
                  <span className="text-amber-100">{issue.message}</span>
                  {issue.fix && (
                    <span className="text-neutral-400"> {issue.fix}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!hasErrors && onProceed && (
            <div className="flex items-center gap-2 pt-0.5">
              <button
                type="button"
                onClick={onProceed}
                className="px-3 py-1 rounded-lg bg-white text-neutral-950 text-[11px] font-medium hover:bg-neutral-200 transition-colors"
              >
                Generate anyway
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="px-3 py-1 rounded-lg text-[11px] text-neutral-300 hover:text-white hover:bg-white/5 transition-colors"
              >
                Edit first
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 text-neutral-400 hover:text-white transition-colors shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
