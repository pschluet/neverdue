import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import {
  type Credentials,
  type Fees,
  type LibraryClient,
  type LibrarySession,
  type Loan,
  LoginError,
  type RenewResult,
} from '../types.js';

const BASE = 'https://palatinelibrary.bibliocommons.com';
const GATEWAY = 'https://gateway.bibliocommons.com/v2/libraries/palatinelibrary';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export type Fetch = typeof fetch;

/** fetch wrapper that keeps cookies in a jar and follows redirects by hand. */
class Http {
  readonly jar = new CookieJar();
  constructor(private readonly f: Fetch) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', UA);
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('Cookie', cookie);
    const res = await this.f(url, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      await this.jar.setCookie(sc, url, { ignoreError: true });
    }
    return res;
  }

  /** Follows 3xx redirects on GET. */
  async get(url: string, hops = 0): Promise<Response> {
    const res = await this.request(url);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc && hops < 5) {
      return this.get(new URL(loc, url).toString(), hops + 1);
    }
    return res;
  }
}

export function extractCsrf(html: string): { token: string; action: string } {
  const meta = /<meta[^>]*name="csrf-token"[^>]*>/.exec(html)?.[0];
  const token = meta && /content="([^"]+)"/.exec(meta)?.[1];
  const form = /<form[^>]*loginForm[^>]*>/.exec(html)?.[0];
  const action = form && /action="([^"]+)"/.exec(form)?.[1]?.replaceAll('&amp;', '&');
  if (!token || !action) throw new LoginError('Unexpected login page', 'unavailable');
  return { token, action: new URL(action, BASE).toString() };
}

