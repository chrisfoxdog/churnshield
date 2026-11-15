export type RiskKind = 'cancel_scheduled' | 'payment_failed' | 'silent';

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
  currency: string;
}

export interface MemberView {
  id: string;
  whop_user_id: string;
  whop_membership_id: string;
  display_name: string;
  product_id: string;
  product_title: string;
  plan_amount: number | null;
  plan_currency: string;
  status: 'active' | 'churned';
  risks: string[];
  risks_all: RiskKind[];
  silent_days: number | null;
  first_seen_at: string;
  last_event_at: string;
  last_event_type: string;
  churned_at?: string;
}

export interface SaveTaskView {
  id: string;
  member_id: string;
  kind: 'cancel_scheduled' | 'payment_failed';
  status: 'open' | 'saved' | 'lost' | 'recovered';
  amount: number | null;
  currency: string;
  effective_amount: number | null;
  member_display_name: string;
  member_product_title: string;
  member_status: string;
  created_at: string;
  closed_at?: string;
}

export interface DraftResponse {
  draft: string;
  source: 'template' | 'gemini';
  kind: string;
  member_id: string;
  task_id?: string;
  note: string;
}

export function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export const RISK_LABELS: Record<RiskKind, string> = {
  cancel_scheduled: 'Cancel scheduled',
  payment_failed: 'Payment failed',
  silent: 'Silent',
};
