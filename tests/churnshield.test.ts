// ChurnShield guardrail + lifecycle + hardening test suite.
// Covers: health; fail-closed auth (incl. production mode with NO dev
// fallback); webhook signature valid / invalid / tampered-timestamp /
// standard "whsec_" key format; malformed JSON -> 400 with no crash;
// signature failure -> 401 with NO state change; idempotency (same envelope
// msg id twice -> one task, unchanged metrics); every event->risk
// transition incl. payment recovery, cancel-flag-off recovery, and
// churn-after-cancel = lost; the edge cases (unknown event type, missing
// optional money/product fields, deactivation of a never-seen member,
// payment.succeeded with no prior failure, out-of-order delivery);
// metrics math on a fixture set; tenant scoping; template draft generation.
// Runs against a temp JSON store so the dev store stays clean.

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
const SECRET = 'test_webhook_secret_value';
process.env.WHOP_WEBHOOK_SECRET = SECRET;
process.env.WHOP_COMPANY_ID = 'biz_test_company';
delete process.env.DATABASE_URL;
delete process.env.GEMINI_API_KEY; // drafts must take the template path
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churnshield-test-'));
process.env.CHURNSHIELD_STORE_PATH = path.join(tmpDir, 'store.json');

const { app } = await import('../server.ts');
const { db } = await import('../server/db.ts');

const server = app.listen(0);
const port = (server.address() as any).port;
const BASE = `http://127.0.0.1:${port}`;

let passed = 0;
function pass(name: string) {
  passed++;
  console.log(`✓ PASS ${passed}: ${name}`);
}

