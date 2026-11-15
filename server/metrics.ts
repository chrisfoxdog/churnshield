import type { Member, SaveTask } from './db.js';
import { daysBetween, type RiskKind } from './constants.js';

/**
 * Read-side computation. Everything here is derived from real stored records
 * at request time — there is no cached or seeded number anywhere. The
 * "silent" risk is derived here (and only here): an ACTIVE member whose last
 * webhook event is older than the creator's threshold. Webhook events are
 * the only activity signal the MVP has, and the UI labels it exactly that
 * way ("no membership events in N+ days").
 */

export interface MemberView extends Member {
  risks_all: RiskKind[];
  silent_days: number | null; // days since last event when silent, else null
}

export function isSilent(member: Member, thresholdDays: number, now = new Date()): boolean {
  if (member.status !== 'active') return false;
  const last = new Date(member.last_event_at).getTime();
  if (Number.isNaN(last)) return false;
  return daysBetween(new Date(last), now) >= thresholdDays;
}

export function memberView(member: Member, thresholdDays: number, now = new Date()): MemberView {
  const risks_all: RiskKind[] = [...member.risks];
  let silent_days: number | null = null;
  if (isSilent(member, thresholdDays, now)) {
    risks_all.push('silent');
    silent_days = daysBetween(new Date(member.last_event_at), now);
  }
  return { ...member, risks_all, silent_days };
}

export interface Metrics {
  active_members: number;
  at_risk_count: number;
  dollars_at_risk: number;
  open_tasks: number;
  saved_count: number;
  dollars_saved: number;
  lost_count: number;
  recovered_count: number;
  churned_count: number;
  currency: string; // the currency dollars_* are summed in ('USD' unless records say otherwise)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Metrics over ONE creator's records. Dollar sums skip records whose plan
 * amount is unknown (null) — an unknown amount is never treated as $0 of
 * value invented or lost; the member still counts in the headcounts.
 */
export function computeMetrics(members: Member[], tasks: SaveTask[], thresholdDays: number, now = new Date()): Metrics {
  const views = members.map((m) => memberView(m, thresholdDays, now));
  const active = views.filter((m) => m.status === 'active');
  const atRisk = active.filter((m) => m.risks_all.length > 0);

  const byId = new Map(members.map((m) => [m.id, m]));
  const savedTasks = tasks.filter((t) => t.status === 'saved');
  let dollarsSaved = 0;
  for (const t of savedTasks) {
    const amount = t.amount ?? byId.get(t.member_id)?.plan_amount ?? null;
    if (amount !== null) dollarsSaved += amount;
  }

  const currency = members.find((m) => m.plan_currency)?.plan_currency || 'USD';

  return {
    active_members: active.length,
    at_risk_count: atRisk.length,
    dollars_at_risk: round2(atRisk.reduce((sum, m) => sum + (m.plan_amount ?? 0), 0)),
    open_tasks: tasks.filter((t) => t.status === 'open').length,
    saved_count: savedTasks.length,
    dollars_saved: round2(dollarsSaved),
    lost_count: tasks.filter((t) => t.status === 'lost').length,
    recovered_count: tasks.filter((t) => t.status === 'recovered').length,
    churned_count: views.filter((m) => m.status === 'churned').length,
    currency,
  };
}
