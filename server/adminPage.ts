import type { GenerationRow } from './db';

/**
 * Minimal server-rendered admin dashboard. No client bundle — just a styled
 * HTML table of per-user totals and recent generations. Served only to the
 * admin account (guarded by requireAdmin).
 */

interface AdminData {
  grandTotals: { count: number; tokens: number; cost_usd: number };
  perUser: Array<{
    user_id: string;
    email: string;
    name: string | null;
    count: number;
    tokens: number;
    cost_usd: number;
    last_generation: number | null;
  }>;
  recent: GenerationRow[];
}

/** Escape text for safe HTML interpolation. */
function esc(value: unknown): string {
  const s = value == null ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(n: number): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

function when(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function renderAdminPage(data: AdminData): string {
  const { grandTotals, perUser, recent } = data;

  const perUserRows = perUser
    .map(
      (u) => `
      <tr>
        <td>${esc(u.name || '—')}</td>
        <td class="mono">${esc(u.email)}</td>
        <td class="num">${u.count}</td>
        <td class="num">${u.tokens.toLocaleString()}</td>
        <td class="num">${usd(u.cost_usd)}</td>
        <td class="mono">${esc(when(u.last_generation))}</td>
      </tr>`
    )
    .join('');

  const recentRows = recent
    .map(
      (g) => `
      <tr>
        <td class="mono">${esc(when(g.created_at))}</td>
        <td class="mono">${esc(g.user_email)}</td>
        <td>${esc(g.kind)}</td>
        <td>${esc(g.model_id || '—')}</td>
        <td>${esc(g.resolution || '—')}</td>
        <td class="num">${g.duration ?? '—'}</td>
        <td class="num">${(g.tokens ?? 0).toLocaleString()}</td>
        <td class="num">${usd(g.cost_usd)}</td>
        <td class="${g.status === 'completed' ? 'ok' : 'bad'}">${esc(g.status)}</td>
        <td class="reason">${esc(g.error || '')}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>52 Video Studio — Admin</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #09090b; color: #e5e5e5; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #a3a3a3; margin: 0 0 24px; font-size: 13px; }
    .cards { display: flex; gap: 12px; margin-bottom: 28px; flex-wrap: wrap; }
    .card { flex: 1; min-width: 160px; background: #18181b; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 16px; }
    .card .label { color: #a3a3a3; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #a3a3a3; margin: 28px 0 10px; }
    table { width: 100%; border-collapse: collapse; background: #18181b; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; overflow: hidden; }
    th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 13px; }
    th { color: #a3a3a3; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; background: #1f1f23; }
    tr:last-child td { border-bottom: none; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .ok { color: #34d399; }
    .bad { color: #f87171; }
    .reason { color: #a3a3a3; font-size: 12px; max-width: 320px; }
    a.logout { color: #a3a3a3; font-size: 12px; float: right; text-decoration: none; border: 1px solid rgba(255,255,255,.12); padding: 5px 10px; border-radius: 8px; }
    a.logout:hover { color: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <a class="logout" href="/">← Back to studio</a>
    <h1>Admin — Usage Overview</h1>
    <p class="sub">All users' generations, token usage, and estimated cost. Costs are fal.ai estimates.</p>

    <div class="cards">
      <div class="card"><div class="label">Total Generations</div><div class="value">${grandTotals.count}</div></div>
      <div class="card"><div class="label">Total Tokens</div><div class="value">${grandTotals.tokens.toLocaleString()}</div></div>
      <div class="card"><div class="label">Total Est. Cost</div><div class="value">${usd(grandTotals.cost_usd)}</div></div>
      <div class="card"><div class="label">Users</div><div class="value">${perUser.length}</div></div>
    </div>

    <h2>Per User</h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th class="num">Gens</th><th class="num">Tokens</th><th class="num">Est. Cost</th><th>Last Generation</th></tr></thead>
      <tbody>${perUserRows || '<tr><td colspan="6">No usage yet.</td></tr>'}</tbody>
    </table>

    <h2>Recent Generations (latest 200)</h2>
    <table>
      <thead><tr><th>When</th><th>User</th><th>Kind</th><th>Model</th><th>Res</th><th class="num">Dur</th><th class="num">Tokens</th><th class="num">Cost</th><th>Status</th><th>Failure reason</th></tr></thead>
      <tbody>${recentRows || '<tr><td colspan="10">No generations yet.</td></tr>'}</tbody>
    </table>
  </div>
</body>
</html>`;
}
