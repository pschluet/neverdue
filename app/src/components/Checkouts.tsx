import { useMemo, useState } from 'react';
import { describeDue, formatAgo, formatDate, isOverdue, sortLoans, todayISO } from '../lib/loans';
import type { Account, Api, Loan, LoansResponse, RenewResult } from '../types';

export function Checkouts({
  data,
  api,
  reload,
  today = todayISO(),
}: {
  data: LoansResponse | null;
  api: Api;
  reload: () => Promise<void>;
  today?: string;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RenewResult>>({});
  const [renewing, setRenewing] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const loans = useMemo(
    () => sortLoans((data?.loans ?? []).filter((l) => !filter || l.accountId === filter)),
    [data, filter],
  );
  const lastRefreshed = accounts
    .map((a) => a.lastRefreshedAt)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);

  async function renew(loan: Loan) {
    setRenewing((s) => new Set(s).add(loan.checkoutId));
    try {
      const [r] = await api.renew(loan.accountId, [loan.checkoutId]);
      if (r) setResults((m) => ({ ...m, [loan.checkoutId]: r }));
      await reload();
    } catch (e) {
      setResults((m) => ({
        ...m,
        [loan.checkoutId]: {
          checkoutId: loan.checkoutId,
          ok: false,
          message: (e as Error).message,
        },
      }));
    } finally {
      setRenewing((s) => {
        const n = new Set(s);
        n.delete(loan.checkoutId);
        return n;
      });
    }
  }

  async function refresh() {
    setRefreshing(true);
    setNote(null);
    try {
      await api.refresh();
      setNote('Refreshing — this takes a few seconds.');
      setTimeout(() => void reload().then(() => setNote(null)), 8000);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  if (!data) return <p className="muted center-text">Loading…</p>;
  const failing = accounts.filter((a) => a.lastError);
  const fees = accounts.filter((a) => a.fees.total > 0);

  return (
    <section>
      <div className="row between">
        <h2>Checked out</h2>
        <button className="btn small" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="muted small-text">Last refreshed {formatAgo(lastRefreshed)}</p>
      {note && <div className="banner">{note}</div>}
      {failing.map((a) => (
        <div key={a.id} className="banner error">
          Couldn’t refresh {a.displayName}: {a.lastError}
        </div>
      ))}
      {fees.map((a) => (
        <FeeBanner key={a.id} account={a} />
      ))}

      {accounts.length > 1 && (
        <div className="chips" role="group" aria-label="Filter by card">
          <button
            className={filter === null ? 'chip active' : 'chip'}
            onClick={() => setFilter(null)}
          >
            All
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              className={filter === a.id ? 'chip active' : 'chip'}
              onClick={() => setFilter(a.id)}
            >
              {a.displayName}
            </button>
          ))}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="glass card muted">Add a library card on the Cards tab to get started.</div>
      ) : loans.length === 0 ? (
        <div className="glass card muted">Nothing checked out. 🎉</div>
      ) : (
        <ul className="list">
          {loans.map((l) => {
            const overdue = isOverdue(l, today);
            const r = results[l.checkoutId];
            return (
              <li
                key={l.checkoutId}
                className={overdue ? 'glass card loan overdue' : 'glass card loan'}
                data-testid="loan"
              >
                <div className="loan-main">
                  <strong>{l.title}</strong>
                  {l.author && <span className="muted">{l.author}</span>}
                  <span className="meta">
                    <span className="pill">{byId.get(l.accountId)?.displayName ?? 'Card'}</span>
                    <span className={overdue ? 'due overdue-text' : 'due'}>
                      {describeDue(l.dueDate, today)} · {formatDate(l.dueDate)}
                    </span>
                  </span>
                  {r && (
                    <span className={r.ok ? 'ok-text' : 'error-text'} role="status">
                      {r.ok ? `Renewed — now due ${formatDate(r.dueDate!)}` : r.message}
                    </span>
                  )}
                </div>
                <button
                  className="btn small"
                  disabled={!l.renewable || renewing.has(l.checkoutId)}
                  onClick={() => renew(l)}
                  aria-label={`Renew ${l.title}`}
                >
                  {renewing.has(l.checkoutId) ? '…' : 'Renew'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FeeBanner({ account }: { account: Account }) {
  return (
    <details className="banner warn">
      <summary>
        {account.displayName} owes ${account.fees.total.toFixed(2)} in fees
      </summary>
      <ul>
        {account.fees.items.map((f) => (
          <li key={f.id}>
            {f.description}
            {f.title ? ` — ${f.title}` : ''}: ${f.amount.toFixed(2)} ({f.status.toLowerCase()})
          </li>
        ))}
      </ul>
    </details>
  );
}
