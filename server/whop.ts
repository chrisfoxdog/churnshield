import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  db,
  newId,
  type IDatabase,
  type Creator,
  type Member,
  type SaveTask,
} from './db.js';
import { nowIso, defaultSilentThresholdDays, type SaveTaskKind, type SaveTaskStatus, type StoredRisk } from './constants.js';

export interface WhopWebhookEvent {
  action?: string;
  type?: string;
  id?: string;
  account_id?: string;
  data?: any;
  timestamp?: number | string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// User identity: the Whop iframe token, verified against Whop's JWKS.
// NO algorithms restriction is passed to jwtVerify — Whop's experience
// proxy signs user tokens with ES256, and a verifier pinned to RS256
// rejects every real token (the Nexus lesson, proven live 2026-11-11).
// Identity is NEVER taken from a client-supplied user-ID field.
// ---------------------------------------------------------------------------

const WHOP_JWKS_URL = 'https://api.whop.com/.well-known/jwks.json';
const remoteJWKSet = createRemoteJWKSet(new URL(WHOP_JWKS_URL));

export async function verifyWhopUserToken(token: string): Promise<{
  valid: boolean;
  userId?: string;
  error?: string;
}> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Missing authentication token' };
  }
  const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!cleanToken) return { valid: false, error: 'Empty token string' };

  try {
    const { payload } = await jwtVerify(cleanToken, remoteJWKSet);
    const userId = (payload.sub || (payload as any).user_id) as string | undefined;
    if (!userId) return { valid: false, error: 'Token missing user identity subject claim' };
    return { valid: true, userId };
  } catch (err: any) {
    return { valid: false, error: `Invalid or expired Whop user token: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Standard Webhooks, HMAC-SHA256, fails
// closed). Signed content: "{webhook-id}.{webhook-timestamp}.{raw body}".
// Key: the WHOP_WEBHOOK_SECRET with any prefix (e.g. "whsec_") stripped,
// base64-decoded — the raw UTF-8 form is also tried, matching how Elite's
// other apps accept their dashboard-issued secrets. Timestamps more than
// 5 minutes from now are rejected (replay protection). The legacy
// "t=<ts>,v1=<hex>" header style Elite's other apps accept is supported.
// ---------------------------------------------------------------------------

export interface VerificationResult {
  isValid: boolean;
  reason?: string;
}

export function verifyWhopWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  timestampHeader?: string | undefined,
  webhookIdHeader?: string | undefined
): VerificationResult {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    return { isValid: false, reason: 'WHOP_WEBHOOK_SECRET is not configured. Webhook rejected for security.' };
  }
  if (!signatureHeader) return { isValid: false, reason: 'Missing webhook signature header' };

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');

  // Replay protection — checked before any signature work is trusted.
  if (timestampHeader) {
    const tsNumber = Number(timestampHeader);
    if (!Number.isNaN(tsNumber)) {
      const now = Math.floor(Date.now() / 1000);
      const eventTs = tsNumber > 1e11 ? Math.floor(tsNumber / 1000) : tsNumber;
      if (Math.abs(now - eventTs) > 300) {
        return { isValid: false, reason: 'Webhook timestamp expired (replay attack protection triggered)' };
      }
    }
  }

  const stripped = secret.includes('_') ? secret.slice(secret.indexOf('_') + 1) : secret;
  const keyCandidates: Buffer[] = [];
  try {
    const decoded = Buffer.from(stripped, 'base64');
    if (decoded.length > 0) keyCandidates.push(decoded);
  } catch {
    // not base64 — the raw candidate below still applies
  }
  keyCandidates.push(Buffer.from(secret, 'utf-8'));
  if (stripped !== secret) keyCandidates.push(Buffer.from(stripped, 'utf-8'));

  const signedCandidates: { signed: Buffer; encoding: 'base64' | 'hex' }[] = [];
  if (webhookIdHeader && timestampHeader) {
    signedCandidates.push({
      signed: Buffer.concat([Buffer.from(`${webhookIdHeader}.${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'base64',
    });
  }
  if (timestampHeader) {
    signedCandidates.push({
      signed: Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'hex',
    });
    signedCandidates.push({
      signed: Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'base64',
    });
  }
  signedCandidates.push({ signed: bodyBuffer, encoding: 'hex' });
  signedCandidates.push({ signed: bodyBuffer, encoding: 'base64' });

  // The header may carry one or more "v1,<sig>" entries (key rotation), or a
  // legacy "t=...,v1=..." pair.
  const provided: string[] = [];
  if (signatureHeader.includes('t=') || /^v1=/.test(signatureHeader)) {
    for (const part of signatureHeader.split(',')) {
      const [k, v] = part.split('=');
      if (k?.trim() === 'v1' && v) provided.push(v.trim());
    }
  } else {
    for (const part of signatureHeader.split(' ')) {
      const p = part.trim();
      if (p.startsWith('v1,')) provided.push(p.slice(3));
      else if (p) provided.push(p);
    }
  }
  if (provided.length === 0) return { isValid: false, reason: 'Unparseable webhook signature header' };

  for (const sig of provided) {
    for (const keyMaterial of keyCandidates) {
      for (const { signed, encoding } of signedCandidates) {
        const expected = crypto.createHmac('sha256', keyMaterial).update(signed).digest(encoding);
        try {
          const sigBuf = Buffer.from(sig, encoding);
          const expBuf = Buffer.from(expected, encoding);
          if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
            return { isValid: true };
          }
        } catch {
          // not this encoding — keep trying
        }
        if (sig === expected) return { isValid: true };
      }
    }
  }
  return { isValid: false, reason: 'Signature mismatch' };
}

