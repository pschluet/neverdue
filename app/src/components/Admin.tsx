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
  const [linking, setLinking] = useState<string | null>(null);

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
        cards and stored PINs. Linked users share the same cards and checkouts but keep their own
        alert settings.
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <Invite api={api} run={run} />
      {users === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="list">
          {users.map((u) => (
            <li key={u.sub} className="glass card stack" data-testid="user">
              <div className="row gap between">
                <div>
                  <strong className="user-email">{u.email}</strong>
                  {u.isSelf && <span className="muted small-text"> (you)</span>}
                  <div className="meta">
                    {statusPill(u)}
                    {u.linkedWith && (
                      <span className="pill" data-testid="linked">
                        Linked with {u.linkedWith.email}
                      </span>
                    )}
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
                        const keep = u.linkedWith
                          ? ` Their cards stay with ${u.linkedWith.email}.`
                          : '';
                        if (window.confirm(`Delete ${u.email} and all their data?${keep}`))
                          void run(() => api.adminDeleteUser(u.sub));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {linking === u.sub ? (
                u.linkedWith ? (
                  <Unlink
                    user={u}
                    onCancel={() => setLinking(null)}
                    onSubmit={async (keeper) => {
                      if (await run(() => api.adminUnlinkUser(u.sub, keeper))) setLinking(null);
                    }}
                  />
                ) : (
                  <LinkForm
                    user={u}
                    candidates={users.filter((o) => o.sub !== u.sub && !o.linkedWith)}
                    onCancel={() => setLinking(null)}
                    onSubmit={async (partner) => {
                      if (await run(() => api.adminLinkUsers(u.sub, partner))) setLinking(null);
                    }}
                  />
                )
              ) : (
                <button className="btn small" onClick={() => setLinking(u.sub)}>
                  {u.linkedWith ? 'Unlink…' : 'Link to another user…'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
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

function LinkForm({
  user,
  candidates,
  onCancel,
  onSubmit,
}: {
  user: AdminUser;
  candidates: AdminUser[];
  onCancel: () => void;
  onSubmit: (partner: string) => Promise<void>;
}) {
  const [partner, setPartner] = useState(candidates[0]?.sub ?? '');
  if (candidates.length === 0) {
    return (
      <div className="stack">
        <p className="muted small-text">No other unlinked users to link {user.email} to.</p>
        <button className="btn small" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(partner);
      }}
    >
      <label>
        Link {user.email} with
        <select value={partner} onChange={(e) => setPartner(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.sub} value={c.sub}>
              {c.email}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small-text">
        Both users will see all of both users&apos; cards and checkouts. Each keeps their own alert
        settings.
      </p>
      <div className="row gap">
        <button className="btn primary small">Link</button>
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Unlink({
  user,
  onCancel,
  onSubmit,
}: {
  user: AdminUser;
  onCancel: () => void;
  onSubmit: (keeper: string) => Promise<void>;
}) {
  const partner = user.linkedWith!;
  const [keeper, setKeeper] = useState(user.sub);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(keeper);
      }}
    >
      <fieldset className="stack">
        <legend>Who keeps the cards?</legend>
        {[
          { sub: user.sub, email: user.email },
          { sub: partner.sub, email: partner.email },
        ].map((o) => (
          <label key={o.sub} className="row gap">
            <input
              type="radio"
              name={`keeper-${user.sub}`}
              checked={keeper === o.sub}
              onChange={() => setKeeper(o.sub)}
            />
            {o.email}
          </label>
        ))}
      </fieldset>
      <p className="muted small-text">The other user will start with no cards.</p>
      <div className="row gap">
        <button className="btn primary small">Unlink</button>
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
