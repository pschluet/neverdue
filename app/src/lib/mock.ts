import type {
  Account,
  AdminUser,
  Api,
  Auth,
  Loan,
  Prefs,
  PushService,
  RenewResult,
  Services,
} from '../types';

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const loan = (
  accountId: string,
  n: number,
  title: string,
  author: string,
  days: number,
  extra: Partial<Loan> = {},
): Loan => ({
  accountId,
  checkoutId: `c${n}`,
  title,
  author,
  format: 'Book',
  dueDate: iso(days),
  status: 'OUT',
  timesRenewed: 0,
  renewable: true,
  fines: 0,
  ...extra,
});

/** In-memory fake backend so the UI can be developed and demoed without AWS. */
export function createMockServices(): Services {
  let user: string | null = null;
  const accounts: Account[] = [
    {
      id: 'a1',
      displayName: 'Paul',
      maskedCard: '•••• 4821',
      lastRefreshedAt: new Date().toISOString(),
      fees: { total: 0, items: [] },
    },
    {
      id: 'a2',
      displayName: "Kids' card",
      maskedCard: '•••• 7730',
      lastRefreshedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      fees: {
        total: 4.99,
        items: [
          {
            id: 'f1',
            title: 'Debbie the Duckling Fairy',
            description: 'Replacement Cost',
            amount: 4.99,
            status: 'UNPAID',
          },
        ],
      },
    },
    {
      id: 'a3',
      displayName: 'Spouse',
      maskedCard: '•••• 1096',
      lastError: 'Sign-in failed. Check the card number and PIN.',
      needsAttention: true,
      fees: { total: 0, items: [] },
    },
  ];
  let loans: Loan[] = [
    loan('a1', 1, 'The Overstory: A Novel', 'Richard Powers', -4),
    loan('a2', 2, "Ember's End", 'Sara Wren', -1, { timesRenewed: 2 }),
    loan('a2', 3, 'Ember Rising', 'Sara Wren', 0),
    loan('a1', 4, 'Braiding Sweetgrass', 'Robin Wall Kimmerer', 6),
    loan('a2', 5, 'Dragons Love Tacos', 'Adam Rubin', 9),
    loan('a1', 6, 'Project Hail Mary', 'Andy Weir', 17, { renewable: false }),
  ];
  let prefs: Prefs | null = null;
  const defaults: Prefs = {
    triggers: { overdue: true, daysBefore: null, onDueDate: false, fees: false },
    frequency: 'daily',
    weekday: 1,
    hour: 8,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  let subscribed = false;
  let pendingEmail = '';
  const ADMIN = 'paul@paulschlueter.com';
  const day = 86400000;
  let users: AdminUser[] = [
    {
      sub: 'u-paul',
      email: ADMIN,
      status: 'CONFIRMED',
      enabled: true,
      createdAt: new Date(Date.now() - 90 * day).toISOString(),
      cardCount: 2,
      isSelf: true,
    },
    {
      sub: 'u-sam',
      email: 'sam@example.com',
      status: 'CONFIRMED',
      enabled: true,
      createdAt: new Date(Date.now() - 30 * day).toISOString(),
      cardCount: 1,
      isSelf: false,
    },
    {
      sub: 'u-alex',
      email: 'alex@example.com',
      status: 'FORCE_CHANGE_PASSWORD',
      enabled: true,
      createdAt: new Date(Date.now() - 2 * day).toISOString(),
      cardCount: 0,
      isSelf: false,
    },
    {
      sub: 'u-riley',
      email: 'riley@example.com',
      status: 'CONFIRMED',
      enabled: false,
      createdAt: new Date(Date.now() - 60 * day).toISOString(),
      cardCount: 3,
      isSelf: false,
    },
  ];
  const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 250));

  const auth: Auth = {
    currentUser: async () => user,
    requestCode: async (email) => void ((pendingEmail = email.trim()), await wait(email)),
    confirmCode: async (code) => {
      await wait(0);
      if (code !== '123456') throw new Error('That code was not accepted (mock code is 123456)');
      user = pendingEmail || 'you@example.com';
    },
    signOut: async () => void (user = null),
  };
  const api: Api = {
    getMe: () => wait({ email: user ?? '', isAdmin: user?.toLowerCase() === ADMIN }),
    adminListUsers: () =>
      wait(
        structuredClone(users)
          .map((u) => ({ ...u, isSelf: u.email.toLowerCase() === user?.toLowerCase() }))
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),
    adminInviteUser: async (email) => {
      const e = email.trim().toLowerCase();
      if (users.some((u) => u.email === e)) throw new Error('That user already exists');
      users.push({
        sub: `u-${Date.now()}`,
        email: e,
        status: 'FORCE_CHANGE_PASSWORD',
        enabled: true,
        createdAt: new Date().toISOString(),
        cardCount: 0,
        isSelf: false,
      });
      await wait(0);
    },
    adminSetUserEnabled: async (sub, enabled) => {
      const u = users.find((x) => x.sub === sub);
      if (u) u.enabled = enabled;
      await wait(0);
    },
    adminDeleteUser: async (sub) => {
      users = users.filter((u) => u.sub !== sub);
      await wait(0);
    },
    adminLinkUsers: async (sub, partner) => {
      const a = users.find((u) => u.sub === sub)!;
      const b = users.find((u) => u.sub === partner)!;
      if (a.linkedWith || b.linkedWith) throw new Error('Unlink that user first');
      // Cards merge under whoever has more; both then show the combined count.
      const total = a.cardCount + b.cardCount;
      a.cardCount = b.cardCount = total;
      a.linkedWith = { sub: b.sub, email: b.email };
      b.linkedWith = { sub: a.sub, email: a.email };
      await wait(0);
    },
    adminUnlinkUser: async (sub, keeper) => {
      const a = users.find((u) => u.sub === sub)!;
      const b = users.find((u) => u.sub === a.linkedWith?.sub)!;
      const total = a.cardCount;
      for (const u of [a, b]) {
        u.cardCount = u.sub === keeper ? total : 0;
        u.linkedWith = null;
      }
      await wait(0);
    },
    getLoans: () => wait({ accounts: structuredClone(accounts), loans: structuredClone(loans) }),
    addAccount: async (input) => {
      const a: Account = {
        id: `a${Date.now()}`,
        displayName: input.displayName,
        maskedCard: `•••• ${input.username.slice(-4)}`,
        fees: { total: 0, items: [] },
        lastRefreshedAt: new Date().toISOString(),
      };
      accounts.push(a);
      return wait(a);
    },
    updateAccount: async (id, patch) => {
      const a = accounts.find((x) => x.id === id)!;
      if (patch.displayName) a.displayName = patch.displayName;
      if (patch.pin) {
        a.lastError = undefined;
        a.needsAttention = undefined;
      }
      return wait({ ...a });
    },
    deleteAccount: async (id) => {
      accounts.splice(
        accounts.findIndex((a) => a.id === id),
        1,
      );
      loans = loans.filter((l) => l.accountId !== id);
      await wait(0);
    },
    renew: async (_id, ids) => {
      const results: RenewResult[] = ids.map((checkoutId) => {
        const l = loans.find((x) => x.checkoutId === checkoutId)!;
        if (l.timesRenewed >= 2) {
          return {
            checkoutId,
            ok: false,
            message: 'Item has exceeded renewal limit, not allowed to renew',
          };
        }
        l.timesRenewed += 1;
        const d = new Date(l.dueDate + 'T00:00:00');
        d.setDate(d.getDate() + 21);
        l.dueDate = iso(
          Math.round((d.getTime() - new Date(iso(0) + 'T00:00:00').getTime()) / 86400000),
        );
        return { checkoutId, ok: true, dueDate: l.dueDate, timesRenewed: l.timesRenewed };
      });
      return wait(results);
    },
    refresh: async () => void (await wait(0)),
    getPrefs: () => wait({ prefs, defaults }),
    putPrefs: async (p) => void ((prefs = p), await wait(0)),
    addPushSubscription: async () => void (await wait(0)),
    removePushSubscription: async () => void (await wait(0)),
  };
  const push: PushService = {
    status: () => 'ready',
    isSubscribed: async () => subscribed,
    subscribe: async () => {
      subscribed = true;
      return { endpoint: 'https://mock.push/endpoint', keys: { p256dh: 'p', auth: 'a' } };
    },
    unsubscribe: async () => {
      subscribed = false;
      return 'https://mock.push/endpoint';
    },
  };
  return { auth, api, push };
}
