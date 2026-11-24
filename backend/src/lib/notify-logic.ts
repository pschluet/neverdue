import type { FeeItem, LibraryAccount, Prefs } from './types.js';
import type { StoredLoan } from './db.js';

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
}

export function localParts(now: Date, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    weekday: days.indexOf(String(p.weekday)),
  };
}

export const localDate = (now: Date, tz: string): string => {
  const p = localParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** Returns an id for the current delivery slot if this hour is one for the user, else undefined. */
export function currentSlot(prefs: Prefs, now: Date): string | undefined {
  const p = localParts(now, prefs.timeZone);
  if (p.hour !== prefs.hour) return undefined;
  if (prefs.frequency === 'weekly' && p.weekday !== prefs.weekday) return undefined;
  return `${localDate(now, prefs.timeZone)}T${String(p.hour).padStart(2, '0')}`;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

export interface Matches {
  overdue: StoredLoan[];
  dueToday: StoredLoan[];
  dueSoon: StoredLoan[];
  fees: { account: LibraryAccount; total: number }[];
}

export function matchItems(
  prefs: Prefs,
  loans: StoredLoan[],
  accounts: LibraryAccount[],
  today: string,
): Matches {
  const t = prefs.triggers;
  const out: Matches = { overdue: [], dueToday: [], dueSoon: [], fees: [] };
  for (const l of loans) {
    const diff = dayNumber(l.dueDate) - dayNumber(today);
    if (diff < 0 && t.overdue) out.overdue.push(l);
    else if (diff === 0 && t.onDueDate) out.dueToday.push(l);
    else if (diff > 0 && t.daysBefore !== null && diff <= t.daysBefore) out.dueSoon.push(l);
  }
  if (t.fees) {
    for (const account of accounts) {
      if (account.fees.total > 0) out.fees.push({ account, total: account.fees.total });
    }
  }
  return out;
}

export const hasMatches = (m: Matches) =>
  m.overdue.length + m.dueToday.length + m.dueSoon.length + m.fees.length > 0;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One grouped message for a user. */
export function buildMessage(m: Matches): { title: string; body: string } {
  const parts: string[] = [];
  if (m.overdue.length) parts.push(`${plural(m.overdue.length, 'book')} overdue`);
  if (m.dueToday.length) parts.push(`${plural(m.dueToday.length, 'book')} due today`);
  if (m.dueSoon.length) parts.push(`${plural(m.dueSoon.length, 'book')} due soon`);
  if (m.fees.length) {
    const total = m.fees.reduce((s, f) => s + f.total, 0);
    parts.push(`$${total.toFixed(2)} in fees`);
  }
  const titles = [...m.overdue, ...m.dueToday, ...m.dueSoon].map((l) => l.title);
  const shown = titles.slice(0, 3).join(', ');
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
  const title = m.overdue.length ? 'Library books overdue' : 'Library reminder';
  return {
    title,
    body: [parts.join(' · '), shown && `${shown}${more}`].filter(Boolean).join('\n'),
  };
}

export type { FeeItem };
