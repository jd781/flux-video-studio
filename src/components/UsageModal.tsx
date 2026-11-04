import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import {
  fetchMyUsage,
  UsageGeneration,
  UsageTotals,
} from '../lib/auth';
import { formatRelativeTime } from '../utils/fluxVideoUtils';

interface UsageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Shows the current user their own generation count, token usage, and cost. */
export const UsageModal: React.FC<UsageModalProps> = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [generations, setGenerations] = useState<UsageGeneration[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetchMyUsage().then((data) => {
      if (data) {
        setTotals(data.totals);
        setGenerations(data.generations);
      }
      setLoading(false);
    });
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-neutral-950 border border-white/[0.08] rounded-2xl shadow-2xl text-neutral-100 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
          <h2 className="text-sm font-semibold">My Usage</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-neutral-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Totals */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-neutral-900/60 border border-white/[0.08] p-3">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                  Generations
                </div>
                <div className="text-xl font-semibold mt-1">
                  {totals?.count ?? 0}
                </div>
              </div>
              <div className="rounded-xl bg-neutral-900/60 border border-white/[0.08] p-3">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                  Tokens
                </div>
                <div className="text-xl font-semibold mt-1">
                  {(totals?.tokens ?? 0).toLocaleString()}
                </div>
              </div>
              <div className="rounded-xl bg-neutral-900/60 border border-white/[0.08] p-3">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                  Est. Cost
                </div>
                <div className="text-xl font-semibold mt-1">
                  ${(totals?.cost_usd ?? 0).toFixed(2)}
                </div>
              </div>
            </div>

            {/* History */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
                Recent Generations
              </div>
              {generations.length === 0 ? (
                <p className="text-xs text-neutral-500 py-4 text-center">
                  No generations yet.
                </p>
              ) : (
                <div className="rounded-xl border border-white/[0.08] overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-neutral-900/80 text-neutral-400">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">When</th>
                        <th className="text-left font-medium px-3 py-2">Kind</th>
                        <th className="text-left font-medium px-3 py-2">Model</th>
                        <th className="text-left font-medium px-3 py-2">Res</th>
                        <th className="text-right font-medium px-3 py-2">Tokens</th>
                        <th className="text-right font-medium px-3 py-2">Cost</th>
                        <th className="text-left font-medium px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {generations.map((g) => (
                        <tr key={g.id} className="border-t border-white/[0.06]">
                          <td className="px-3 py-2 text-neutral-400">
                            {formatRelativeTime(g.created_at)}
                          </td>
                          <td className="px-3 py-2">{g.kind}</td>
                          <td className="px-3 py-2">{g.model_id || '—'}</td>
                          <td className="px-3 py-2">{g.resolution || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">
                            {g.tokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            ${g.cost_usd.toFixed(2)}
                          </td>
                          <td
                            className={`px-3 py-2 ${
                              g.status === 'completed'
                                ? 'text-emerald-400'
                                : 'text-red-400'
                            }`}
                          >
                            {g.status}
                            {g.status !== 'completed' && g.error && (
                              <div
                                className="text-[10px] text-neutral-500 max-w-[220px] truncate"
                                title={g.error}
                              >
                                {g.error}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-[11px] text-neutral-500">
              Costs are fal.ai estimates based on model, resolution, and duration.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
