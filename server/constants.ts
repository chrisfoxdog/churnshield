// Shared constants for ChurnShield. No secrets live here. The only numbers in
// this product are the creator's own, computed from real webhook events —
// nothing is seeded, sampled, or projected anywhere in this codebase.

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/** Default days without a webhook event before an active member is "silent". */
export function defaultSilentThresholdDays(): number {
  const raw = Number(process.env.SILENT_MEMBER_DAYS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 365 ? Math.floor(raw) : 14;
}

/** Risk kinds stored on the member record (event-driven). "silent" is NOT
 *  stored — it is derived at read time from last_event_at (see metrics.ts),
 *  because webhook events are the only activity signal the MVP has. */
export const STORED_RISKS = ['cancel_scheduled', 'payment_failed'] as const;
export type StoredRisk = (typeof STORED_RISKS)[number];
export type RiskKind = StoredRisk | 'silent';

/** Save-task kinds map 1:1 onto the stored risks that open them. */
export type SaveTaskKind = StoredRisk;
export type SaveTaskStatus = 'open' | 'saved' | 'lost' | 'recovered';
