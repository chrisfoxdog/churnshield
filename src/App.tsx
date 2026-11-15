import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import Dashboard from './components/Dashboard';
import { SkeletonRows, SecondaryButton } from './components/ui';

interface Context {
  role: 'creator';
  creator: { display_name: string };
}

export default function App() {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<{ kind: 'auth' | 'db' | 'noaccess' | 'generic'; message?: string } | null>(null);
  const [slow, setSlow] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const slowTimer = setTimeout(() => !cancelled && setSlow(true), 3000);
    api
      .get<Context>('/api/me/context')
      .then((ctx) => {
        if (!cancelled) setContext(ctx);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setError({ kind: 'auth' });
        else if (err instanceof ApiError && err.status === 503) setError({ kind: 'db' });
        else if (err instanceof ApiError && err.status === 403) setError({ kind: 'noaccess', message: err.message });
        else setError({ kind: 'generic', message: err?.message });
      })
      .finally(() => clearTimeout(slowTimer));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (error) {
    if (error.kind === 'auth') {
      return (
        <FullView title="Sign in through Whop">
          <p className="text-sm text-secondary">
            Open ChurnShield from inside your Whop to sign in. There is no separate login — your Whop account is
            your sign-in.
          </p>
        </FullView>
      );
    }
    if (error.kind === 'db') {
      return (
        <FullView title="Database unavailable">
          <p className="text-sm text-secondary">
            ChurnShield's database is unavailable right now. Your records are safe — nothing was changed. Try again
            in a moment.
          </p>
          <SecondaryButton onClick={() => { setError(null); setReloadKey((k) => k + 1); }}>Try again</SecondaryButton>
        </FullView>
      );
    }
    if (error.kind === 'noaccess') {
      return (
        <FullView title="No access">
          <p className="text-sm text-secondary">{error.message || 'This Whop account has no ChurnShield access.'}</p>
        </FullView>
      );
    }
    return (
      <FullView title="Something went wrong">
        <p className="text-sm text-secondary">{error.message || 'ChurnShield could not load. Try again.'}</p>
        <SecondaryButton onClick={() => { setError(null); setReloadKey((k) => k + 1); }}>Try again</SecondaryButton>
      </FullView>
    );
  }

  if (!context) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <h1 className="mb-1 text-[22px] font-semibold">ChurnShield</h1>
        <p className="mb-6 text-xs text-muted">by Elite Software Studio</p>
        <SkeletonRows rows={5} />
        {slow && <p className="mt-4 text-sm text-muted">Waking the server — first load can take a few seconds.</p>}
      </div>
    );
  }

  return <Dashboard creatorName={context.creator.display_name} />;
}

function FullView({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-start justify-center gap-4 px-4 py-10">
      <div>
        <h1 className="text-[22px] font-semibold">{title}</h1>
        <p className="text-xs text-muted">ChurnShield · by Elite Software Studio</p>
      </div>
      {children}
    </main>
  );
}
