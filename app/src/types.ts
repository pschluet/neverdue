export interface Fees {
  total: number;
  items: { id: string; title: string; description: string; amount: number; status: string }[];
}
export interface Account {
  id: string;
  displayName: string;
  maskedCard: string;
  lastRefreshedAt?: string;
  lastError?: string;
  needsAttention?: boolean;
  fees: Fees;
}
export interface Loan {
  accountId: string;
  checkoutId: string;
  title: string;
  author: string;
  format: string;
  dueDate: string;
  status: string;
  timesRenewed: number;
  renewable: boolean;
  fines: number;
}
export interface LoansResponse {
  accounts: Account[];
  loans: Loan[];
  lastManualRefreshAt?: string;
}
export interface RenewResult {
  checkoutId: string;
  ok: boolean;
  dueDate?: string;
  timesRenewed?: number;
  message?: string;
}
export interface Prefs {
  triggers: { overdue: boolean; daysBefore: number | null; onDueDate: boolean; fees: boolean };
  frequency: 'daily' | 'weekly';
  weekday: number;
  hour: number;
  timeZone: string;
}
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Me {
  email: string;
  isAdmin: boolean;
}
export interface AdminUser {
  sub: string;
  email: string;
  /** Cognito status; FORCE_CHANGE_PASSWORD means invited but never signed in. */
  status: string;
  enabled: boolean;
  createdAt?: string;
  cardCount: number;
  isSelf: boolean;
}

export interface Api {
  getMe(): Promise<Me>;
  adminListUsers(): Promise<AdminUser[]>;
  adminInviteUser(email: string): Promise<void>;
  adminSetUserEnabled(sub: string, enabled: boolean): Promise<void>;
  adminDeleteUser(sub: string): Promise<void>;
  getLoans(): Promise<LoansResponse>;
  addAccount(input: { displayName: string; username: string; pin: string }): Promise<Account>;
  updateAccount(id: string, patch: { displayName?: string; pin?: string }): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  renew(accountId: string, checkoutIds: string[]): Promise<RenewResult[]>;
  refresh(): Promise<void>;
  getPrefs(): Promise<{ prefs: Prefs | null; defaults: Prefs }>;
  putPrefs(prefs: Prefs): Promise<void>;
  addPushSubscription(sub: PushSubscriptionJson): Promise<void>;
  removePushSubscription(endpoint: string): Promise<void>;
}

export interface Auth {
  /** Returns the signed-in email, or null. */
  currentUser(): Promise<string | null>;
  requestCode(email: string): Promise<void>;
  confirmCode(code: string): Promise<void>;
  signOut(): Promise<void>;
}

export interface PushService {
  /** Whether push can work here, and if not, why. */
  status(): 'ready' | 'needs-install' | 'unsupported';
  isSubscribed(): Promise<boolean>;
  subscribe(): Promise<PushSubscriptionJson>;
  unsubscribe(): Promise<string | null>;
}

export interface Services {
  auth: Auth;
  api: Api;
  push: PushService;
}
