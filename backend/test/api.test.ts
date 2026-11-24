import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApi, REFRESH_COOLDOWN_MS } from '../src/api.js';
import { MemoryCredentialStore } from '../src/lib/credentials.js';
import { MemoryRepo } from '../src/lib/db.js';
import { MemoryUserDirectory } from '../src/lib/users.js';
import { runScrape } from '../src/scrape.js';
import {
  DEFAULT_PREFS,
  type LibraryClient,
  type LibrarySession,
  LoginError,
} from '../src/lib/types.js';

const SECRET_PIN = 'sekret-pin-9876';

function session(): LibrarySession {
  return {
    getCheckouts: async () => [
      {
        checkoutId: 'c1',
        title: 'T',
        author: '',
        format: '',
        dueDate: '2026-12-01',
        status: 'OUT',
        timesRenewed: 0,
        renewable: true,
        fines: 0,
      },
    ],
    getFees: async () => ({ total: 0, items: [] }),
    renew: async (ids) =>
      ids.map((checkoutId) => ({ checkoutId, ok: true, dueDate: '2026-12-15', timesRenewed: 1 })),
  };
}
const library: LibraryClient = {
  async login({ pin }) {
    if (pin === 'wrong')
      throw new LoginError('The card number or PIN is incorrect', 'bad-credentials');
    return session();
  },
};

