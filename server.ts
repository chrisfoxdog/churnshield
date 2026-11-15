import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  db,
  type Creator,
  type Member,
  type SaveTask,
} from './server/db.js';
import {
  verifyWhopUserToken,
  verifyWhopWebhookSignature,
  handleWhopEvent,
  getOrCreateTenant,
  addAudit,
} from './server/whop.js';
import { computeMetrics, memberView } from './server/metrics.js';
import { PLAYBOOK_KINDS, generateDraft, playbookKindForTaskKind, type PlaybookKind } from './server/playbooks.js';
import { nowIso } from './server/constants.js';

export const app = express();
// Read dynamically, not once at boot: the production fail-closed behavior
// must follow the actual runtime environment on every request.
const isProd = () => process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Health — public, same shape discipline as Elite's other apps.
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const dbHealth = await db.healthCheck();
  return res.json({
    ok: dbHealth.ok,
    status: dbHealth.ok ? 'healthy' : 'degraded',
    timestamp: nowIso(),
    environment: process.env.NODE_ENV || 'development',
    database: dbHealth,
    whopConfigured: Boolean(process.env.WHOP_WEBHOOK_SECRET),
    whopApiKeySet: Boolean(process.env.WHOP_API_KEY),
    whopAppIdSet: Boolean(process.env.WHOP_APP_ID),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

// ---------------------------------------------------------------------------
// Webhooks — raw body first, HMAC verified BEFORE any JSON parsing, 401 on
// bad signature (with zero state change: verification precedes all writes),
// 400 on malformed JSON, 500 only if processing itself fails.
// ---------------------------------------------------------------------------
app.post('/api/webhooks/whop', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const rawBody = req.body as Buffer;
    const signature = (req.headers['webhook-signature'] || req.headers['x-whop-signature']) as string | undefined;
    const timestamp = (req.headers['webhook-timestamp'] || req.headers['x-whop-timestamp']) as string | undefined;
    const webhookId = req.headers['webhook-id'] as string | undefined;

    const verification = verifyWhopWebhookSignature(rawBody, signature, timestamp, webhookId);
    if (!verification.isValid) {
      console.warn(`[Whop Webhook] Rejected unauthorized webhook: ${verification.reason}`);
      return res.status(401).json({ error: 'Invalid webhook signature', details: verification.reason });
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : String(rawBody));
    } catch {
      return res.status(400).json({ error: 'Malformed JSON payload in webhook' });
    }

    const result = await handleWhopEvent(payload);
    if (result.status === 'error') {
      return res.status(500).json({ received: false, status: result.status, message: result.message });
    }
    return res.status(200).json({ received: true, status: result.status, message: result.message });
  } catch (err: any) {
    console.error('[Whop Webhook Error]', err);
    return res.status(500).json({ error: 'Webhook processing error', message: err.message });
  }
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Identity. The dashboard belongs to the whop's owner (the creator). The
// server derives who you are from the verified Whop token — never from a
// client-supplied user id. Production fails closed (401) and has NO
// dev-header fallback. DB failure -> 503 DATABASE_UNAVAILABLE, never a
// crash, never fake data. Members (the creator's customers) have no
// dashboard access in the MVP.
// ---------------------------------------------------------------------------

interface Identity {
  role: 'creator';
  userId: string;
  creator: Creator;
}

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

async function resolveIdentity(req: Request): Promise<Identity | { error: number; body: any }> {
  const health = await db.healthCheck();
  if (!health.ok) return { error: 503, body: { error: 'DATABASE_UNAVAILABLE' } };

  let userId: string | undefined;
  let devCompany: string | undefined;

  const tokenHeader = (req.headers['x-whop-user-token'] || req.headers['authorization']) as string | undefined;
  if (tokenHeader) {
    const verification = await verifyWhopUserToken(tokenHeader);
    if (!verification.valid) {
      return { error: 401, body: { error: 'WHOP_USER_AUTH_REQUIRED', message: verification.error } };
    }
    userId = verification.userId;
  } else if (!isProd()) {
    const devHeader = (req.headers['x-whop-dev-user-id'] || req.headers['x-mock-user-id']) as string | undefined;
    if (devHeader && devHeader.trim()) {
      userId = devHeader.trim();
      devCompany = (req.headers['x-whop-dev-company-id'] as string | undefined)?.trim();
    }
  }

  if (!userId) {
    return {
      error: 401,
      body: {
        error: 'WHOP_USER_AUTH_REQUIRED',
        message: 'Open ChurnShield from inside your Whop to sign in.',
      },
    };
  }

  const companyId = devCompany || process.env.WHOP_COMPANY_ID || (isProd() ? '' : 'dev_company');
  if (!companyId) {
    return { error: 401, body: { error: 'WHOP_USER_AUTH_REQUIRED', message: 'WHOP_COMPANY_ID is not configured.' } };
  }

  const tenant = await getOrCreateTenant(db, companyId);

  if (tenant.whop_user_id && tenant.whop_user_id === userId) {
    return { role: 'creator', userId, creator: tenant };
  }
  if (!tenant.whop_user_id) {
    // First verified identity on a fresh install binds as the owner (the
    // person who installed the app into the whop). See SMOKE.md.
    const bound = await db.update<Creator>('creators', tenant.id, { whop_user_id: userId });
    await addAudit(db, 'creator', 'creator_sign_in', tenant.id, undefined, 'Owner identity bound on first open');
    return { role: 'creator', userId, creator: bound || tenant };
  }
  return { error: 403, body: { error: 'NO_ACCESS', message: 'This Whop account has no ChurnShield access.' } };
}

async function requireIdentity(req: Request, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveIdentity(req);
    if ('error' in resolved) return res.status(resolved.error).json(resolved.body);
    req.identity = resolved;
    return next();
  } catch (err: any) {
    console.error('[Identity Error]', err);
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
  }
}

