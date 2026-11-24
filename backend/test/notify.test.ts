import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../src/lib/db.js';
import { buildMessage, currentSlot, matchItems } from '../src/lib/notify-logic.js';
import type { Pusher } from '../src/lib/push.js';
import { DEFAULT_PREFS, type LibraryAccount, type Prefs } from '../src/lib/types.js';
import { runNotify } from '../src/notify.js';

const loan = (id: string, dueDate: string, accountId = 'a1') => ({
  checkoutId: id,
  title: `Book ${id}`,
  author: '',
  format: '',
  dueDate,
  status: 'OUT',
  timesRenewed: 0,
  renewable: true,
  fines: 0,
  accountId,
});
const account = (fees = 0): LibraryAccount => ({
  id: 'a1',
  displayName: 'Mine',
  maskedCard: '•••• 1234',
  fees: { total: fees, items: [] },
});
const prefs = (over: Partial<Prefs> = {}): Prefs => ({ ...DEFAULT_PREFS, ...over });

// 2026-11-24 14:00 UTC = 08:00 in Chicago (CST)
const at8Chicago = new Date('2026-11-24T14:00:00Z');

describe('slots', () => {
  it('matches the hour in the user time zone', () => {
    expect(currentSlot(prefs({ hour: 8 }), at8Chicago)).toBe('2026-11-24T08');
    expect(currentSlot(prefs({ hour: 9 }), at8Chicago)).toBeUndefined();
    expect(currentSlot(prefs({ hour: 9, timeZone: 'America/New_York' }), at8Chicago)).toBe(
      '2026-11-24T09',
    );
  });
  it('weekly only fires on the chosen weekday', () => {
    // 2026-11-24 is a Tuesday (2)
    expect(currentSlot(prefs({ frequency: 'weekly', weekday: 2 }), at8Chicago)).toBeDefined();
    expect(currentSlot(prefs({ frequency: 'weekly', weekday: 3 }), at8Chicago)).toBeUndefined();
  });
});

describe('matching', () => {
  const loans = [
    loan('over', '2026-11-20'),
    loan('today', '2026-11-24'),
    loan('soon', '2026-11-26'),
    loan('far', '2026-12-30'),
  ];
  it('defaults to overdue only', () => {
    const m = matchItems(DEFAULT_PREFS, loans, [account()], '2026-11-24');
    expect(m.overdue.map((l) => l.checkoutId)).toEqual(['over']);
    expect(m.dueToday).toHaveLength(0);
    expect(m.dueSoon).toHaveLength(0);
  });
  it('honours due date, N days before and fees triggers', () => {
    const p = prefs({ triggers: { overdue: false, onDueDate: true, daysBefore: 2, fees: true } });
    const m = matchItems(p, loans, [account(4.99)], '2026-11-24');
    expect(m.overdue).toHaveLength(0);
    expect(m.dueToday.map((l) => l.checkoutId)).toEqual(['today']);
    expect(m.dueSoon.map((l) => l.checkoutId)).toEqual(['soon']);
    expect(m.fees[0]?.total).toBe(4.99);
  });
  it('groups everything into a single message', () => {
    const m = matchItems(
      prefs({ triggers: { overdue: true, onDueDate: true, daysBefore: 3, fees: true } }),
      loans,
      [account(2)],
      '2026-11-24',
    );
    const msg = buildMessage(m);
    expect(msg.body).toContain('1 book overdue');
    expect(msg.body).toContain('$2.00 in fees');
  });
});

describe('runNotify', () => {
  const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };
  async function setup() {
    const repo = new MemoryRepo();
    await repo.putPrefs('u1', DEFAULT_PREFS);
    await repo.putAccount('u1', account());
    await repo.replaceLoans('u1', 'a1', [loan('over', '2026-11-20')]);
    await repo.putSub('u1', sub);
    return repo;
  }
  const pusher = (result: 'ok' | 'gone' = 'ok') => {
    const sent: { endpoint: string; title: string }[] = [];
    const p: Pusher = {
      async send(s, m) {
        sent.push({ endpoint: s.endpoint, title: m.title });
        return result;
      },
    };
    return { p, sent };
  };

  it('sends one notification per device and not twice in the same slot', async () => {
    const repo = await setup();
    await repo.putSub('u1', { ...sub, endpoint: 'https://push.example/2' });
    const { p, sent } = pusher();
    await runNotify({ repo, pusher: p, now: () => at8Chicago });
    await runNotify({ repo, pusher: p, now: () => at8Chicago });
    expect(sent).toHaveLength(2);
  });
  it('does not send outside the slot or when nothing matches', async () => {
    const repo = await setup();
    const { p, sent } = pusher();
    await runNotify({ repo, pusher: p, now: () => new Date('2026-11-24T15:00:00Z') });
    await repo.replaceLoans('u1', 'a1', [loan('ok', '2026-12-30')]);
    await runNotify({ repo, pusher: p, now: () => at8Chicago });
    expect(sent).toHaveLength(0);
  });
  it('removes subscriptions the push service reports gone', async () => {
    const repo = await setup();
    await runNotify({ repo, pusher: pusher('gone').p, now: () => at8Chicago });
    expect(await repo.listSubs('u1')).toHaveLength(0);
  });
  it("only mentions the owner's own devices", async () => {
    const repo = await setup();
    await repo.putPrefs('u2', DEFAULT_PREFS);
    await repo.putSub('u2', { ...sub, endpoint: 'https://push.example/other' });
    const { p, sent } = pusher();
    await runNotify({ repo, pusher: p, now: () => at8Chicago });
    expect(sent.map((s) => s.endpoint)).toEqual([sub.endpoint]);
  });
  it('alerts a linked user about the shared cards using their own settings and devices', async () => {
    const repo = new MemoryRepo();
    await repo.putAccount('owner', account());
    await repo.replaceLoans('owner', 'a1', [loan('over', '2026-11-20')]);
    await repo.putLink('owner', { partner: 'u2', owner: 'owner' });
    await repo.putLink('u2', { partner: 'owner', owner: 'owner' });
    // Only the partner has alerts on; the owner has no settings at all.
    await repo.putPrefs('u2', DEFAULT_PREFS);
    await repo.putSub('u2', { ...sub, endpoint: 'https://push.example/u2' });
    const { p, sent } = pusher();
    await runNotify({ repo, pusher: p, now: () => at8Chicago });
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/u2']);
  });
});
