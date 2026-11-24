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
import { storeSnapshot } from './lib/refresh.js';
import { type LibraryClient, LoginError, DEFAULT_PREFS } from './lib/types.js';

export interface ApiDeps {
  repo: Repo;
  creds: CredentialStore;
  library: LibraryClient;
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

    if (root === 'loans' && method === 'GET' && !id) {
      const [accounts, loans, state] = await Promise.all([
        deps.repo.listAccounts(sub),
        deps.repo.listLoans(sub),
        deps.repo.getState(sub),
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
        await deps.creds.put(sub, accountId, { username: p.data.username, pin: p.data.pin });
        const account = {
          id: accountId,
          displayName: p.data.displayName,
          maskedCard: `•••• ${p.data.username.slice(-4)}`,
          fees: { total: 0, items: [] },
        };
        await deps.repo.putAccount(sub, account);
        // Reuse the validated session so the new account has data right away.
        try {
          await storeSnapshot(deps.repo, sub, accountId, login.session, now());
        } catch {
          await deps.invokeScraper({ sub, accountId });
        }
        return json(201, { account: (await deps.repo.getAccount(sub, accountId)) ?? account });
      }

      if (id) {
        // Owner + id looked up together: someone else's account is indistinguishable from none.
        const account = await deps.repo.getAccount(sub, id);
        if (!account) return notFound();

        if (!action && method === 'PATCH') {
          const p = accountPatch.safeParse(body);
          if (!p.success) return bad(p.error);
          if (p.data.pin !== undefined) {
            const current = await deps.creds.get(sub, id);
            const login = await validateLogin(current.username, p.data.pin);
            if (login.error) return login.error;
            await deps.creds.put(sub, id, { username: current.username, pin: p.data.pin });
          }
          const updated = { ...account, displayName: p.data.displayName ?? account.displayName };
          if (p.data.pin !== undefined) updated.lastError = undefined;
          await deps.repo.putAccount(sub, updated);
          if (p.data.pin !== undefined) await deps.invokeScraper({ sub, accountId: id });
          return json(200, { account: updated });
        }

        if (!action && method === 'DELETE') {
          await deps.creds.delete(sub, id);
          await deps.repo.deleteAccount(sub, id);
          return json(200, { ok: true });
        }

        if (action === 'renew' && method === 'POST') {
          const p = renewInput.safeParse(body);
          if (!p.success) return bad(p.error);
          const owned = new Set(
            (await deps.repo.listLoans(sub))
              .filter((l) => l.accountId === id)
              .map((l) => l.checkoutId),
          );
          if (!p.data.checkoutIds.every((c) => owned.has(c))) return notFound();
          const login = await validateLogin(...(await creds(sub, id)));
          if (login.error) return login.error;
          const results = await login.session.renew(p.data.checkoutIds);
          try {
            await storeSnapshot(deps.repo, sub, id, login.session, now());
          } catch {
            /* results are still valid; the next refresh fixes the cache */
          }
          return json(200, { results });
        }
      }
    }

    if (root === 'refresh' && method === 'POST' && !id) {
      const state = await deps.repo.getState(sub);
      const last = state.lastManualRefreshAt ? Date.parse(state.lastManualRefreshAt) : 0;
      if (now().getTime() - last < REFRESH_COOLDOWN_MS) {
        return json(429, { error: 'Please wait a few minutes before refreshing again.' });
      }
      await deps.repo.putState(sub, { lastManualRefreshAt: now().toISOString() });
      await deps.invokeScraper({ sub });
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
