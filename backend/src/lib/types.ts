export interface Credentials {
  username: string;
  pin: string;
}

export interface Loan {
  checkoutId: string;
  title: string;
  author: string;
  format: string;
  dueDate: string; // YYYY-MM-DD
  status: string;
  timesRenewed: number;
  renewable: boolean;
  fines: number;
}

export interface FeeItem {
  id: string;
  title: string;
  description: string;
  amount: number;
  status: string;
}

export interface Fees {
  total: number;
  items: FeeItem[];
}

export interface RenewResult {
  checkoutId: string;
  ok: boolean;
  dueDate?: string;
  timesRenewed?: number;
  message?: string;
}

export interface LibrarySession {
  getCheckouts(): Promise<Loan[]>;
  getFees(): Promise<Fees>;
  renew(checkoutIds: string[]): Promise<RenewResult[]>;
}

export interface LibraryClient {
  /** Signs in; throws LoginError on bad credentials. */
  login(creds: Credentials): Promise<LibrarySession>;
}

export class LoginError extends Error {
  constructor(
    message: string,
    readonly kind: 'bad-credentials' | 'unavailable',
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

export interface LibraryAccount {
  id: string;
  displayName: string;
  maskedCard: string;
  libraryAccountId?: number;
  lastRefreshedAt?: string;
  lastError?: string;
  fees: Fees;
}

export interface Prefs {
  triggers: { overdue: boolean; daysBefore: number | null; onDueDate: boolean; fees: boolean };
  frequency: 'daily' | 'weekly';
  weekday: number; // 0 = Sunday
  hour: number; // 0-23 in timeZone
  timeZone: string;
}

export const DEFAULT_PREFS: Prefs = {
  triggers: { overdue: true, daysBefore: null, onDueDate: false, fees: false },
  frequency: 'daily',
  weekday: 1,
  hour: 8,
  timeZone: 'America/Chicago',
};

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