function requireCreator(req: Request, res: Response, next: NextFunction) {
  if (req.identity?.role !== 'creator') {
    return res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'This area is for the creator only.' });
  }
  return next();
}

async function creatorMembers(creatorId: string): Promise<Member[]> {
  const members = await db.getAll<Member>('members');
  return members.filter((m) => m.creator_id === creatorId);
}

async function creatorTasks(creatorId: string): Promise<SaveTask[]> {
  const tasks = await db.getAll<SaveTask>('save_tasks');
  return tasks.filter((t) => t.creator_id === creatorId);
}

// ---------------------------------------------------------------------------
// Context — how the frontend learns it is rendering the creator dashboard.
// ---------------------------------------------------------------------------
app.get('/api/me/context', requireIdentity, async (req, res) => {
  const idn = req.identity!;
  return res.json({
    role: 'creator',
    creator: { id: idn.creator.id, display_name: idn.creator.display_name },
  });
});

// ===========================================================================
// CREATOR API — every route below is JWT-guarded and tenant-scoped.
// ===========================================================================

app.get('/api/creator/metrics', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const [members, tasks] = await Promise.all([creatorMembers(creator.id), creatorTasks(creator.id)]);
  return res.json({ metrics: computeMetrics(members, tasks, creator.silent_threshold_days) });
});

app.get('/api/creator/members', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const members = await creatorMembers(creator.id);
  const views = members
    .map((m) => memberView(m, creator.silent_threshold_days))
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  return res.json({ members: views, total: views.length });
});

