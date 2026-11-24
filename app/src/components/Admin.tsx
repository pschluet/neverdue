import { useCallback, useEffect, useState } from 'react';
import type { AdminUser, Api } from '../types';

const statusPill = (u: AdminUser) => {
  if (!u.enabled) return <span className="pill off">Disabled</span>;
  if (u.status === 'FORCE_CHANGE_PASSWORD')
    return <span className="pill warn">Not signed in yet</span>;
  return <span className="pill">Active</span>;
};

const joined = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

export function Admin({ api }: { api: Api }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.adminListUsers());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <section>
      <h2>Users</h2>
      <p className="muted small-text">
        Invited people sign in with an emailed code. Deleting a user also removes their library
        cards and stored PINs.
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {users === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="list">
          {users.map((u) => (
            <li key={u.sub} className="glass card" data-testid="user">
              <div>
                <strong className="user-email">{u.email}</strong>
                {u.isSelf && <span className="muted small-text"> (you)</span>}
                <div className="meta">
                  {statusPill(u)}
                  <span className="muted">
                    {u.cardCount} {u.cardCount === 1 ? 'card' : 'cards'}
                    {u.createdAt && ` · joined ${joined(u.createdAt)}`}
                  </span>
                </div>
              </div>
              {!u.isSelf && (
                <div className="row gap">
                  <button
                    className="btn small"
                    onClick={() => void run(() => api.adminSetUserEnabled(u.sub, !u.enabled))}
                  >
                    {u.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn small danger"
                    onClick={() => {
                      if (window.confirm(`Delete ${u.email} and all their data?`))
                        void run(() => api.adminDeleteUser(u.sub));
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Invite api={api} run={run} />
    </section>
  );
}

function Invite({ api, run }: { api: Api; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="glass card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await run(() => api.adminInviteUser(email))) setEmail('');
        setBusy(false);
      }}
    >
      <h3>Invite a user</h3>
      <label>
        Email
        <input
          required
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          placeholder="friend@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button className="btn primary" disabled={busy}>
        {busy ? 'Inviting…' : 'Invite'}
      </button>
    </form>
  );
}
