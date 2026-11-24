import { useCallback, useEffect, useState } from 'react';
import { Accounts } from './components/Accounts';
import { Checkouts } from './components/Checkouts';
import { Notifications } from './components/Notifications';
import { SignIn } from './components/SignIn';
import type { LoansResponse, Services } from './types';

type Tab = 'checkouts' | 'accounts' | 'notifications';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'checkouts', label: 'Checkouts', icon: '📚' },
  { id: 'accounts', label: 'Cards', icon: '💳' },
  { id: 'notifications', label: 'Alerts', icon: '🔔' },
];

const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return TABS.some((t) => t.id === h) ? (h as Tab) : 'checkouts';
};

export function App({ services }: { services: Services }) {
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    services.auth.currentUser().then(setUser, () => setUser(null));
  }, [services]);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <SignIn auth={services.auth} onSignedIn={setUser} />;

  // Everything the user can see lives inside Shell, so signing out unmounts and discards it.
  return (
    <Shell
      key={user}
      services={services}
      email={user}
      onSignOut={async () => {
        await services.auth.signOut();
        setUser(null);
      }}
    />
  );
}

function Shell({
  services,
  email,
  onSignOut,
}: {
  services: Services;
  email: string;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [data, setData] = useState<LoansResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await services.api.getLoans());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [services]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Neverdue</h1>
        <button className="btn ghost small" onClick={onSignOut} title={email}>
          Sign out
        </button>
      </header>
      <main>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {tab === 'checkouts' && <Checkouts data={data} api={services.api} reload={load} />}
        {tab === 'accounts' && <Accounts data={data} api={services.api} reload={load} />}
        {tab === 'notifications' && <Notifications api={services.api} push={services.push} />}
      </main>
      <nav className="tabbar glass" aria-label="Sections">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#/${t.id}`}
            className={t.id === tab ? 'tab active' : 'tab'}
            aria-current={t.id === tab ? 'page' : undefined}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