app.get('/api/creator/tasks', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';
  const [tasks, members] = await Promise.all([creatorTasks(creator.id), creatorMembers(creator.id)]);
  const byId = new Map(members.map((m) => [m.id, m]));
  const views = tasks
    .filter((t) => !statusFilter || t.status === statusFilter)
    .map((t) => {
      const member = byId.get(t.member_id);
      return {
        ...t,
        member_display_name: member?.display_name || 'Member',
        member_product_title: member?.product_title || '',
        member_status: member?.status || 'churned',
        effective_amount: t.amount ?? member?.plan_amount ?? null,
      };
    })
    .sort((a, b) => {
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
  return res.json({ tasks: views, total: views.length, open_count: tasks.filter((t) => t.status === 'open').length });
});

app.post('/api/creator/tasks/:taskId/resolve', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const outcome = req.body?.outcome;
  if (outcome !== 'saved' && outcome !== 'lost') {
    return res.status(400).json({ error: 'INVALID_OUTCOME', message: 'Outcome must be "saved" or "lost".' });
  }
  const task = await db.getById<SaveTask>('save_tasks', req.params.taskId);
  if (!task || task.creator_id !== creator.id) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Save task not found.' });
  }
  if (task.status !== 'open') {
    return res.status(409).json({ error: 'TASK_ALREADY_CLOSED', message: `This task is already ${task.status}.` });
  }
  const updated = await db.update<SaveTask>('save_tasks', task.id, { status: outcome, closed_at: nowIso() });
  // A member the creator saved no longer carries that risk.
  const member = await db.getById<Member>('members', task.member_id);
  if (member && outcome === 'saved' && member.risks.includes(task.kind)) {
    await db.update<Member>('members', member.id, { risks: member.risks.filter((r) => r !== task.kind) });
  }
  await addAudit(db, 'creator', outcome === 'saved' ? 'task_saved' : 'task_lost', creator.id, task.member_id, `Task ${task.id} (${task.kind}) marked ${outcome} by creator`);
  return res.json({ task: updated });
});

app.get('/api/creator/playbooks', requireIdentity, requireCreator, async (_req, res) => {
  return res.json({ playbooks: PLAYBOOK_KINDS });
});

app.post('/api/creator/playbooks/draft', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id : '';
  const memberId = typeof req.body?.member_id === 'string' ? req.body.member_id : '';
  const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : '';

  let member: Member | undefined;
  let kind: PlaybookKind | undefined;

  if (taskId) {
    const task = await db.getById<SaveTask>('save_tasks', taskId);
    if (!task || task.creator_id !== creator.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Save task not found.' });
    }
    member = await db.getById<Member>('members', task.member_id);
    kind = playbookKindForTaskKind(task.kind);
  } else if (memberId) {
    member = await db.getById<Member>('members', memberId);
    if (!member || member.creator_id !== creator.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Member not found.' });
    }
    if (!PLAYBOOK_KINDS.some((p) => p.kind === kindRaw)) {
      return res.status(400).json({ error: 'INVALID_KIND', message: 'Kind must be one of: cancel-save, failed-card, silent-check-in.' });
    }
    kind = kindRaw as PlaybookKind;
  } else {
    return res.status(400).json({ error: 'MISSING_TARGET', message: 'Provide task_id, or member_id with kind.' });
  }
  if (!member || !kind) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Member not found.' });
  }

  const view = memberView(member, creator.silent_threshold_days);
  const result = await generateDraft(kind, { member, silentDays: view.silent_days });
  return res.json({
    draft: result.draft,
    source: result.source,
    kind: result.kind,
    member_id: member.id,
    task_id: taskId || undefined,
    note: 'Draft only — ChurnShield never sends messages. Copy it and send it in Whop or Discord.',
  });
});

app.get('/api/creator/settings', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  return res.json({
    settings: {
      silent_threshold_days: creator.silent_threshold_days,
      whop_company_id: creator.whop_company_id,
    },
  });
});

app.patch('/api/creator/settings', requireIdentity, requireCreator, async (req, res) => {
  const creator = req.identity!.creator;
  const days = req.body?.silent_threshold_days;
  if (days !== undefined) {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return res.status(400).json({ error: 'INVALID_SETTING', message: 'silent_threshold_days must be an integer between 1 and 90.' });
    }
    const updated = await db.update<Creator>('creators', creator.id, { silent_threshold_days: days });
    return res.json({ settings: { silent_threshold_days: updated?.silent_threshold_days ?? days } });
  }
  return res.json({ settings: { silent_threshold_days: creator.silent_threshold_days } });
});

// ---------------------------------------------------------------------------
// Static frontend (production build) + SPA fallback.
// ---------------------------------------------------------------------------
const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

export function startServer() {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`ChurnShield server listening on port ${port} (${process.env.NODE_ENV || 'development'})`);
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) startServer();