function setup() {
  const repo = new MemoryRepo();
  const creds = new MemoryCredentialStore();
  const users = new MemoryUserDirectory();
  const invoked: unknown[] = [];
  let clock = new Date('2026-11-24T12:00:00Z');
  const api = createApi({
    repo,
    creds,
    library,
    users,
    adminEmails: ['Admin@Example.com'],
    invokeScraper: async (p) => void invoked.push(p),
    now: () => clock,
  });
  const call = async (
    sub: string,
    method: string,
    path: string,
    body?: unknown,
    email = `${sub}@example.com`,
  ) => {
    const res = (await api({
      rawPath: path,
      body: body === undefined ? undefined : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: { http: { method }, authorizer: { jwt: { claims: { sub, email } } } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer)) as {
      statusCode: number;
      body: string;
    };
    return { status: res.statusCode, text: res.body, json: JSON.parse(res.body || 'null') };
  };
  return {
    repo,
    creds,
    users,
    invoked,
    call,
    tick: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}

const newAccount = { displayName: 'Kids', username: '21234000011234', pin: SECRET_PIN };

describe('api', () => {
  it('rejects requests without a verified sub', async () => {
    const { call } = setup();
    expect((await call('', 'GET', '/api/loans')).status).toBe(401);
  });

  it('rejects bad library credentials without storing anything', async () => {
    const { call, creds, repo } = setup();
    const r = await call('u1', 'POST', '/api/accounts', { ...newAccount, pin: 'wrong' });
    expect(r.status).toBe(400);
    expect(creds.map.size).toBe(0);
    expect(await repo.listAccounts('u1')).toHaveLength(0);
  });

  it('adds an account, masks the card and never returns credentials', async () => {
    const { call, creds } = setup();
    const add = await call('u1', 'POST', '/api/accounts', newAccount);
    expect(add.status).toBe(201);
    expect(add.json.account.maskedCard).toBe('•••• 1234');
    const list = await call('u1', 'GET', '/api/loans');
    expect(list.json.loans).toHaveLength(1);
    for (const text of [add.text, list.text]) {
      expect(text).not.toContain(SECRET_PIN);
      expect(text).not.toContain('21234000011234');
    }
    expect(creds.map.size).toBe(1);
  });

  it('never logs credentials', async () => {
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { call } = setup();
    await call('u1', 'POST', '/api/accounts', { ...newAccount, pin: 'wrong' });
    await call('u1', 'POST', '/api/accounts', newAccount);
    await call('u1', 'POST', '/api/accounts', { displayName: '' });
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(SECRET_PIN);
    spies.forEach((s) => s.mockRestore());
  });

  describe('per-user isolation', () => {
    async function twoUsers() {
      const s = setup();
      const a = (await s.call('userA', 'POST', '/api/accounts', newAccount)).json.account
        .id as string;
      await s.call('userA', 'PUT', '/api/prefs', DEFAULT_PREFS);
      return { ...s, a };
    }

    it("B can't list A's accounts or loans", async () => {
      const { call } = await twoUsers();
      const r = await call('userB', 'GET', '/api/loans');
      expect(r.json.accounts).toEqual([]);
      expect(r.json.loans).toEqual([]);
    });
    it("B can't edit, renew or delete A's account (404, not 403)", async () => {
      const { call, a, repo, creds } = await twoUsers();
      expect(
        (await call('userB', 'PATCH', `/api/accounts/${a}`, { displayName: 'x' })).status,
      ).toBe(404);
      expect((await call('userB', 'PATCH', `/api/accounts/${a}`, { pin: 'abc' })).status).toBe(404);
      expect(
        (await call('userB', 'POST', `/api/accounts/${a}/renew`, { checkoutIds: ['c1'] })).status,
      ).toBe(404);
      expect((await call('userB', 'DELETE', `/api/accounts/${a}`)).status).toBe(404);
      expect(await repo.listAccounts('userA')).toHaveLength(1);
      expect(creds.map.size).toBe(1);
    });
    it("a refresh only targets the caller's accounts", async () => {
      const { call, invoked } = await twoUsers();
      invoked.length = 0;
      await call('userB', 'POST', '/api/refresh');
      expect(invoked).toEqual([{ sub: 'userB' }]);
    });
    it("B's prefs and push subscriptions are separate", async () => {
      const { call, repo } = await twoUsers();
      expect((await call('userB', 'GET', '/api/prefs')).json.prefs).toBeNull();
      const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };
      await call('userA', 'POST', '/api/push-subscriptions', sub);
      await call('userB', 'DELETE', '/api/push-subscriptions', { endpoint: sub.endpoint });
      expect(await repo.listSubs('userA')).toHaveLength(1);
    });
    it('a scoped scrape never touches another user', async () => {
      const { repo, creds, a, call } = await twoUsers();
      await call('userB', 'POST', '/api/accounts', { ...newAccount, displayName: 'B' });
      const login = vi.spyOn(library, 'login');
      await runScrape({ repo, creds, library }, { sub: 'userB' });
      expect(login).toHaveBeenCalledTimes(1);
      expect((await repo.getAccount('userA', a))?.lastRefreshedAt).toBeDefined();
      login.mockRestore();
    });
  });

  it('renews, refreshes the cache and rejects ids that are not on the account', async () => {
    const { call, repo } = setup();
    const id = (await call('u1', 'POST', '/api/accounts', newAccount)).json.account.id;
    const ok = await call('u1', 'POST', `/api/accounts/${id}/renew`, { checkoutIds: ['c1'] });
    expect(ok.json.results[0]).toMatchObject({ ok: true, dueDate: '2026-12-15' });
    expect(
      (await call('u1', 'POST', `/api/accounts/${id}/renew`, { checkoutIds: ['nope'] })).status,
    ).toBe(404);
    expect(await repo.listLoans('u1')).toHaveLength(1);
  });

  it('updates the PIN only if it signs in, and deletes everything with the account', async () => {
    const { call, creds, repo } = setup();
    const id = (await call('u1', 'POST', '/api/accounts', newAccount)).json.account.id;
    expect((await call('u1', 'PATCH', `/api/accounts/${id}`, { pin: 'wrong' })).status).toBe(400);
    expect((await call('u1', 'PATCH', `/api/accounts/${id}`, { pin: 'new-pin' })).status).toBe(200);
    expect([...creds.map.values()][0]?.pin).toBe('new-pin');
    await call('u1', 'DELETE', `/api/accounts/${id}`);
    expect(creds.map.size).toBe(0);
    expect(await repo.listAccounts('u1')).toHaveLength(0);
    expect(await repo.listLoans('u1')).toHaveLength(0);
  });

  it('rate-limits manual refresh per user', async () => {
    const { call, tick, invoked } = setup();
    expect((await call('u1', 'POST', '/api/refresh')).status).toBe(202);
    expect((await call('u1', 'POST', '/api/refresh')).status).toBe(429);
    expect((await call('u2', 'POST', '/api/refresh')).status).toBe(202);
    tick(REFRESH_COOLDOWN_MS + 1);
    expect((await call('u1', 'POST', '/api/refresh')).status).toBe(202);
    expect(invoked).toHaveLength(3);
  });

  it('validates preferences', async () => {
    const { call } = setup();
    expect((await call('u1', 'PUT', '/api/prefs', { ...DEFAULT_PREFS, hour: 30 })).status).toBe(
      400,
    );
    expect(
      (await call('u1', 'PUT', '/api/prefs', { ...DEFAULT_PREFS, timeZone: 'Mars/Base' })).status,
    ).toBe(400);
    expect((await call('u1', 'PUT', '/api/prefs', DEFAULT_PREFS)).status).toBe(200);
  });

  it('records a failed refresh on that account without stopping the others', async () => {
    const s = setup();
    const a1 = (await s.call('u1', 'POST', '/api/accounts', newAccount)).json.account.id;
    const a2 = (await s.call('u1', 'POST', '/api/accounts', { ...newAccount, displayName: 'Two' }))
      .json.account.id;
    s.creds.map.delete([...s.creds.map.keys()][0]!);
    await runScrape({ repo: s.repo, creds: s.creds, library }, { sub: 'u1' });
    const accounts = await s.repo.listAccounts('u1');
    expect(accounts.filter((a) => a.lastError)).toHaveLength(1);
    expect(accounts.filter((a) => !a.lastError)).toHaveLength(1);
    expect([a1, a2]).toHaveLength(2);
  });
});

describe('bad credentials', () => {
  it('pauses an account after a bad-credentials sign-in until the PIN is updated', async () => {
    const s = setup();
    const id = (await s.call('u1', 'POST', '/api/accounts', newAccount)).json.account.id;
    const stored = [...s.creds.map.keys()][0]!;
    s.creds.map.set(stored, { username: '21234000011234', pin: 'wrong' });

    const login = vi.spyOn(library, 'login');
    await runScrape({ repo: s.repo, creds: s.creds, library }, { sub: 'u1' });
    expect((await s.repo.getAccount('u1', id))?.needsAttention).toBe(true);

    login.mockClear();
    await runScrape({ repo: s.repo, creds: s.creds, library }, {});
    expect(login).not.toHaveBeenCalled(); // skipped, so the card can't get locked

    expect((await s.call('u1', 'PATCH', `/api/accounts/${id}`, { pin: 'good-pin' })).status).toBe(
      200,
    );
    const acct = await s.repo.getAccount('u1', id);
    expect(acct?.needsAttention).toBeUndefined();
    await runScrape({ repo: s.repo, creds: s.creds, library }, {});
    expect(login).toHaveBeenCalled();
    login.mockRestore();
  });

  it('does not pause on a temporary library outage', async () => {
    const s = setup();
    const id = (await s.call('u1', 'POST', '/api/accounts', newAccount)).json.account.id;
    const down: LibraryClient = {
      login: async () => {
        throw new LoginError('down', 'unavailable');
      },
    };
    await runScrape({ repo: s.repo, creds: s.creds, library: down }, { sub: 'u1' });
    const acct = await s.repo.getAccount('u1', id);
    expect(acct?.lastError).toBeDefined();
    expect(acct?.needsAttention).toBeUndefined();
  });

  describe('admin', () => {
    const asAdmin = (s: ReturnType<typeof setup>, method: string, path: string, body?: unknown) =>
      s.call('admin-sub', method, path, body, 'admin@example.com');

    it('reports whether the caller is an admin, ignoring email case', async () => {
      const s = setup();
      expect((await asAdmin(s, 'GET', '/api/me')).json).toEqual({
        email: 'admin@example.com',
        isAdmin: true,
      });
      expect((await s.call('u1', 'GET', '/api/me')).json.isAdmin).toBe(false);
    });

    it('forbids every admin route for everyone else', async () => {
      const s = setup();
      const u = await asAdmin(s, 'POST', '/api/admin/users', { email: 'x@example.com' });
      const sub = u.json.user.sub as string;
      for (const [m, p] of [
        ['GET', '/api/admin/users'],
        ['POST', '/api/admin/users'],
        ['PATCH', `/api/admin/users/${sub}`],
        ['DELETE', `/api/admin/users/${sub}`],
      ] as const) {
        expect((await s.call('u1', m, p, { email: 'y@example.com', enabled: false })).status).toBe(
          403,
        );
      }
      expect(s.users.users).toHaveLength(1);
      expect(s.users.users[0]!.enabled).toBe(true);
    });

    it('invites, lists with card counts, disables and re-enables', async () => {
      const s = setup();
      const bad = await asAdmin(s, 'POST', '/api/admin/users', { email: 'nope' });
      expect(bad.status).toBe(400);
      const inv = await asAdmin(s, 'POST', '/api/admin/users', { email: ' Kid@Example.com ' });
      expect(inv.status).toBe(201);
      expect(inv.json.user.email).toBe('kid@example.com');
      expect(
        (await asAdmin(s, 'POST', '/api/admin/users', { email: 'kid@example.com' })).status,
      ).toBe(409);
      const sub = inv.json.user.sub as string;
      await s.call(sub, 'POST', '/api/accounts', newAccount);

      const list = await asAdmin(s, 'GET', '/api/admin/users');
      expect(list.json.users).toMatchObject([{ email: 'kid@example.com', cardCount: 1 }]);

      expect(
        (await asAdmin(s, 'PATCH', `/api/admin/users/${sub}`, { enabled: false })).status,
      ).toBe(200);
      expect(s.users.users[0]!.enabled).toBe(false);
      await asAdmin(s, 'PATCH', `/api/admin/users/${sub}`, { enabled: true });
      expect(s.users.users[0]!.enabled).toBe(true);
    });

    it("deletes a user's data and credentials but nobody else's", async () => {
      const s = setup();
      const a = (await asAdmin(s, 'POST', '/api/admin/users', { email: 'a@example.com' })).json.user
        .sub as string;
      const b = (await asAdmin(s, 'POST', '/api/admin/users', { email: 'b@example.com' })).json.user
        .sub as string;
      for (const sub of [a, b]) {
        await s.call(sub, 'POST', '/api/accounts', newAccount);
        await s.call(sub, 'PUT', '/api/prefs', DEFAULT_PREFS);
      }
      expect((await asAdmin(s, 'DELETE', `/api/admin/users/${a}`)).status).toBe(200);
      expect(await s.repo.listAccounts(a)).toHaveLength(0);
      expect(await s.repo.listLoans(a)).toHaveLength(0);
      expect(await s.repo.getPrefs(a)).toBeUndefined();
      expect(await s.repo.listAccounts(b)).toHaveLength(1);
      expect(await s.repo.getPrefs(b)).toBeDefined();
      expect(s.creds.map.size).toBe(1);
      expect(s.users.users.map((u) => u.sub)).toEqual([b]);
    });

    it("won't let an admin disable or delete themself", async () => {
      const s = setup();
      expect((await asAdmin(s, 'DELETE', '/api/admin/users/admin-sub')).status).toBe(400);
      expect(
        (await asAdmin(s, 'PATCH', '/api/admin/users/admin-sub', { enabled: false })).status,
      ).toBe(400);
    });
  });
});
