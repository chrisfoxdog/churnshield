import type { Member } from './db.js';

/**
 * Playbook drafts. Drafts ONLY — ChurnShield never sends a message in the
 * MVP; the creator copies the draft and sends it in Whop or Discord.
 *
 * The default path is a built-in template with the member's real product
 * filled in. If GEMINI_API_KEY is configured, the template may be polished
 * by Gemini — and the result is labeled source: 'gemini'. A template draft
 * is labeled source: 'template'. The label is part of the API contract: the
 * UI shows it, and a template draft is never presented as AI-written.
 */

export type PlaybookKind = 'cancel-save' | 'failed-card' | 'silent-check-in';

export const PLAYBOOK_KINDS: { kind: PlaybookKind; label: string; task_kind: string | null }[] = [
  { kind: 'cancel-save', label: 'Cancel save', task_kind: 'cancel_scheduled' },
  { kind: 'failed-card', label: 'Failed-card recovery', task_kind: 'payment_failed' },
  { kind: 'silent-check-in', label: 'Silent member check-in', task_kind: null },
];

export function playbookKindForTaskKind(taskKind: string): PlaybookKind {
  return taskKind === 'payment_failed' ? 'failed-card' : 'cancel-save';
}

export interface DraftContext {
  member: Pick<Member, 'display_name' | 'product_title'>;
  silentDays?: number | null;
}

function greeting(member: Pick<Member, 'display_name'>): string {
  const name = (member.display_name || '').trim();
  // 'Member' is the fallback label for "payload carried no name" — greeting
  // a person as "Member" would be wrong, so fall back to a plain hello.
  if (!name || name === 'Member') return 'Hey there';
  return `Hey ${name.split(/\s+/)[0]}`;
}

function product(member: Pick<Member, 'product_title'>): string {
  return member.product_title?.trim() || 'your membership';
}

export function renderTemplate(kind: PlaybookKind, ctx: DraftContext): string {
  const hi = greeting(ctx.member);
  const prod = product(ctx.member);
  switch (kind) {
    case 'cancel-save':
      return [
        `${hi} — I noticed your ${prod} membership is set to end at the end of this billing period, and I wanted to reach out personally before it does.`,
        '',
        'Was there something specific that wasn\'t working for you? If it\'s the price, the timing, or you just haven\'t had a chance to use it yet, tell me — I\'d rather fix the actual problem than lose you.',
        '',
        'If you decide to stay, you don\'t need to do anything complicated — just turn off the cancellation in your Whop membership settings, or reply here and I\'ll walk you through it.',
        '',
        'Either way, thanks for being part of it.',
      ].join('\n');
    case 'failed-card':
      return [
        `${hi} — quick heads-up: the payment for your ${prod} membership didn\'t go through, and I don\'t want you to lose access over a card hiccup.`,
        '',
        'Whop retries automatically, but the fastest fix is updating your payment method: open Whop, go to your memberships, and update the card on this membership.',
        '',
        'If the card on file is fine and this looks like a mistake, reply here and we\'ll sort it out together.',
      ].join('\n');
    case 'silent-check-in': {
      const days = ctx.silentDays && ctx.silentDays > 0 ? ` in the last ${ctx.silentDays} days` : ' in a while';
      return [
        `${hi} — I haven\'t seen any activity on your ${prod} membership${days}, so I wanted to check in.`,
        '',
        '[Add 1–2 lines here about what\'s new or what they might have missed.]',
        '',
        'If you\'re stuck on anything, or you\'re not sure where to start, reply here and I\'ll point you in the right direction personally.',
      ].join('\n');
    }
  }
}

export interface DraftResult {
  draft: string;
  source: 'template' | 'gemini';
  kind: PlaybookKind;
}

const GEMINI_MODEL = 'gemini-2.5-flash';

async function enhanceWithGemini(kind: PlaybookKind, template: string, ctx: DraftContext): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const prompt = [
      'Polish this short member-retention message draft for a creator to send to one of their members.',
      'Rules: keep every fact in the draft; do not add promises, guarantees, discounts, numbers, or claims that are not in the draft;',
      'keep any bracketed [fill-in] lines exactly as they are; keep it warm, short, and human; output only the message text.',
      '',
      template,
    ].join('\n');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('').trim();
    return text && text.length > 20 ? text : null;
  } catch {
    return null; // any failure → the template stands, labeled as template
  } finally {
    clearTimeout(timer);
  }
}

export async function generateDraft(kind: PlaybookKind, ctx: DraftContext): Promise<DraftResult> {
  const template = renderTemplate(kind, ctx);
  const enhanced = await enhanceWithGemini(kind, template, ctx);
  if (enhanced) return { draft: enhanced, source: 'gemini', kind };
  return { draft: template, source: 'template', kind };
}
