import { useState } from 'react';
import { formatAgo } from '../lib/loans';
import type { Account, Api, LoansResponse } from '../types';

export function Accounts({
  data,
  api,
  reload,
}: {
  data: LoansResponse | null;
  api: Api;
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <section>
      <h2>Library cards</h2>
      <p className="muted small-text">
        Card numbers and PINs are stored encrypted and are never shown again.
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <ul className="list">
        {(data?.accounts ?? []).map((a) => (
          <AccountRow key={a.id} account={a} api={api} run={run} />
        ))}
      </ul>
      <AddAccount api={api} run={run} />
    </section>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

function AccountRow({ account, api, run }: { account: Account; api: Api; run: Run }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'pin'>('view');
  const [value, setValue] = useState('');

  return (
    <li className="glass card">
      <div className="row between">
        <div>
          <strong>{account.displayName}</strong>
          <div className="muted small-text">
            {account.maskedCard} · refreshed {formatAgo(account.lastRefreshedAt)}
          </div>
          {account.needsAttention ? (
            <div className="banner error" role="alert">
              Paused: the library rejected this card’s sign-in. Neverdue won’t try again until you
              update the PIN.
            </div>
          ) : (
            account.lastError && <div className="error-text small-text">{account.lastError}</div>
          )}
        </div>
      </div>
      {mode === 'view' ? (
        <div className="row gap">
          <button
            className="btn small"
            onClick={() => {
              setValue(account.displayName);
              setMode('rename');
            }}
          >
            Rename
          </button>
          <button
            className={account.needsAttention ? 'btn small primary' : 'btn small'}
            onClick={() => {
              setValue('');
              setMode('pin');
            }}
          >
            Update PIN
          </button>
          <button
            className="btn small danger"
            onClick={() => {
              if (window.confirm(`Remove ${account.displayName}?`))
                void run(() => api.deleteAccount(account.id));
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api.updateAccount(
                account.id,
                mode === 'rename' ? { displayName: value } : { pin: value },
              ),
            ).then((ok) => ok && setMode('view'));
          }}
        >
          <input
            aria-label={mode === 'rename' ? 'New name' : 'New PIN'}
            type={mode === 'pin' ? 'password' : 'text'}
            autoComplete="off"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn small primary">Save</button>
          <button type="button" className="btn small ghost" onClick={() => setMode('view')}>
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

function AddAccount({ api, run }: { api: Api; run: Run }) {
  const empty = { displayName: '', username: '', pin: '' };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="glass card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await run(() => api.addAccount(form))) setForm(empty);
        setBusy(false);
      }}
    >
      <h3>Add a card</h3>
      <label>
        Nickname
        <input
          required
          maxLength={40}
          placeholder="Kids’ card"
          value={form.displayName}
          onChange={set('displayName')}
        />
      </label>
      <label>
        Card number or username
        <input required autoComplete="off" value={form.username} onChange={set('username')} />
      </label>
      <label>
        PIN or password
        <input required type="password" autoComplete="off" value={form.pin} onChange={set('pin')} />
      </label>
      <button className="btn primary" disabled={busy}>
        {busy ? 'Checking with the library…' : 'Add card'}
      </button>
    </form>
  );
}
