import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ulid } from 'ulid';
import { z } from 'zod';
import { type CredentialStore, SsmCredentialStore } from './lib/credentials.js';
import { DynamoRepo, type Repo } from './lib/db.js';
import { createLibraryClient } from './lib/library/client.js';
import { LinkError, dataOwner, linkUsers, moveCards, unlinkUsers } from './lib/links.js';
import { storeSnapshot } from './lib/refresh.js';
import { type LibraryClient, LoginError, DEFAULT_PREFS } from './lib/types.js';
import { CognitoUserDirectory, UserExistsError, type UserDirectory } from './lib/users.js';

export interface ApiDeps {
  repo: Repo;
  creds: CredentialStore;
  library: LibraryClient;
  users: UserDirectory;
  /** Emails (any case) allowed to use /api/admin/*. */
  adminEmails: string[];
  /** Fire-and-forget invocation of the scraper Lambda. */
  invokeScraper(payload: { sub: string; accountId?: string }): Promise<void>;
  now?: () => Date;
}

export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

const accountInput = z.object({
  displayName: z.string().trim().min(1).max(40),
  username: z.string().trim().min(1).max(64),
  pin: z.string().min(1).max(64),
});
const accountPatch = z
  .object({ displayName: z.string().trim().min(1).max(40), pin: z.string().min(1).max(64) })
  .partial()
  .refine((v) => v.displayName !== undefined || v.pin !== undefined);
