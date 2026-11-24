import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, usePrefs } from '../lib/queries';
import type { Api, Prefs, PushService } from '../types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Notifications({ api, push }: { api: Api; push: PushService }) {
  const queryClient = useQueryClient();
  const server = usePrefs(api);
  // Unsaved edits live here; until the first edit the form shows the cached server value.
  const [draft, setDraft] = useState<Prefs | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // What's typed in the days field, so it can be empty mid-edit; null shows the saved value.
  const [daysText, setDaysText] = useState<string | null>(null);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? server.error?.message ?? null;
  const status = push.status();

  const saved = server.data && {
    ...server.data,
    prefs: server.data.prefs ?? {
      ...server.data.defaults,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
  const prefs = draft ?? saved?.prefs ?? null;
  const setPrefs = setDraft;

  // Remember what was saved so coming back to this tab shows it without a refetch.
  const putPrefs = async (p: Prefs) => {
    await api.putPrefs(p);
    if (saved) queryClient.setQueryData(keys.prefs, { ...saved, prefs: p });
  };

  useEffect(() => {
    push.isSubscribed().then(setSubscribed, () => undefined);
  }, [push]);

  async function toggle(on: boolean) {
    setError(null);
    try {
      if (on) {
        await api.addPushSubscription(await push.subscribe());
        // Save prefs now so the hourly notifier knows about this user.
        if (prefs) await putPrefs(prefs);
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
            await putPrefs(prefs);
            setDraft(null);
            setDaysText(null);
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
          <span>Books due soon</span>
          <input
            type="checkbox"
            aria-label="Notify before due date"
            checked={prefs.triggers.daysBefore !== null}
            onChange={(e) => {
              setDaysText(null);
              setTrig({ daysBefore: e.target.checked ? 2 : null });
            }}
          />
        </label>
        {prefs.triggers.daysBefore !== null && (
          <div className="sub-row">
            <span>Within</span>
            <input
              className="narrow"
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              aria-label="Days before due"
              value={daysText ?? String(prefs.triggers.daysBefore)}
              onChange={(e) => {
                const v = e.target.value;
                setDaysText(v);
                const n = parseInt(v, 10);
                if (Number.isFinite(n) && n > 0) setTrig({ daysBefore: Math.min(30, n) });
              }}
              onBlur={() => setDaysText(null)}
            />
            <span>{prefs.triggers.daysBefore === 1 ? 'day' : 'days'}</span>
          </div>
        )}
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
