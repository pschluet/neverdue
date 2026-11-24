import type { Loan } from '../types';

/** Today's date in the user's local time zone as YYYY-MM-DD. */
export function todayISO(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** Days until due: negative when overdue. */
export const daysUntil = (due: string, today: string) => dayNumber(due) - dayNumber(today);
export const isOverdue = (loan: Pick<Loan, 'dueDate'>, today: string) => loan.dueDate < today;

/** Soonest due date first, so overdue items naturally come first. */
export function sortLoans(loans: Loan[]): Loan[] {
  return [...loans].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title),
  );
}

export function describeDue(due: string, today: string): string {
  const d = daysUntil(due, today);
  if (d < -1) return `${-d} days overdue`;
  if (d === -1) return '1 day overdue';
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `Due in ${d} days`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatAgo(iso: string | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}
