import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  formatDateTime,
  formatMoney,
  type DraftResponse,
  type MemberView,
  type Metrics,
  type SaveTaskView,
} from '../types';
import {
  Avatar,
  Card,
  EmptyState,
  ErrorBanner,
  GhostButton,
  PrimaryButton,
  RiskBadge,
  SecondaryButton,
  SectionTitle,
  SkeletonRows,
  StatusBadge,
  ThemeToggle,
  inputClass,
  labelClass,
} from './ui';

interface DraftState extends DraftResponse {
  memberName: string;
}

export default function Dashboard({ creatorName }: { creatorName: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tasks, setTasks] = useState<SaveTaskView[] | null>(null);
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [threshold, setThreshold] = useState<number>(14);
  const [thresholdInput, setThresholdInput] = useState<string>('14');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      api.get<{ metrics: Metrics }>('/api/creator/metrics'),
      api.get<{ tasks: SaveTaskView[] }>('/api/creator/tasks'),
      api.get<{ members: MemberView[] }>('/api/creator/members'),
      api.get<{ settings: { silent_threshold_days: number } }>('/api/creator/settings'),
    ])
      .then(([m, t, mem, s]) => {
        setMetrics(m.metrics);
        setTasks(t.tasks);
        setMembers(mem.members);
        setThreshold(s.settings.silent_threshold_days);
        setThresholdInput(String(s.settings.silent_threshold_days));
      })
      .catch((e) => setError(e.message || 'Could not load your dashboard.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openTasks = (tasks || []).filter((t) => t.status === 'open');
  const closedTasks = (tasks || []).filter((t) => t.status !== 'open').slice(0, 10);
  const hasAnyData = (members?.length || 0) > 0;

  async function resolveTask(task: SaveTaskView, outcome: 'saved' | 'lost') {
    setResolving(task.id);
    try {
      await api.post(`/api/creator/tasks/${task.id}/resolve`, { outcome });
      load();
    } catch (e: any) {
      setError(e.message || 'Could not update that task.');
    } finally {
      setResolving(null);
    }
  }

  async function draftForTask(task: SaveTaskView) {
    setDraftBusy(task.id);
    setCopied(false);
    try {
      const r = await api.post<DraftResponse>('/api/creator/playbooks/draft', { task_id: task.id });
      setDraft({ ...r, memberName: task.member_display_name });
    } catch (e: any) {
      setError(e.message || 'Could not generate a draft.');
    } finally {
      setDraftBusy(null);
    }
  }

  async function draftForMember(member: MemberView) {
    setDraftBusy(member.id);
    setCopied(false);
    try {
      const r = await api.post<DraftResponse>('/api/creator/playbooks/draft', {
        member_id: member.id,
        kind: 'silent-check-in',
      });
      setDraft({ ...r, memberName: member.display_name });
    } catch (e: any) {
      setError(e.message || 'Could not generate a draft.');
    } finally {
      setDraftBusy(null);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.draft);
      setCopied(true);
    } catch {
      setError('Copy failed — select the draft text and copy it manually.');
    }
  }

  async function saveThreshold() {
    const days = Number(thresholdInput);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      setSettingsMsg('Enter a whole number of days between 1 and 90.');
      return;
    }
    try {
      await api.patch('/api/creator/settings', { silent_threshold_days: days });
      setSettingsMsg(`Silent radar set to ${days} days.`);
      load();
    } catch (e: any) {
      setSettingsMsg(e.message || 'Could not save that setting.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-4 md:pt-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold">
            ChurnShield <span className="text-bright">🛡</span>
          </h1>
          <p className="text-xs text-muted">by Elite Software Studio · {creatorName}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SecondaryButton onClick={load}>Refresh</SecondaryButton>
        </div>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {!hasAnyData && metrics !== null ? (
        <Card className="mb-5">
          <EmptyState>
            <strong className="text-primary">No member events yet.</strong>
            <br />
            ChurnShield watches your store through its Whop webhook. When members join, schedule a cancellation, or
            a payment fails, their records and save tasks will appear here automatically. Every number on this page
            is computed from your real events — nothing is estimated or filled in.
          </EmptyState>
        </Card>
      ) : (
        <>
          {/* Metrics — computed from real records only */}
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Active members" value={metrics ? String(metrics.active_members) : '…'} />
            <MetricCard label="At risk" value={metrics ? String(metrics.at_risk_count) : '…'} tone="warning" />
            <MetricCard
              label="Dollars at risk"
              value={metrics ? formatMoney(metrics.dollars_at_risk, metrics.currency) : '…'}
              tone="warning"
            />
            <MetricCard label="Members saved" value={metrics ? String(metrics.saved_count) : '…'} tone="success" />
            <MetricCard
              label="Dollars saved"
              value={metrics ? formatMoney(metrics.dollars_saved, metrics.currency) : '…'}
              tone="success"
            />
            <MetricCard label="Churned" value={metrics ? String(metrics.churned_count) : '…'} />
          </div>
          <p className="-mt-3 mb-5 text-xs text-muted">
            Dollars at risk and dollars saved sum the plan amounts Whop reported for those members. Members whose
            plan amount wasn't reported count in the headcounts but add nothing to the dollar totals.
          </p>
        </>
      )}

      {/* Save inbox */}
      <Card className="mb-5">
        <SectionTitle marker={<span className="text-xs text-muted">{openTasks.length} open</span>}>
          Save inbox
        </SectionTitle>
        {tasks === null ? (
          <SkeletonRows rows={3} />
        ) : openTasks.length === 0 ? (
          <EmptyState>
            No open save tasks. When a member schedules a cancellation or a payment fails, a task opens here with a
            message draft ready to copy and send.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {openTasks.map((t) => (
              <li
                key={t.id}
                className="flex flex-col gap-3 rounded-[10px] border border-line bg-raised/40 px-3 py-3 md:flex-row md:items-center"
              >
                <Avatar name={t.member_display_name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">
                    {t.member_display_name}
                    {t.member_product_title && <span className="font-normal text-secondary"> · {t.member_product_title}</span>}
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <RiskBadge risk={t.kind} />
                    <span>{formatMoney(t.effective_amount, t.currency)} plan</span>
                    <span>opened {formatDateTime(t.created_at)}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <SecondaryButton onClick={() => draftForTask(t)} disabled={draftBusy === t.id}>
                    {draftBusy === t.id ? 'Drafting…' : 'Draft message'}
                  </SecondaryButton>
                  <PrimaryButton onClick={() => resolveTask(t, 'saved')} disabled={resolving === t.id}>
                    Mark saved
                  </PrimaryButton>
                  <GhostButton danger onClick={() => resolveTask(t, 'lost')}>
                    Mark lost
                  </GhostButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        {closedTasks.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recently closed</p>
            <ul className="flex flex-col gap-1.5">
              {closedTasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm text-secondary">
                  <StatusBadge status={t.status} />
                  <span className="font-medium text-primary">{t.member_display_name}</span>
                  <RiskBadge risk={t.kind} />
                  <span className="text-xs text-muted">
                    {formatMoney(t.effective_amount, t.currency)} · closed {formatDateTime(t.closed_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Playbook draft viewer */}
      {draft && (
        <Card className="mb-5">
          <SectionTitle
            marker={
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  draft.source === 'gemini' ? 'bg-bright/10 text-bright' : 'bg-raised text-secondary'
                }`}
              >
                {draft.source === 'gemini' ? 'AI-enhanced draft' : 'Template draft'}
              </span>
            }
          >
            Playbook draft — {draft.memberName}
          </SectionTitle>
          <pre className="whitespace-pre-wrap rounded-[10px] border border-line bg-app p-3 font-sans text-sm leading-relaxed text-primary">
            {draft.draft}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={copyDraft}>{copied ? 'Copied ✓' : 'Copy draft'}</PrimaryButton>
            <GhostButton onClick={() => setDraft(null)}>Close</GhostButton>
          </div>
          <p className="mt-2 text-xs text-muted">
            {draft.note} Edit it before sending — it's a starting point, not an auto-send.
          </p>
        </Card>
      )}

      {/* Members */}
      <Card className="mb-5">
        <SectionTitle marker={<span className="text-xs text-muted">{members?.length ?? 0} records</span>}>
          Members
        </SectionTitle>
        {members === null ? (
          <SkeletonRows rows={4} />
        ) : members.length === 0 ? (
          <EmptyState>
            No member records yet — connect your Whop store's webhook and records appear as events arrive.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3 font-medium">Member</th>
                  <th className="py-2 pr-3 font-medium">Product</th>
                  <th className="py-2 pr-3 font-medium">Plan</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Risks</th>
                  <th className="py-2 font-medium">Last event</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b border-line/60 align-top">
                    <td className="py-2.5 pr-3">
                      <span className="flex items-center gap-2">
                        <Avatar name={m.display_name} size={28} />
                        <span className="font-medium">{m.display_name}</span>
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-secondary">{m.product_title || '—'}</td>
                    <td className="py-2.5 pr-3 text-secondary">{formatMoney(m.plan_amount, m.plan_currency)}</td>
                    <td className="py-2.5 pr-3">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {m.risks_all.length === 0 && <span className="text-xs text-muted">—</span>}
                        {m.risks_all.map((r) => (
                          <RiskBadge key={r} risk={r} silentDays={m.silent_days} />
                        ))}
                        {m.risks_all.includes('silent') && (
                          <button
                            type="button"
                            onClick={() => draftForMember(m)}
                            disabled={draftBusy === m.id}
                            className="text-xs font-medium text-bright underline-offset-2 hover:underline"
                          >
                            {draftBusy === m.id ? 'Drafting…' : 'Check-in draft'}
                          </button>
                        )}
                      </span>
                      {m.risks_all.includes('silent') && (
                        <span className="mt-1 block text-[11px] text-muted">
                          No membership events in {m.silent_days}+ days — webhook events are the only activity
                          signal ChurnShield sees.
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-secondary">
                      {formatDateTime(m.last_event_at)}
                      <span className="block text-[11px] text-muted">{m.last_event_type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Settings */}
      <Card>
        <SectionTitle>Settings</SectionTitle>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <label className={labelClass} htmlFor="silent-days">
              Silent after (days, currently {threshold})
            </label>
            <input
              id="silent-days"
              className={inputClass}
              type="number"
              min={1}
              max={90}
              value={thresholdInput}
              onChange={(e) => setThresholdInput(e.target.value)}
            />
          </div>
          <SecondaryButton onClick={saveThreshold}>Save</SecondaryButton>
        </div>
        <p className="mt-2 text-xs text-muted">
          An active member is flagged silent when no membership or payment event has arrived for this many days.
          Webhook events are the only activity signal in this version — a member can be active in your community
          without producing one.
        </p>
        {settingsMsg && <p className="mt-2 text-sm text-secondary">{settingsMsg}</p>}
      </Card>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'success' }) {
  const valueClass = tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-primary';
  return (
    <div className="rounded-[14px] border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