// ---------------------------------------------------------------------------
// Tenant resolution. One ChurnShield tenant per whop, keyed by
// whop_company_id. The tenant row is created by the first webhook or the
// owner's first visit; whop_user_id is bound when the owner identity is
// known (see server.ts identity resolution).
// ---------------------------------------------------------------------------

export async function getOrCreateTenant(database: IDatabase, companyId: string): Promise<Creator> {
  const creators = await database.getAll<Creator>('creators');
  const existing = creators.find((c) => c.whop_company_id === companyId);
  if (existing) return existing;
  const now = nowIso();
  const creator: Creator = {
    id: newId('creator'),
    whop_company_id: companyId,
    whop_user_id: '',
    display_name: 'Creator',
    silent_threshold_days: defaultSilentThresholdDays(),
    created_at: now,
    updated_at: now,
  };
  return database.insert('creators', creator);
}

export async function addAudit(
  database: IDatabase,
  actor: 'creator' | 'system',
  action: string,
  creatorId?: string,
  memberId?: string,
  detail?: string
): Promise<void> {
  await database.insert('audit_log', {
    id: newId('aud'),
    actor,
    action,
    creator_id: creatorId,
    member_id: memberId,
    detail,
    created_at: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Payload extraction — defensive reads of the real v1 payload shape ONLY:
// flat user_id, membership id, product_id / nested product {id, title},
// variant_id (the plan), money as {amount, currency, decimals} in dollars.
// Name/email are NOT in v1 payloads; the reads below keep CoachDesk-style
// fallbacks in case a future payload provides them, and otherwise the
// record honestly stays "Member".
// ---------------------------------------------------------------------------

function extractMoney(data: any): { amount: number; currency: string } | null {
  const candidates = [data?.amount, data?.total, data?.price, data?.plan_amount];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      return { amount: c, currency: typeof data?.currency === 'string' ? data.currency.toUpperCase() : 'USD' };
    }
    if (c && typeof c === 'object' && typeof c.amount === 'number' && Number.isFinite(c.amount)) {
      return { amount: c.amount, currency: typeof c.currency === 'string' ? c.currency.toUpperCase() : 'USD' };
    }
  }
  return null;
}

/** true / false when the payload says, null when it doesn't say. */
function extractCancelFlag(data: any): boolean | null {
  if (typeof data?.cancel_at_period_end === 'boolean') return data.cancel_at_period_end;
  if (typeof data?.cancels_at_period_end === 'boolean') return data.cancels_at_period_end;
  if (typeof data?.cancel_scheduled === 'boolean') return data.cancel_scheduled;
  if (data?.cancel_at) return true; // a concrete cancel date is set
  return null;
}

function minimizedPayload(data: any, membershipId: string): Record<string, unknown> {
  const money = extractMoney(data);
  return {
    membership_id: membershipId || undefined,
    user_id: data?.user_id || data?.userId || undefined,
    product_id: data?.product_id || data?.product?.id || undefined,
    variant_id: data?.variant_id || undefined,
    status: data?.status || undefined,
    amount: money ? money.amount : undefined,
  };
}

// ---------------------------------------------------------------------------
// Webhook processing — the ChurnShield lifecycle.
// IDEMPOTENCY: Whop retries deliveries. The envelope message id (msg_…) is
// the dedupe key, checked BEFORE any writes and again inside the
// transaction; a duplicate delivery returns 200 and changes nothing — no
// second task, no double-counted metric.
// Events are applied in the order they are RECEIVED: a deactivation
// followed by an activation leaves the member active, and vice versa.
// ---------------------------------------------------------------------------

export async function handleWhopEvent(
  payload: WhopWebhookEvent,
  database: IDatabase = db
): Promise<{ success: boolean; status: 'processed' | 'duplicate' | 'ignored' | 'error'; message: string }> {
  const eventId = payload.id;
  const eventType = payload.type || payload.action || 'unknown';
  if (!eventId) return { success: false, status: 'ignored', message: 'Missing event ID in payload' };

  const existing = await database.getAll<any>('webhook_events');
  if (existing.some((e) => e.whop_event_id === eventId)) {
    return { success: true, status: 'duplicate', message: 'Event already processed — safely ignored.' };
  }

  const data = payload.data || {};
  const whopUserId: string | undefined = data.user_id || data.userId;
  const isMembershipEvent = eventType.startsWith('membership.');
  const membershipId: string = data.membership_id || (isMembershipEvent ? data.id : '') || '';
  const productId: string = data.product_id || data.product?.id || '';
  const productTitle: string = data.product?.title || data.product_title || '';
  const planId: string = data.variant_id || data.plan_id || '';
  const displayName: string = data.user_name || data.name || data.username || '';
  const money = extractMoney(data);
  const companyId: string =
    payload.account_id || data.company_id || process.env.WHOP_COMPANY_ID || 'dev_company';

  try {
    return await database.withTransaction(async (tx) => {
      // Re-check dedupe inside the transaction (race-safe).
      const seen = await tx.getAll<any>('webhook_events');
      if (seen.some((e) => e.whop_event_id === eventId)) {
        return { success: true, status: 'duplicate' as const, message: 'Event already processed — safely ignored.' };
      }

      const creator = await getOrCreateTenant(tx, companyId);
      const now = nowIso();
      let message = `Event ${eventType} recorded and acknowledged.`;
      let result: 'processed' | 'ignored' = 'processed';

      const recordEvent = async (res: 'processed' | 'ignored' | 'error', note?: string) => {
        await tx.insert('webhook_events', {
          id: newId('wh'),
          whop_event_id: eventId,
          type: eventType,
          received_at: now,
          processed_at: nowIso(),
          result: res,
          payload_min: { ...minimizedPayload(data, membershipId), note },
          created_at: now,
        });
      };

      if (!whopUserId && !membershipId) {
        await recordEvent('ignored', 'Missing user and membership id');
        return { success: true, status: 'ignored' as const, message: 'Event carried no user/membership id — logged and ignored.' };
      }

      // --- member helpers -------------------------------------------------
      const findMember = async (): Promise<Member | undefined> => {
        const members = await tx.getAll<Member>('members');
        const mine = members.filter((m) => m.creator_id === creator.id);
        if (membershipId) {
          const byMembership = mine.find((m) => m.whop_membership_id === membershipId);
          if (byMembership) return byMembership;
        }
        if (whopUserId) return mine.find((m) => m.whop_user_id === whopUserId);
        return undefined;
      };

      const snapshot = (): Partial<Member> => {
        const snap: Partial<Member> = {};
        if (productId) snap.product_id = productId;
        if (productTitle) snap.product_title = productTitle;
        if (planId) snap.plan_id = planId;
        if (money) {
          snap.plan_amount = money.amount;
          snap.plan_currency = money.currency;
        }
        if (displayName) snap.display_name = displayName;
        return snap;
      };

      const createMember = async (status: Member['status']): Promise<Member> => {
        const member: Member = {
          id: newId('member'),
          creator_id: creator.id,
          whop_user_id: whopUserId || '',
          whop_membership_id: membershipId || '',
          display_name: displayName || 'Member',
          product_id: productId || '',
          product_title: productTitle || '',
          plan_id: planId || '',
          plan_amount: money ? money.amount : null,
          plan_currency: money ? money.currency : 'USD',
          status,
          risks: [],
          first_seen_at: now,
          last_event_at: now,
          last_event_type: eventType,
          churned_at: status === 'churned' ? now : undefined,
          created_via_event_id: eventId,
          created_at: now,
          updated_at: now,
        };
        await tx.insert('members', member);
        return member;
      };

      const touch = async (member: Member, extra: Partial<Member> = {}): Promise<Member> => {
        const updated = await tx.update<Member>('members', member.id, {
          ...snapshot(),
          ...extra,
          last_event_at: now,
          last_event_type: eventType,
        });
        return updated || member;
      };

      const openTask = async (member: Member, kind: SaveTaskKind): Promise<void> => {
        const tasks = await tx.getAll<SaveTask>('save_tasks');
        const already = tasks.some(
          (t) => t.creator_id === creator.id && t.member_id === member.id && t.kind === kind && t.status === 'open'
        );
        if (already) return; // one open task per (member, risk) — retries can't stack tasks
        await tx.insert('save_tasks', {
          id: newId('task'),
          creator_id: creator.id,
          member_id: member.id,
          whop_membership_id: member.whop_membership_id,
          kind,
          status: 'open' as const,
          amount: member.plan_amount,
          currency: member.plan_currency,
          opened_via_event_id: eventId,
          created_at: now,
          updated_at: now,
        });
      };

      const closeOpenTasks = async (
        member: Member,
        kinds: SaveTaskKind[] | 'all',
        outcome: SaveTaskStatus
      ): Promise<void> => {
        const tasks = await tx.getAll<SaveTask>('save_tasks');
        for (const t of tasks.filter(
          (x) => x.member_id === member.id && x.status === 'open' && (kinds === 'all' || kinds.includes(x.kind))
        )) {
          await tx.update('save_tasks', t.id, { status: outcome, closed_at: nowIso() });
        }
      };

      const addRisk = (member: Member, risk: StoredRisk): StoredRisk[] =>
        member.risks.includes(risk) ? member.risks : [...member.risks, risk];
      const dropRisk = (member: Member, risk: StoredRisk): StoredRisk[] =>
        member.risks.filter((r) => r !== risk);

      // --- lifecycle --------------------------------------------------------
      switch (eventType) {
        case 'membership.activated': {
          let member = await findMember();
          if (!member) {
            member = await createMember('active');
            message = `Member record created for user ${whopUserId} — now being watched.`;
          } else {
            const wasChurned = member.status === 'churned';
            await closeOpenTasks(member, 'all', 'recovered');
            member = await touch(member, { status: 'active', churned_at: undefined, risks: [] });
            message = wasChurned
              ? `Member ${whopUserId} reactivated — churn and risks cleared, history kept.`
              : `Membership confirmed active for user ${whopUserId}.`;
          }
          break;
        }

        case 'membership.updated': {
          let member = await findMember();
          if (!member) {
            member = await createMember('active');
            message = `Member record created from a membership update for user ${whopUserId}.`;
          } else {
            member = await touch(member);
            message = `Membership snapshot updated for user ${whopUserId}.`;
          }
          const flag = extractCancelFlag(data);
          if (flag === true && member.status === 'active') {
            member = await touch(member, { risks: addRisk(member, 'cancel_scheduled') });
            await openTask(member, 'cancel_scheduled');
          } else if (flag === false) {
            member = await touch(member, { risks: dropRisk(member, 'cancel_scheduled') });
            await closeOpenTasks(member, ['cancel_scheduled'], 'recovered');
          }
          break;
        }

        case 'membership.cancel_at_period_end_changed': {
          let member = await findMember();
          if (!member) member = await createMember('active');
          const flag = extractCancelFlag(data);
          if (flag === true) {
            if (member.status === 'active') {
              member = await touch(member, { risks: addRisk(member, 'cancel_scheduled') });
              await openTask(member, 'cancel_scheduled');
              message = `Cancel scheduled for user ${whopUserId} — save task opened.`;
            } else {
              member = await touch(member);
              message = `Cancel-at-period-end noted for churned member ${whopUserId}.`;
            }
          } else if (flag === false) {
            member = await touch(member, { risks: dropRisk(member, 'cancel_scheduled') });
            await closeOpenTasks(member, ['cancel_scheduled'], 'recovered');
            message = `Cancellation switched off for user ${whopUserId} — cancel risk cleared, task recovered.`;
          } else {
            member = await touch(member);
            message = `Cancel-at-period-end change recorded for user ${whopUserId} (payload carried no cancel flag).`;
          }
          break;
        }

        case 'payment.failed': {
          let member = await findMember();
          if (!member) member = await createMember('active');
          if (member.status === 'active') {
            member = await touch(member, { risks: addRisk(member, 'payment_failed') });
            await openTask(member, 'payment_failed');
            message = `Payment failed for user ${whopUserId} — save task opened.`;
          } else {
            member = await touch(member);
            message = `Payment failure noted for churned member ${whopUserId}.`;
          }
          break;
        }

        case 'payment.succeeded': {
          const member = await findMember();
          if (!member) {
            result = 'ignored';
            message = 'payment.succeeded for an unknown member — logged, no state to change.';
            break;
          }
          const hadRisk = member.risks.includes('payment_failed');
          await closeOpenTasks(member, ['payment_failed'], 'recovered');
          await touch(member, { risks: dropRisk(member, 'payment_failed') });
          message = hadRisk
            ? `Payment succeeded for user ${whopUserId} — payment risk cleared, task recovered.`
            : `Payment succeeded for user ${whopUserId} — no open payment risk, nothing to clear.`;
          break;
        }

        case 'payment.created': {
          const member = await findMember();
          if (!member) {
            result = 'ignored';
            message = 'payment.created for an unknown member — logged and ignored.';
            break;
          }
          await touch(member);
          message = `Payment recorded for user ${whopUserId}.`;
          break;
        }

        case 'membership.deactivated': {
          let member = await findMember();
          if (!member) {
            // A member we've never seen churns: the record is still created,
            // as churned, so the creator's churn count is honest.
            member = await createMember('churned');
            message = `First event for user ${whopUserId} is a deactivation — record created as churned.`;
          } else {
            await closeOpenTasks(member, 'all', 'lost');
            member = await touch(member, { status: 'churned', churned_at: now, risks: [] });
            message = `Member ${whopUserId} churned — open save tasks closed as lost.`;
          }
          break;
        }

        default:
          result = 'ignored';
          message = `Event ${eventType} recorded and acknowledged.`;
          break;
      }

      await recordEvent(result);
      return { success: true, status: result === 'ignored' ? ('ignored' as const) : ('processed' as const), message };
    });
  } catch (err: any) {
    console.error(`[handleWhopEvent] Event ${eventId} failed:`, err);
    try {
      const now = nowIso();
      await database.insert('webhook_events', {
        id: newId('wh'),
        whop_event_id: eventId,
        type: eventType,
        received_at: now,
        processed_at: now,
        result: 'error',
        payload_min: minimizedPayload(data, membershipId),
        created_at: now,
      });
    } catch {
      // logging must never mask the original error path
    }
    return { success: false, status: 'error', message: `Processing failed: ${err.message}` };
  }
}
