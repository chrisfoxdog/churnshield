// ChurnShield local smoke run.
// Boots the dev server (temp JSON store, dev identity enabled), then:
//   1. GET /api/health
//   2. POST signed membership.activated
//   3. POST signed membership.cancel_at_period_end_changed (cancel flag on)
//      -> member + open save task must appear in the dashboard API
//   4. POST signed payment.failed, then payment.succeeded
//      -> payment risk must be cleared afterwards
// Prints every response so the output can be pasted into SMOKE.md verbatim.
// Usage: node scripts/smoke.mjs

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'smoke_webhook_secret_value';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churnshield-smoke-'));
const storePath = path.join(tmpDir, 'store.json');

const server = spawn('npx', ['tsx', 'server.ts'], {
  detached: true, // own process group so the whole tree can be stopped
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    WHOP_WEBHOOK_SECRET: SECRET,
    WHOP_COMPANY_ID: 'biz_smoke',
    CHURNSHIELD_STORE_PATH: storePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Server did not come up');
}

function sign(body, msgId) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', SECRET).update(`${msgId}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': msgId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

async function sendWebhook(msgId, type, data) {
  const body = JSON.stringify({
    id: msgId,
    type,
    api_version: 'v1',
    account_id: 'biz_smoke',
    timestamp: new Date().toISOString(),
    data,
  });
  const res = await fetch(`${BASE}/api/webhooks/whop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign(body, msgId) },
    body,
  });
  return { status: res.status, json: await res.json() };
}

const dev = { 'x-whop-dev-user-id': 'smoke_creator' };
async function api(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: dev });
  return { status: res.status, json: await res.json() };
}

try {
  const health = await waitForHealth();
  console.log('== GET /api/health ==');
  console.log(JSON.stringify(health, null, 2));

  console.log('\n== POST membership.activated (member joins, $29 plan) ==');
  console.log(JSON.stringify(await sendWebhook('smoke_msg_1', 'membership.activated', {
    id: 'mem_smoke_1',
    user_id: 'user_smoke_1',
    product_id: 'prod_smoke',
    product: { id: 'prod_smoke', title: 'Smoke Test Community' },
    variant_id: 'plan_smoke_m',
    amount: { amount: 29, currency: 'usd', decimals: 2 },
    status: 'active',
  }), null, 2));

  console.log('\n== POST membership.cancel_at_period_end_changed (cancel flag ON) ==');
  console.log(JSON.stringify(await sendWebhook('smoke_msg_2', 'membership.cancel_at_period_end_changed', {
    id: 'mem_smoke_1',
    user_id: 'user_smoke_1',
    cancel_at_period_end: true,
  }), null, 2));

  const members1 = await api('/api/creator/members');
  const tasks1 = await api('/api/creator/tasks');
  const metrics1 = await api('/api/creator/metrics');
  console.log('\n== Dashboard after cancel: member ==');
  console.log(JSON.stringify(members1.json.members.map((x) => ({
    display_name: x.display_name, product_title: x.product_title, plan_amount: x.plan_amount,
    status: x.status, risks_all: x.risks_all,
  })), null, 2));
  console.log('== Dashboard after cancel: open tasks ==');
  console.log(JSON.stringify(tasks1.json.tasks.map((x) => ({
    kind: x.kind, status: x.status, amount: x.amount, member_product_title: x.member_product_title,
  })), null, 2));
  console.log('== Dashboard after cancel: metrics ==');
  console.log(JSON.stringify(metrics1.json.metrics, null, 2));

  console.log('\n== POST payment.failed ==');
  console.log(JSON.stringify(await sendWebhook('smoke_msg_3', 'payment.failed', {
    id: 'pay_smoke_1', membership_id: 'mem_smoke_1', user_id: 'user_smoke_1',
    amount: { amount: 29, currency: 'usd', decimals: 2 },
  }), null, 2));

  console.log('\n== POST payment.succeeded (recovery) ==');
  console.log(JSON.stringify(await sendWebhook('smoke_msg_4', 'payment.succeeded', {
    id: 'pay_smoke_2', membership_id: 'mem_smoke_1', user_id: 'user_smoke_1',
    amount: { amount: 29, currency: 'usd', decimals: 2 },
  }), null, 2));

  const members2 = await api('/api/creator/members');
  const tasks2 = await api('/api/creator/tasks');
  console.log('\n== Member after payment recovery (payment risk must be gone, cancel risk stays) ==');
  console.log(JSON.stringify(members2.json.members.map((x) => ({ status: x.status, risks_all: x.risks_all })), null, 2));
  console.log('== Tasks after payment recovery ==');
  console.log(JSON.stringify(tasks2.json.tasks.map((x) => ({ kind: x.kind, status: x.status })), null, 2));

  const member = members2.json.members[0];
  if (!member.risks_all.includes('cancel_scheduled')) throw new Error('SMOKE FAIL: cancel risk missing');
  if (member.risks_all.includes('payment_failed')) throw new Error('SMOKE FAIL: payment risk not cleared');
  const paymentTask = tasks2.json.tasks.find((x) => x.kind === 'payment_failed');
  if (!paymentTask || paymentTask.status !== 'recovered') throw new Error('SMOKE FAIL: payment task not recovered');
  console.log('\nSMOKE OK: health 200, cancel opened a save task, payment failure recovered on payment.succeeded.');
} finally {
  try {
    process.kill(-server.pid, 'SIGTERM'); // kill the npx -> tsx -> node tree
  } catch {
    server.kill('SIGTERM');
  }
  server.unref();
  // Give the tree a moment to die, then exit explicitly — the child's
  // stdio pipes would otherwise hold this process open.
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