/** Reads the library's numeric account id from the big embedded JSON blob. */
export function extractAccountId(html: string): number {
  for (const m of html.matchAll(
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    const body = m[1] ?? '';
    if (body.length < 10000) continue;
    try {
      const parsed = z
        .object({ entities: z.object({ accounts: z.record(z.object({ id: z.coerce.number() })) }) })
        .safeParse(JSON.parse(body));
      if (parsed.success) {
        const first = Object.values(parsed.data.entities.accounts)[0];
        if (first) return first.id;
      }
    } catch {
      /* try next blob */
    }
  }
  throw new Error('Could not find library account id');
}

const checkoutEntity = z.object({
  checkoutId: z.string(),
  metadataId: z.string(),
  dueDate: z.string(),
  status: z.string(),
  timesRenewed: z.number().default(0),
  fines: z.number().nullish(),
  actions: z.array(z.string()).default([]),
  bibTitle: z.string().optional(),
});

const checkoutsResponse = z.object({
  entities: z.object({
    checkouts: z.record(checkoutEntity).default({}),
    bibs: z
      .record(
        z.object({
          briefInfo: z
            .object({
              title: z.string().optional(),
              subtitle: z.string().nullish(),
              authors: z.array(z.string()).nullish(),
              format: z.string().nullish(),
            })
            .passthrough(),
        }),
      )
      .default({}),
  }),
  borrowing: z.object({
    checkouts: z.object({
      items: z.array(z.string()).optional(),
      pagination: z.object({ pages: z.number() }).partial().optional(),
    }),
  }),
});

const finesResponse = z.object({
  entities: z
    .object({
      fines: z
        .record(
          z.object({
            id: z.string(),
            status: z.string().default(''),
            amount: z.number(),
            description: z.string().default(''),
            bibTitle: z.string().nullish(),
          }),
        )
        .default({}),
    })
    .default({}),
  borrowing: z.object({
    fines: z.object({
      results: z.array(z.string()).default([]),
      pagination: z.object({ totalPages: z.number() }).partial().optional(),
    }),
    summaries: z.object({ fines: z.object({ totalFines: z.number() }) }),
  }),
});

const renewResponse = z.object({
  entities: z
    .object({
      checkouts: z
        .record(z.object({ dueDate: z.string(), timesRenewed: z.number().default(0) }))
        .default({}),
    })
    .default({}),
  failures: z
    .array(
      z.object({
        id: z.string(),
        errorResponseDTO: z.object({ message: z.string().optional() }).partial().optional(),
      }),
    )
    .default([]),
});

class Session implements LibrarySession {
  constructor(
    private readonly http: Http,
    private readonly accountId: number,
  ) {}

  private async json<T>(
    url: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    init?: RequestInit,
  ) {
    const res = await this.http.request(url, init);
    if (!res.ok) throw new Error(`Library request failed (${res.status})`);
    return schema.parse(await res.json());
  }

  async getCheckouts(): Promise<Loan[]> {
    const loans: Loan[] = [];
    let pages = 1;
    for (let page = 1; page <= pages && page <= 20; page++) {
      const data = await this.json(
        `${GATEWAY}/checkouts?accountId=${this.accountId}&materialType=PHYSICAL&page=${page}&size=100`,
        checkoutsResponse,
      );
      pages = data.borrowing.checkouts.pagination?.pages ?? 1;
      for (const c of Object.values(data.entities.checkouts)) {
        const info = data.entities.bibs[c.metadataId]?.briefInfo;
        const title = [info?.title ?? c.bibTitle ?? 'Unknown title', info?.subtitle]
          .filter(Boolean)
          .join(': ');
        loans.push({
          checkoutId: c.checkoutId,
          title,
          author: info?.authors?.join(', ') ?? '',
          format: info?.format ?? '',
          dueDate: c.dueDate,
          status: c.status,
          timesRenewed: c.timesRenewed,
          renewable: c.actions.includes('renew'),
          fines: c.fines ?? 0,
        });
      }
    }
    return loans;
  }

  async getFees(): Promise<Fees> {
    const items: Fees['items'] = [];
    let total = 0;
    let pages = 1;
    for (let page = 0; page < pages && page < 20; page++) {
      const data = await this.json(
        `${GATEWAY}/fines?accountId=${this.accountId}&page=${page}`,
        finesResponse,
      );
      total = data.borrowing.summaries.fines.totalFines;
      pages = data.borrowing.fines.pagination?.totalPages ?? 1;
      for (const id of data.borrowing.fines.results) {
        const f = data.entities.fines[id];
        if (f)
          items.push({
            id: f.id,
            title: f.bibTitle ?? '',
            description: f.description,
            amount: f.amount,
            status: f.status,
          });
      }
    }
    return { total, items };
  }

  async renew(checkoutIds: string[]): Promise<RenewResult[]> {
    const data = await this.json(`${GATEWAY}/checkouts?locale=en-US`, renewResponse, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, checkoutIds, renew: true }),
    });
    // HTTP 200 even on failure: success only if present in entities and not in failures.
    return checkoutIds.map((checkoutId) => {
      const failure = data.failures.find((f) => f.id === checkoutId);
      const ok = data.entities.checkouts[checkoutId];
      if (ok && !failure) {
        return { checkoutId, ok: true, dueDate: ok.dueDate, timesRenewed: ok.timesRenewed };
      }
      return {
        checkoutId,
        ok: false,
        message: failure?.errorResponseDTO?.message ?? 'The library could not renew this item',
      };
    });
  }
}

export function createLibraryClient(f: Fetch = fetch): LibraryClient {
  return {
    async login({ username, pin }: Credentials): Promise<LibrarySession> {
      const http = new Http(f);
      let page: Response;
      try {
        page = await http.get(`${BASE}/user/login`);
      } catch {
        throw new LoginError('Library site unreachable', 'unavailable');
      }
      const { token, action } = extractCsrf(await page.text());
      const body = new URLSearchParams({
        utf8: '✓',
        authenticity_token: token,
        name: username,
        user_pin: pin,
        remember_me: 'true',
        local: 'false',
        commit: 'Log In',
      });
      const res = await http.request(action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: BASE,
          Referer: `${BASE}/user/login`,
        },
        body,
      });
      // 302 = success. A failed login is a 200 with the login page again.
      if (res.status !== 302) {
        const text = await res.text();
        if (/username or PIN is incorrect/i.test(text)) {
          throw new LoginError('The card number or PIN is incorrect', 'bad-credentials');
        }
        throw new LoginError('The library could not complete the sign-in', 'unavailable');
      }
      const out = await http.get(`${BASE}/v2/checkedout/out`);
      // If the session isn't valid we land on the login page, which has no account blob.
      let accountId: number;
      try {
        accountId = extractAccountId(await out.text());
      } catch {
        throw new LoginError('The library could not complete the sign-in', 'unavailable');
      }
      return new Session(http, accountId);
    },
  };
}