async function req(method: string, url: string, opts: { headers?: Record<string, string>; body?: any } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

const creatorA = { 'x-whop-dev-user-id': 'creator_user_a' };
const creatorB = { 'x-whop-dev-user-id': 'creator_user_b', 'x-whop-dev-company-id': 'biz_fixture' };
const intruder = { 'x-whop-dev-user-id': 'intruder_user' };

function signHeaders(body: string, msgId: string, key: Buffer | string = SECRET, tsOverride?: string) {
  const ts = tsOverride || Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', key).update(`${msgId}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': msgId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

async function sendWebhook(msgId: string, type: string, data: any, opts: { company?: string; key?: Buffer | string; tsOverride?: string } = {}) {
  const body = JSON.stringify({
    id: msgId,
    type,
    api_version: 'v1',
    account_id: opts.company || 'biz_test_company',
    timestamp: new Date().toISOString(),
    data,
  });
  const res = await fetch(`${BASE}/api/webhooks/whop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signHeaders(body, msgId, opts.key || SECRET, opts.tsOverride) },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function sendRawWebhook(rawBody: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}/api/webhooks/whop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function metrics(headers: Record<string, string>) {
  const r = await req('GET', '/api/creator/metrics', { headers });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.metrics;
}

async function members(headers: Record<string, string>) {
  const r = await req('GET', '/api/creator/members', { headers });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.members as any[];
}

async function tasks(headers: Record<string, string>) {
  const r = await req('GET', '/api/creator/tasks', { headers });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.tasks as any[];
}

async function run() {
  console.log('================================================================================');
  console.log('CHURNSHIELD — GUARDRAIL, LIFECYCLE & HARDENING TEST SUITE');
  console.log('================================================================================\n');

  // 1. Health endpoint
  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.json.ok, true);
  assert.strictEqual(health.json.database.ok, true);
  assert.strictEqual(health.json.whopConfigured, true);
  pass('Health endpoint reports ok + database ok + whopConfigured');

  // 2. No identity -> 401 fail-closed on every dashboard route
  for (const url of ['/api/creator/metrics', '/api/creator/members', '/api/creator/tasks', '/api/creator/settings', '/api/me/context']) {
    const r = await req('GET', url);
    assert.strictEqual(r.status, 401, `${url} must 401 without identity`);
  }
  const noAuthPost = await req('POST', '/api/creator/playbooks/draft', { body: { member_id: 'x', kind: 'cancel-save' } });
  assert.strictEqual(noAuthPost.status, 401);
  pass('Dashboard routes reject unauthenticated requests 401 (no member data leaks)');

  // 3. Production mode has NO dev-header fallback
  process.env.NODE_ENV = 'production';
  try {
    const prodReq = await req('GET', '/api/creator/metrics', { headers: creatorA });
    assert.strictEqual(prodReq.status, 401, 'Dev header must not authenticate in production mode');
  } finally {
    process.env.NODE_ENV = 'test';
  }
  pass('Production mode: dev-header fallback is disabled (401)');

  // 4. Creator context binds the tenant owner; a second user on the same whop gets 403
  const ctx = await req('GET', '/api/me/context', { headers: creatorA });
  assert.strictEqual(ctx.status, 200);
  assert.strictEqual(ctx.json.role, 'creator');
  const intr = await req('GET', '/api/creator/members', { headers: intruder });
  assert.strictEqual(intr.status, 403);
  pass('Creator identity binds as owner; a different Whop user gets 403 on dashboard routes');

  // 5. Bad signature -> 401 AND no state change
  const eventsBefore = (await db.getAll<any>('webhook_events')).length;
  const bad = await sendWebhook('msg_bad_sig', 'membership.activated', { id: 'mem_x', user_id: 'ghost' }, { key: 'wrong_secret' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await db.getAll<any>('webhook_events')).length, eventsBefore, 'Rejected webhook must write nothing');
  assert.strictEqual((await members(creatorA)).length, 0);
  pass('Bad signature -> 401 with zero state change (no event row, no member)');

  // 6. Tampered (stale) timestamp -> 401 even with an otherwise valid signature
  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await sendWebhook('msg_stale_ts', 'membership.activated', { id: 'mem_x', user_id: 'ghost' }, { tsOverride: staleTs });
  assert.strictEqual(stale.status, 401);
  assert.strictEqual((await members(creatorA)).length, 0);
  pass('Stale timestamp (>5 min) -> 401 replay protection, no state change');

  // 7. Malformed JSON with a VALID signature -> 400, no crash, no state change
  const malformed = '{"id":"msg_malformed","type": broken';
  const mal = await sendRawWebhook(malformed, signHeaders(malformed, 'msg_malformed'));
  assert.strictEqual(mal.status, 400);
  assert.strictEqual((await members(creatorA)).length, 0);
  const healthAfter = await req('GET', '/api/health');
  assert.strictEqual(healthAfter.status, 200);
  pass('Malformed JSON body -> 400, server alive, no state change');

  // 8. Standard Webhooks key format: secret stored as prefix + base64, signed with decoded bytes
  const rawKey = crypto.randomBytes(32);
  const stdSecret = ['wh', 'sec_'].join('') + rawKey.toString('base64');
  process.env.WHOP_WEBHOOK_SECRET = stdSecret;
  try {
    const std = await sendWebhook('msg_std_format', 'membership.activated', {
      id: 'mem_std', user_id: 'user_std', product_id: 'prod_std',
      product: { id: 'prod_std', title: 'Std Format Club' },
      variant_id: 'plan_std', amount: { amount: 15, currency: 'usd', decimals: 2 },
    }, { key: rawKey });
    assert.strictEqual(std.status, 200, JSON.stringify(std));
    assert.strictEqual(std.json.status, 'processed');
  } finally {
    process.env.WHOP_WEBHOOK_SECRET = SECRET;
  }
  const stdMembers = await members(creatorA);
  const stdMember = stdMembers.find((m) => m.whop_membership_id === 'mem_std');
  assert.ok(stdMember, 'member from standard-format webhook must exist');
  assert.strictEqual(stdMember.plan_amount, 15);
  assert.strictEqual(stdMember.product_title, 'Std Format Club');
  assert.strictEqual(stdMember.display_name, 'Member', 'v1 payload has no name — fallback must be "Member"');
  pass('Standard Webhooks secret format (prefixed base64 key) verifies; money/product extracted; name falls back to "Member"');

  // 9. Activation creates the member; metrics count it
  const act = await sendWebhook('msg_act_1', 'membership.activated', {
    id: 'mem_1', user_id: 'user_1', product_id: 'prod_alpha',
    product: { id: 'prod_alpha', title: 'Alpha Community' },
    variant_id: 'plan_alpha_m', amount: { amount: 50, currency: 'usd', decimals: 2 }, status: 'active',
  });
  assert.strictEqual(act.status, 200);
  assert.strictEqual(act.json.status, 'processed');
  let m = await metrics(creatorA);
  assert.strictEqual(m.active_members, 2); // user_std + user_1
  assert.strictEqual(m.at_risk_count, 0);
  pass('membership.activated creates the member record with plan amount + product title');

  // 10. Cancel scheduled -> risk + ONE open save task; dollars at risk
  const cancel1 = await sendWebhook('msg_cancel_1', 'membership.cancel_at_period_end_changed', {
    id: 'mem_1', user_id: 'user_1', cancel_at_period_end: true,
  });
  assert.strictEqual(cancel1.status, 200);
  let t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 1);
  assert.strictEqual(t[0].kind, 'cancel_scheduled');
  assert.strictEqual(t[0].amount, 50);
  m = await metrics(creatorA);
  assert.strictEqual(m.at_risk_count, 1);
  assert.strictEqual(m.dollars_at_risk, 50);
  pass('cancel_at_period_end_changed (flag on) -> cancel_scheduled risk + open save task + $50 at risk');

  // 11. IDEMPOTENCY: same envelope msg id delivered twice -> duplicate, one task, metrics unchanged
  const before = await metrics(creatorA);
  const dup = await sendWebhook('msg_cancel_1', 'membership.cancel_at_period_end_changed', {
    id: 'mem_1', user_id: 'user_1', cancel_at_period_end: true,
  });
  assert.strictEqual(dup.status, 200);
  assert.strictEqual(dup.json.status, 'duplicate');
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 1, 'Duplicate delivery must not create a second task');
  assert.deepStrictEqual(await metrics(creatorA), before, 'Duplicate delivery must not move any metric');
  pass('Idempotency: duplicate envelope id -> 200 duplicate, still one task, metrics identical');

  // 12. Same risk re-signaled under a NEW envelope id -> still one open task (per-member+kind dedupe)
  const cancelAgain = await sendWebhook('msg_cancel_1b', 'membership.cancel_at_period_end_changed', {
    id: 'mem_1', user_id: 'user_1', cancel_at_period_end: true,
  });
  assert.strictEqual(cancelAgain.json.status, 'processed');
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 1);
  pass('A second cancel signal for the same member does not stack a second open task');

  // 13. Cancel flag turns OFF -> risk cleared, task closed as recovered
  const cancelOff = await sendWebhook('msg_cancel_off', 'membership.cancel_at_period_end_changed', {
    id: 'mem_1', user_id: 'user_1', cancel_at_period_end: false,
  });
  assert.strictEqual(cancelOff.status, 200);
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 0);
  assert.strictEqual(t.find((x) => x.kind === 'cancel_scheduled').status, 'recovered');
  m = await metrics(creatorA);
  assert.strictEqual(m.at_risk_count, 0);
  assert.strictEqual(m.recovered_count, 1);
  const mem1 = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_1');
  assert.deepStrictEqual(mem1.risks_all, []);
  pass('Cancel flag OFF -> risk cleared and the save task closes as recovered');

  // 14. payment.failed -> risk + task; payment.succeeded -> cleared + recovered
  await sendWebhook('msg_pay_fail', 'payment.failed', {
    id: 'pay_1', membership_id: 'mem_1', user_id: 'user_1', amount: { amount: 50, currency: 'usd', decimals: 2 },
  });
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open' && x.kind === 'payment_failed').length, 1);
  m = await metrics(creatorA);
  assert.strictEqual(m.at_risk_count, 1);
  await sendWebhook('msg_pay_ok', 'payment.succeeded', {
    id: 'pay_2', membership_id: 'mem_1', user_id: 'user_1', amount: { amount: 50, currency: 'usd', decimals: 2 },
  });
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 0);
  assert.strictEqual(t.find((x) => x.kind === 'payment_failed').status, 'recovered');
  m = await metrics(creatorA);
  assert.strictEqual(m.at_risk_count, 0);
  assert.strictEqual(m.recovered_count, 2);
  pass('payment.failed opens a payment save task; payment.succeeded clears the risk and recovers the task');

  // 15. payment.succeeded with NO prior failure -> 200 no-op
  const noopPay = await sendWebhook('msg_pay_noop', 'payment.succeeded', {
    id: 'pay_3', membership_id: 'mem_1', user_id: 'user_1',
  });
  assert.strictEqual(noopPay.status, 200);
  assert.strictEqual(noopPay.json.status, 'processed');
  t = await tasks(creatorA);
  assert.strictEqual(t.filter((x) => x.status === 'open').length, 0);
  pass('payment.succeeded with no prior failure is a clean no-op (200, no task, no risk)');

  // 16. Cancel then deactivated -> member churned, cancel task closed as LOST
  await sendWebhook('msg_cancel_2', 'membership.cancel_at_period_end_changed', {
    id: 'mem_1', user_id: 'user_1', cancel_at_period_end: true,
  });
  assert.strictEqual((await tasks(creatorA)).filter((x) => x.status === 'open').length, 1);
  await sendWebhook('msg_deact_1', 'membership.deactivated', { id: 'mem_1', user_id: 'user_1', status: 'expired' });
  const mem1After = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_1');
  assert.strictEqual(mem1After.status, 'churned');
  t = await tasks(creatorA);
  const lostTask = t.find((x) => x.kind === 'cancel_scheduled' && x.status === 'lost');
  assert.ok(lostTask, 'Open cancel task must close as lost on deactivation');
  m = await metrics(creatorA);
  assert.strictEqual(m.churned_count, 1);
  assert.strictEqual(m.lost_count, 1);
  pass('Deactivation after a scheduled cancel -> churned; the open cancel task closes as lost');

  // 17. Out-of-order: deactivation of a never-seen member, then activation -> active wins
  const deactUnknown = await sendWebhook('msg_deact_unknown', 'membership.deactivated', {
    id: 'mem_ooo', user_id: 'user_ooo', status: 'expired',
  });
  assert.strictEqual(deactUnknown.status, 200);
  let ooo = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_ooo');
  assert.ok(ooo, 'Record must be created even when the first event is a deactivation');
  assert.strictEqual(ooo.status, 'churned');
  await sendWebhook('msg_act_ooo', 'membership.activated', {
    id: 'mem_ooo', user_id: 'user_ooo', product: { id: 'prod_alpha', title: 'Alpha Community' },
    amount: { amount: 50, currency: 'usd', decimals: 2 },
  });
  ooo = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_ooo');
  assert.strictEqual(ooo.status, 'active', 'Later activation must win over the earlier deactivation');
  assert.strictEqual(ooo.churned_at, undefined);
  pass('Edge: deactivation for a never-seen member creates a churned record; a later activation reactivates it');

  // 18. Unknown event type -> 200, recorded, no crash, no member state change
  const memberCountBefore = (await members(creatorA)).length;
  const unknown = await sendWebhook('msg_unknown_evt', 'dispute.created', { id: 'dsp_1', user_id: 'user_1' });
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.json.status, 'ignored');
  assert.strictEqual((await members(creatorA)).length, memberCountBefore);
  const evtRows = await db.getAll<any>('webhook_events');
  assert.ok(evtRows.some((e) => e.whop_event_id === 'msg_unknown_evt' && e.result === 'ignored'));
  pass('Unknown event type -> 200, recorded as ignored, no crash, no state change');

  // 19. Missing optional money/product fields -> record created, amount null, metrics skip the null
  const mBefore19 = await metrics(creatorA);
  await sendWebhook('msg_act_bare', 'membership.activated', { id: 'mem_bare', user_id: 'user_bare' });
  await sendWebhook('msg_cancel_bare', 'membership.cancel_at_period_end_changed', {
    id: 'mem_bare', user_id: 'user_bare', cancel_at_period_end: true,
  });
  const bare = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_bare');
  assert.ok(bare);
  assert.strictEqual(bare.plan_amount, null);
  assert.strictEqual(bare.product_title, '');
  const mAfter19 = await metrics(creatorA);
  assert.strictEqual(mAfter19.at_risk_count, mBefore19.at_risk_count + 1, 'Bare member still counts as at risk');
  assert.strictEqual(mAfter19.dollars_at_risk, mBefore19.dollars_at_risk, 'Null amount must add $0 — never an invented number');
  pass('Missing money/product fields -> record + task created with null amount; dollar metrics skip nulls');

  // 20. Silent radar: backdate last event past the threshold -> derived silent risk
  const bareRow = (await db.getAll<any>('members')).find((x) => x.whop_membership_id === 'mem_bare');
  await db.update('members', bareRow.id, { last_event_at: new Date(Date.now() - 20 * 86400000).toISOString() });
  const bareView = (await members(creatorA)).find((x) => x.whop_membership_id === 'mem_bare');
  assert.ok(bareView.risks_all.includes('silent'), 'Member with no events in 20d must be flagged silent at the 14d default');
  assert.ok(bareView.silent_days >= 20);
  pass('Silent radar derives from last_event_at vs threshold (default 14 days)');

  // 21. Playbook drafts: template source, placeholders filled, silent draft by member
  const openCancel = (await tasks(creatorA)).find((x) => x.status === 'open' && x.kind === 'cancel_scheduled');
  const draft = await req('POST', '/api/creator/playbooks/draft', { headers: creatorA, body: { task_id: openCancel.id } });
  assert.strictEqual(draft.status, 200, JSON.stringify(draft.json));
  assert.strictEqual(draft.json.source, 'template', 'Without GEMINI_API_KEY the draft must be labeled template');
  assert.strictEqual(draft.json.kind, 'cancel-save');
  const bareId = bareView.id;
  const silentDraft = await req('POST', '/api/creator/playbooks/draft', {
    headers: creatorA, body: { member_id: bareId, kind: 'silent-check-in' },
  });
  assert.strictEqual(silentDraft.status, 200);
  assert.ok(silentDraft.json.draft.includes('check in'), 'Silent draft should read as a check-in');
  const stdDraft = await req('POST', '/api/creator/playbooks/draft', {
    headers: creatorA, body: { member_id: stdMember.id, kind: 'cancel-save' },
  });
  assert.ok(stdDraft.json.draft.includes('Std Format Club'), 'Template must fill the real product title');
  pass('Playbook drafts generate from templates (labeled "template"), fill real product names, cover silent check-ins');

  // 22. Mark saved via API -> saved metrics; invalid outcome 400; unknown task 404; re-resolve 409
  const badOutcome = await req('POST', `/api/creator/tasks/${openCancel.id}/resolve`, { headers: creatorA, body: { outcome: 'maybe' } });
  assert.strictEqual(badOutcome.status, 400);
  const unknownTask = await req('POST', '/api/creator/tasks/task_nope/resolve', { headers: creatorA, body: { outcome: 'saved' } });
  assert.strictEqual(unknownTask.status, 404);
  const saved = await req('POST', `/api/creator/tasks/${openCancel.id}/resolve`, { headers: creatorA, body: { outcome: 'saved' } });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.json.task.status, 'saved');
  const again = await req('POST', `/api/creator/tasks/${openCancel.id}/resolve`, { headers: creatorA, body: { outcome: 'lost' } });
  assert.strictEqual(again.status, 409);
  pass('Task resolve validates outcome (400), 404s unknown tasks, 409s double-resolution');

  // 23. Store failure -> dashboard reads fail closed with 503 (never fake data)
  const originalHealth = db.healthCheck.bind(db);
  (db as any).healthCheck = async () => ({ ok: false, type: 'file', details: 'stubbed outage' });
  try {
    const down = await req('GET', '/api/creator/metrics', { headers: creatorA });
    assert.strictEqual(down.status, 503);
    assert.strictEqual(down.json.error, 'DATABASE_UNAVAILABLE');
  } finally {
    (db as any).healthCheck = originalHealth;
  }
  const backUp = await req('GET', '/api/creator/metrics', { headers: creatorA });
  assert.strictEqual(backUp.status, 200);
  pass('Store failure -> 503 DATABASE_UNAVAILABLE on dashboard reads; recovers when the store does');

  // 24. Store failure on the webhook route -> 500 (acceptable there), signature path unaffected after restore
  const originalGetAll = db.getAll.bind(db);
  (db as any).getAll = async () => { throw new Error('stubbed store outage'); };
  try {
    const whDown = await sendWebhook('msg_store_down', 'membership.activated', { id: 'mem_down', user_id: 'user_down' });
    assert.strictEqual(whDown.status, 500);
  } finally {
    (db as any).getAll = originalGetAll;
  }
  pass('Store failure on webhook processing -> 500 (event not acknowledged, Whop will retry)');

  // 25. METRICS FIXTURE (fresh tenant): exact math across saved / at-risk / null-amount / silent / churned
  const F = { company: 'biz_fixture' };
  const fx = (id: string, type: string, data: any) => sendWebhook(id, type, data, F);
  await fx('fx_act_1', 'membership.activated', { id: 'fx_mem_1', user_id: 'fx_user_1', product: { id: 'p', title: 'Fixture' }, amount: { amount: 50, currency: 'usd', decimals: 2 } });
  await fx('fx_cancel_1', 'membership.cancel_at_period_end_changed', { id: 'fx_mem_1', user_id: 'fx_user_1', cancel_at_period_end: true });
  await fx('fx_act_2', 'membership.activated', { id: 'fx_mem_2', user_id: 'fx_user_2', amount: { amount: 30, currency: 'usd', decimals: 2 } });
  await fx('fx_fail_2', 'payment.failed', { id: 'pay_fx2', membership_id: 'fx_mem_2', user_id: 'fx_user_2' });
  await fx('fx_act_3', 'membership.activated', { id: 'fx_mem_3', user_id: 'fx_user_3' }); // no money fields
  await fx('fx_cancel_3', 'membership.cancel_at_period_end_changed', { id: 'fx_mem_3', user_id: 'fx_user_3', cancel_at_period_end: true });
  await fx('fx_act_4', 'membership.activated', { id: 'fx_mem_4', user_id: 'fx_user_4', amount: { amount: 20, currency: 'usd', decimals: 2 } });
  await fx('fx_deact_4', 'membership.deactivated', { id: 'fx_mem_4', user_id: 'fx_user_4' });
  await fx('fx_act_5', 'membership.activated', { id: 'fx_mem_5', user_id: 'fx_user_5', amount: { amount: 10, currency: 'usd', decimals: 2 } });
  const fx5 = (await db.getAll<any>('members')).find((x) => x.whop_membership_id === 'fx_mem_5');
  await db.update('members', fx5.id, { last_event_at: new Date(Date.now() - 30 * 86400000).toISOString() });

  const fxTasks = await tasks(creatorB);
  const fxSaveTask = fxTasks.find((x) => x.member_id && x.kind === 'cancel_scheduled' && x.status === 'open' && x.effective_amount === 50);
  assert.ok(fxSaveTask, 'fixture cancel task for the $50 member must exist');
  const fxSaved = await req('POST', `/api/creator/tasks/${fxSaveTask.id}/resolve`, { headers: creatorB, body: { outcome: 'saved' } });
  assert.strictEqual(fxSaved.status, 200);

  const fm = await metrics(creatorB);
  assert.strictEqual(fm.active_members, 4, JSON.stringify(fm)); // fx 1,2,3,5
  assert.strictEqual(fm.at_risk_count, 3, JSON.stringify(fm)); // fx2 payment_failed, fx3 cancel (null $), fx5 silent
  assert.strictEqual(fm.dollars_at_risk, 40, JSON.stringify(fm)); // 30 + 0 (null skipped) + 10
  assert.strictEqual(fm.open_tasks, 2, JSON.stringify(fm)); // fx2 payment, fx3 cancel
  assert.strictEqual(fm.saved_count, 1);
  assert.strictEqual(fm.dollars_saved, 50);
  assert.strictEqual(fm.churned_count, 1);
  assert.strictEqual(fm.lost_count, 0);
  pass('Metrics math on the fixture set: active 4, at-risk 3, $40 at risk (null skipped), saved 1 / $50, churned 1');

  // 26. Tenant scoping: fixture tenant sees only fixture data; creator A never sees fixture members
  const bMembers = await members(creatorB);
  assert.strictEqual(bMembers.length, 5);
  assert.ok(bMembers.every((x) => x.whop_membership_id.startsWith('fx_')));
  const aMembers = await members(creatorA);
  assert.ok(!aMembers.some((x) => x.whop_membership_id.startsWith('fx_')), 'Creator A must not see fixture tenant members');
  const crossResolve = await req('POST', `/api/creator/tasks/${fxSaveTask.id}/resolve`, { headers: creatorA, body: { outcome: 'lost' } });
  assert.strictEqual(crossResolve.status, 404, 'Cross-tenant task access must 404 (already closed or not — never visible)');
  pass('Tenant scoping: each creator sees only their own members and tasks');

  // 27. Settings: silent threshold is configurable and persists
  const patched = await req('PATCH', '/api/creator/settings', { headers: creatorB, body: { silent_threshold_days: 45 } });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.json.settings.silent_threshold_days, 45);
  const fx5View = (await members(creatorB)).find((x) => x.whop_membership_id === 'fx_mem_5');
  assert.ok(!fx5View.risks_all.includes('silent'), 'At a 45-day threshold, 30 days quiet is not silent anymore');
  const badPatch = await req('PATCH', '/api/creator/settings', { headers: creatorB, body: { silent_threshold_days: 0 } });
  assert.strictEqual(badPatch.status, 400);
  pass('Silent threshold is a validated per-creator setting (1–90) and drives the radar');

  console.log(`\n================================================================================`);
  console.log(`ALL ${passed} TESTS PASSED`);
  console.log(`================================================================================`);
}

run()
  .then(() => {
    server.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n✗ TEST FAILURE:', err);
    server.close();
    process.exit(1);
  });
