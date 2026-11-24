import { useEffect, useState } from 'react';
import type { Api, Prefs, PushService } from '../types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Notifications({ api, push }: { api: Api; push: PushService }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = push.status();

  useEffect(() => {
    api.getPrefs().then(
      (r) =>
        setPrefs(
          r.prefs ?? { ...r.defaults, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        ),
      (e: Error) => setError(e.message),
    );
    push.isSubscribed().then(setSubscribed, () => undefined);
  }, [api, push]);

  async function toggle(on: boolean) {
    setError(null);
    try {
      if (on) {
        await api.addPushSubscription(await push.subscribe());
        // Save prefs now so the hourly notifier knows about this user.
        if (prefs) await api.putPrefs(prefs);
      } else {
        const endpoint = await push.unsubscribe();
        if (endpoint) await api.removePushSubscription(endpoint);
      }
      setSubscribed(on);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!prefs) return <p className="muted center-text">{error ?? 'Loading…'}</p>;
  const set = (p: Partial<Prefs>) => setPrefs({ ...prefs, ...p });
  const setTrig = (t: Partial<Prefs['triggers']>) => set({ triggers: { ...prefs.triggers, ...t } });

  return (
    <section>
      <h2>Notifications</h2>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      <div className="glass card stack">
        {status === 'needs-install' && (
          <div className="banner">
            Add Neverdue to your Home Screen first (Share → Add to Home Screen), then open it from
            there to turn on notifications.
          </div>
        )}
        {status === 'unsupported' && (
          <div className="banner">This browser doesn’t support push notifications.</div>
        )}
        <label className="switch-row">
          <span>Notify this device</span>
          <input
            type="checkbox"
            role="switch"
            checked={subscribed}
            disabled={status !== 'ready'}
            onChange={(e) => void toggle(e.target.checked)}
          />
        </label>
      </div>

      <form
        className="glass card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          setError(null);
          try {
            await api.putPrefs(prefs);
            setMsg('Saved');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h3>Notify me about</h3>
        <label className="switch-row">
          <span>Overdue books</span>
          <input
            type="checkbox"
            checked={prefs.triggers.overdue}
            onChange={(e) => setTrig({ overdue: e.target.checked })}
          />
        </label>
        <label className="switch-row">
          <span>Books due today</span>
          <input
            type="checkbox"
            checked={prefs.triggers.onDueDate}
            onChange={(e) => setTrig({ onDueDate: e.target.checked })}
          />
        </label>
        <label className="switch-row">
          <span>Books due within…</span>
          <span className="row gap">
            <input
              type="checkbox"
              aria-label="Notify before due date"
              checked={prefs.triggers.daysBefore !== null}
              onChange={(e) => setTrig({ daysBefore: e.target.checked ? 2 : null })}
            />
            {prefs.triggers.daysBefore !== null && (
              <input
                className="narrow"
                type="number"
                min={1}
                max={30}
                aria-label="Days before due"
                value={prefs.triggers.daysBefore}
                onChange={(e) =>
                  setTrig({ daysBefore: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            )}
            {prefs.triggers.daysBefore !== null && <span className="muted">day(s)</span>}
          </span>
        </label>
        <label className="switch-row">
          <span>New fees</span>
          <input
            type="checkbox"
            checked={prefs.triggers.fees}
            onChange={(e) => setTrig({ fees: e.target.checked })}
          />
        </label>

        <h3>How often</h3>
        <label>
          Frequency
          <select
            value={prefs.frequency}
            onChange={(e) => set({ frequency: e.target.value as Prefs['frequency'] })}
          >
            <option value="daily">Once a day</option>
            <option value="weekly">Once a week</option>
          </select>
        </label>
        {prefs.frequency === 'weekly' && (
          <label>
            Day
            <select
              value={prefs.weekday}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Time
          <select value={prefs.hour} onChange={(e) => set({ hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </option>
            ))}
          </select>
          <span className="muted small-text">{prefs.timeZone}</span>
        </label>
        <button className="btn primary">Save</button>
        {msg && (
          <span className="ok-text" role="status">
            {msg}
          </span>
        )}
      </form>
    </section>
  );
}