const prefsInput = z.object({
  triggers: z.object({
    overdue: z.boolean(),
    daysBefore: z.number().int().min(1).max(30).nullable(),
    onDueDate: z.boolean(),
    fees: z.boolean(),
  }),
  frequency: z.enum(['daily', 'weekly']),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  timeZone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }),
});
const subInput = z.object({
  endpoint: z.string().url().startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const inviteInput = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const userPatch = z.object({ enabled: z.boolean() });
const linkInput = z.object({ partner: z.string().min(1).max(64) });
const unlinkInput = z.object({ keeper: z.string().min(1).max(64) });
const renewInput = z.object({ checkoutIds: z.array(z.string().min(1)).min(1).max(100) });

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const notFound = () => json(404, { error: 'Not found' });

export function createApi(deps: ApiDeps) {
  const now = () => (deps.now ?? (() => new Date()))();

  async function validateLogin(username: string, pin: string) {
    try {
      return { session: await deps.library.login({ username, pin }) };
    } catch (e) {
      if (e instanceof LoginError && e.kind === 'bad-credentials') {
        return { error: json(400, { error: e.message }) };
      }
      return { error: json(502, { error: 'The library is not responding. Try again later.' }) };
    }
  }

  async function handle(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    // The owner always comes from the verified JWT, never from the request.
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof sub !== 'string' || !sub) return json(401, { error: 'Unauthorized' });

    const method = event.requestContext.http.method;
    const parts = event.rawPath
      .replace(/^\/api\/?/, '')
      .split('/')
      .filter(Boolean);
    let body: unknown;
    if (event.body) {
      try {
        body = JSON.parse(
          event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body,
        );
      } catch {
        return json(400, { error: 'Invalid JSON' });
      }
    }
    const bad = (e: z.ZodError) =>
      json(400, { error: 'Invalid request', details: e.issues.map((i) => i.path.join('.')) });

    const [root, id, action] = parts;

    const email = event.requestContext.authorizer?.jwt?.claims?.email;
    const isAdmin =
      typeof email === 'string' &&
      deps.adminEmails.some((a) => a.trim().toLowerCase() === email.toLowerCase());

    if (root === 'me' && method === 'GET' && !id) {
      return json(200, { email: typeof email === 'string' ? email : '', isAdmin });
    }

    if (root === 'admin') {
      if (!isAdmin) return json(403, { error: 'Forbidden' });
      if (id !== 'users') return notFound();
      const target = action;
      if (!target && method === 'GET') {
        const [users, accounts, links] = await Promise.all([
          deps.users.list(),
          deps.repo.listAllAccounts(),
          deps.repo.listAllLinks(),
        ]);
        const cards = new Map<string, number>();
        for (const a of accounts) cards.set(a.sub, (cards.get(a.sub) ?? 0) + 1);
        const linkOf = new Map(links.map((l) => [l.sub, l.link]));
        const emailOf = new Map(users.map((u) => [u.sub, u.email]));
        return json(200, {
          users: users
            .map((u) => {
              const link = linkOf.get(u.sub);
              return {
                ...u,
                // Linked users share one set of cards, held under the link's owner.
                cardCount: cards.get(link?.owner ?? u.sub) ?? 0,
                isSelf: u.sub === sub,
                linkedWith: link
                  ? { sub: link.partner, email: emailOf.get(link.partner) ?? '' }
                  : null,
              };
            })
            .sort((a, b) => a.email.localeCompare(b.email)),
        });
      }
      if (!target && method === 'POST') {
        const p = inviteInput.safeParse(body);
        if (!p.success) return bad(p.error);
        try {
          return json(201, { user: await deps.users.create(p.data.email) });
        } catch (e) {
          if (e instanceof UserExistsError) return json(409, { error: 'That user already exists' });
          throw e;
        }
      }
      if (target && parts[3] === 'link') {
        // Unlike disable/delete, an admin may link their own account to someone else's.
        try {
          if (method === 'POST') {
            const p = linkInput.safeParse(body);
            if (!p.success) return bad(p.error);
            await linkUsers(deps, target, p.data.partner);
            return json(200, { ok: true });
          }
          if (method === 'DELETE') {
            const p = unlinkInput.safeParse(body);
            if (!p.success) return bad(p.error);
            await unlinkUsers(deps, target, p.data.keeper);
            return json(200, { ok: true });
          }
        } catch (e) {
          if (e instanceof LinkError) return json(409, { error: e.message });
          throw e;
        }
        return notFound();
      }
      if (target) {
        if (target === sub) return json(400, { error: "You can't change your own account here" });
        if (method === 'PATCH') {
          const p = userPatch.safeParse(body);
          if (!p.success) return bad(p.error);
          await deps.users.setEnabled(target, p.data.enabled);
          return json(200, { ok: true });
        }
        if (method === 'DELETE') {
          // A linked partner keeps the shared cards, so hand them over before deleting.
          const link = await deps.repo.getLink(target);
          if (link) {
            if (link.owner === target) await moveCards(deps, target, link.partner);
            await deps.repo.deleteLink(link.partner);
          }
          // Data first: if Cognito deletion fails the user can still be retried, never orphaned.
          await deps.repo.deleteUser(target);
          await deps.creds.deleteAll(target);
          await deps.users.delete(target);
          return json(200, { ok: true });
        }
      }
      return notFound();
    }

    // Cards, checkouts and their PINs belong to the link's owner; everything else to the caller.
    const owner = await dataOwner(deps.repo, sub);
    if (root === 'loans' && method === 'GET' && !id) {
      const [accounts, loans, state] = await Promise.all([
        deps.repo.listAccounts(owner),
        deps.repo.listLoans(owner),
        deps.repo.getState(owner),
      ]);
      return json(200, {
        accounts: accounts.map(({ libraryAccountId: _l, ...a }) => a),
        loans,
        lastManualRefreshAt: state.lastManualRefreshAt,
      });
    }

    if (root === 'accounts') {
      if (!id && method === 'POST') {
        const p = accountInput.safeParse(body);
        if (!p.success) return bad(p.error);
        const login = await validateLogin(p.data.username, p.data.pin);
        if (login.error) return login.error;
        const accountId = ulid();
        await deps.creds.put(owner, accountId, { username: p.data.username, pin: p.data.pin });
        const account = {
          id: accountId,
          displayName: p.data.displayName,
          maskedCard: `•••• ${p.data.username.slice(-4)}`,
          fees: { total: 0, items: [] },
        };
        await deps.repo.putAccount(owner, account);
        // Reuse the validated session so the new account has data right away.
        try {
          await storeSnapshot(deps.repo, owner, accountId, login.session, now());
        } catch {
          await deps.invokeScraper({ sub: owner, accountId });
        }
        return json(201, { account: (await deps.repo.getAccount(owner, accountId)) ?? account });
      }

      if (id) {
        // Owner + id looked up together: someone else's account is indistinguishable from none.
        const account = await deps.repo.getAccount(owner, id);
        if (!account) return notFound();

        if (!action && method === 'PATCH') {
          const p = accountPatch.safeParse(body);
          if (!p.success) return bad(p.error);
          if (p.data.pin !== undefined) {
            const current = await deps.creds.get(owner, id);
            const login = await validateLogin(current.username, p.data.pin);
            if (login.error) return login.error;
            await deps.creds.put(owner, id, { username: current.username, pin: p.data.pin });
          }
          const updated = { ...account, displayName: p.data.displayName ?? account.displayName };
          if (p.data.pin !== undefined) {
            updated.lastError = undefined;
            updated.needsAttention = undefined;
          }
          await deps.repo.putAccount(owner, updated);
          if (p.data.pin !== undefined) await deps.invokeScraper({ sub: owner, accountId: id });
          return json(200, { account: updated });
        }

        if (!action && method === 'DELETE') {
          await deps.creds.delete(owner, id);
          await deps.repo.deleteAccount(owner, id);
          return json(200, { ok: true });
        }

        if (action === 'renew' && method === 'POST') {
          const p = renewInput.safeParse(body);
          if (!p.success) return bad(p.error);
          const owned = new Set(
            (await deps.repo.listLoans(owner))
              .filter((l) => l.accountId === id)
              .map((l) => l.checkoutId),
          );
          if (!p.data.checkoutIds.every((c) => owned.has(c))) return notFound();
          const login = await validateLogin(...(await creds(owner, id)));
          if (login.error) return login.error;
          const results = await login.session.renew(p.data.checkoutIds);
          try {
            await storeSnapshot(deps.repo, owner, id, login.session, now());
          } catch {
            /* results are still valid; the next refresh fixes the cache */
          }
          return json(200, { results });
        }
      }
    }

    if (root === 'refresh' && method === 'POST' && !id) {
      const state = await deps.repo.getState(owner);
      const last = state.lastManualRefreshAt ? Date.parse(state.lastManualRefreshAt) : 0;
      if (now().getTime() - last < REFRESH_COOLDOWN_MS) {
        return json(429, { error: 'Please wait a few minutes before refreshing again.' });
      }
      await deps.repo.putState(owner, { lastManualRefreshAt: now().toISOString() });
      await deps.invokeScraper({ sub: owner });
      return json(202, { ok: true });
    }

    if (root === 'prefs' && !id) {
      if (method === 'GET')
        return json(200, {
          prefs: (await deps.repo.getPrefs(sub)) ?? null,
          defaults: DEFAULT_PREFS,
        });
      if (method === 'PUT') {
        const p = prefsInput.safeParse(body);
        if (!p.success) return bad(p.error);
        await deps.repo.putPrefs(sub, p.data);
        return json(200, { prefs: p.data });
      }
    }

    if (root === 'push-subscriptions' && !id) {
      const p = subInput.safeParse(body);
      if (method === 'POST') {
        if (!p.success) return bad(p.error);
        await deps.repo.putSub(sub, p.data);
        return json(201, { ok: true });
      }
      if (method === 'DELETE') {
        const e = z.object({ endpoint: z.string() }).safeParse(body);
        if (!e.success) return bad(e.error);
        await deps.repo.deleteSub(sub, e.data.endpoint);
        return json(200, { ok: true });
      }
    }

    return notFound();
  }

  async function creds(sub: string, id: string): Promise<[string, string]> {
    const c = await deps.creds.get(sub, id);
    return [c.username, c.pin];
  }

  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
    try {
      return await handle(event);
    } catch (e) {
      // Log the error name only: messages could echo request data.
      console.error('api error', (e as Error).name);
      return json(500, { error: 'Something went wrong' });
    }
  };
}

let cached: ReturnType<typeof createApi> | undefined;
export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  cached ??= createApi({
    repo: new DynamoRepo(process.env.TABLE_NAME!),
    creds: new SsmCredentialStore(),
    library: createLibraryClient(),
    users: new CognitoUserDirectory(process.env.USER_POOL_ID!),
    adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').filter(Boolean),
    async invokeScraper(payload) {
      await new LambdaClient({}).send(
        new InvokeCommand({
          FunctionName: process.env.SCRAPER_FUNCTION_NAME!,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
    },
  });
  return cached(event);
};
