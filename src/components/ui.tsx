import type { ReactNode } from 'react';
import { initials, RISK_LABELS, type RiskKind } from '../types';
import { useTheme } from '../theme';

// Shared atoms. Token classes only.

/** Dark/light theme choice. Dark is the brand default; the choice persists
 *  per browser (see ../theme.ts). */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const toLight = theme === 'dark';
  const label = toLight ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-strong bg-raised px-3 text-sm font-medium text-secondary transition-colors hover:border-bright"
    >
      <span aria-hidden>{toLight ? '☀' : '☾'}</span>
      {toLight ? 'Light' : 'Dark'}
    </button>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full border border-strong bg-raised font-semibold text-secondary"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-success text-onbright',
    churned: 'bg-muted text-onbright',
    open: 'bg-warning text-onbright',
    saved: 'bg-success text-onbright',
    recovered: 'bg-sky text-onbright',
    lost: 'bg-danger-fill text-white',
  };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${styles[status] || 'bg-muted text-onbright'}`}
    >
      {label}
    </span>
  );
}

const RISK_STYLES: Record<RiskKind, string> = {
  cancel_scheduled: 'bg-warning/15 text-warning',
  payment_failed: 'bg-danger/15 text-danger',
  silent: 'bg-sky/15 text-sky',
};

export function RiskBadge({ risk, silentDays }: { risk: RiskKind; silentDays?: number | null }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${RISK_STYLES[risk]}`}
      title={risk === 'silent' ? 'Based on webhook events only — the only activity signal ChurnShield sees' : undefined}
    >
      {RISK_LABELS[risk]}
      {risk === 'silent' && silentDays ? ` · ${silentDays}d` : ''}
    </span>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center justify-center rounded-[10px] bg-accent px-4 text-sm font-semibold text-onaccent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center justify-center rounded-[10px] border border-strong bg-raised px-4 text-sm font-medium text-primary transition-colors hover:border-bright disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-[40px] items-center justify-center rounded-[10px] px-3 text-sm font-medium ${danger ? 'text-danger' : 'text-bright'}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[14px] border border-line bg-surface p-4 ${className}`}>{children}</section>;
}

export function SectionTitle({ children, marker }: { children: ReactNode; marker?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-primary">{children}</h2>
      {marker}
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="max-w-md text-sm text-secondary">{children}</p>
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-pulse h-14 rounded-[10px] bg-raised" />
      ))}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-[10px] border-l-[3px] border-danger bg-danger/10 px-3 py-2 text-sm text-primary">
      {message}
    </div>
  );
}

export const inputClass =
  'w-full rounded-[10px] border border-strong bg-raised px-3 py-2.5 text-sm text-primary placeholder:text-muted focus:border-bright';
export const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wide text-muted';
