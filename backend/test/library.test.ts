import { describe, expect, it } from 'vitest';
import { createLibraryClient } from '../src/lib/library/client.js';
import { LoginError } from '../src/lib/types.js';

const loginPage = `<html><head><meta name="csrf-token" content="tok123"></head><body>
<form class="loginForm" method="post" action="https://palatinelibrary.bibliocommons.com/user/login?destination=%2Fuser_dashboard&amp;x=1"></form></body></html>`;

const blob = JSON.stringify({
  entities: { accounts: { '777': { id: 777 } } },
  pad: 'x'.repeat(11000),
});
const outPage = `<html><script type="application/json">${blob}</script></html>`;

const checkoutsJson = {
  borrowing: { checkouts: { items: ['c1', 'c2'], pagination: { pages: 1 } } },
  entities: {
    checkouts: {
      c1: {
        checkoutId: 'c1',
        metadataId: 'm1',
        dueDate: '2026-12-01',
        status: 'OUT',
        timesRenewed: 1,
        fines: 0,
        actions: ['renew'],
      },
      c2: {
        checkoutId: 'c2',
        metadataId: 'm2',
        dueDate: '2026-11-01',
        status: 'OUT',
        timesRenewed: 2,
        fines: null,
        actions: [],
      },
    },
    bibs: {
      m1: {
        briefInfo: {
          title: 'Ember Rising',
          subtitle: 'A Novel',
          authors: ['A. Writer'],
          format: 'BK',
        },
      },
      m2: { briefInfo: { title: 'Ember’s End', authors: [], format: 'BK' } },
    },
  },
};

const finesJson = {
  borrowing: {
    fines: { results: ['f1'], pagination: { number: 0, totalPages: 1 } },
    summaries: { fines: { totalAccrued: 0, totalCredits: 0, totalFines: 4.99 } },
  },
  entities: {
    fines: {
      f1: {
        id: 'f1',
        status: 'UNPAID',
        amount: 4.99,
        description: 'Replacement Cost',
        bibTitle: 'Duckling',
      },
    },
  },
};

function fakeFetch(opts: { loginOk?: boolean; loginBody?: string; renew?: unknown } = {}) {
  const calls: { url: string; method: string; cookie: string | null; body?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      cookie: headers.get('cookie'),
      body: init?.body ? String(init.body) : undefined,
    });
    if (url.endsWith('/user/login') && method === 'GET') return new Response(loginPage);
    if (url.includes('/user/login?') && method === 'POST') {
      if (opts.loginOk === false)
        return new Response(opts.loginBody ?? 'The username or PIN is incorrect. Please try again');
      const h = new Headers({
        Location: 'https://palatinelibrary.bibliocommons.com/user_dashboard',
      });
      h.append('Set-Cookie', 'session_id=abc; Domain=.bibliocommons.com; Path=/; HttpOnly');
      return new Response(null, { status: 302, headers: h });
    }
    if (url.endsWith('/v2/checkedout/out')) {
      return new Response(headers.get('cookie')?.includes('session_id') ? outPage : loginPage);
    }
    if (!headers.get('cookie')?.includes('session_id')) return new Response('{}', { status: 401 });
    if (url.includes('/checkouts?locale') && method === 'PATCH') return Response.json(opts.renew);
    if (url.includes('/checkouts?')) return Response.json(checkoutsJson);
    if (url.includes('/fines?')) return Response.json(finesJson);
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe('library client', () => {
  it('logs in and reads checkouts and fees', async () => {
    const { f, calls } = fakeFetch();
    const session = await createLibraryClient(f).login({ username: 'u', pin: 'p' });
    const loans = await session.getCheckouts();
    expect(loans).toHaveLength(2);
    expect(loans.find((l) => l.checkoutId === 'c1')).toMatchObject({
      title: 'Ember Rising: A Novel',
      author: 'A. Writer',
      dueDate: '2026-12-01',
      renewable: true,
    });
    expect(loans.find((l) => l.checkoutId === 'c2')?.renewable).toBe(false);
    const fees = await session.getFees();
    expect(fees.total).toBe(4.99);
    expect(fees.items[0]).toMatchObject({ description: 'Replacement Cost', amount: 4.99 });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toContain('authenticity_token=tok123');
    expect(post.url).toContain('destination=%2Fuser_dashboard&x=1');
    expect(calls.find((c) => c.url.includes('/checkouts?accountId=777'))).toBeTruthy();
  });

  it('reports a wrong PIN as bad-credentials', async () => {
    const { f } = fakeFetch({ loginOk: false });
    await expect(createLibraryClient(f).login({ username: 'u', pin: 'bad' })).rejects.toMatchObject(
      {
        name: 'LoginError',
        kind: 'bad-credentials',
      },
    );
  });

  it('reports other login failures as unavailable', async () => {
    const { f } = fakeFetch({ loginOk: false, loginBody: 'An error occurred' });
    const err = await createLibraryClient(f)
      .login({ username: 'u', pin: 'p' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err.kind).toBe('unavailable');
  });

  it('handles renew success, failure and mixed batches via HTTP 200 bodies', async () => {
    const { f, calls } = fakeFetch({
      renew: {
        borrowing: { checkouts: { items: ['c1'] } },
        entities: { checkouts: { c1: { dueDate: '2026-12-15', timesRenewed: 3 } } },
        failures: [
          {
            id: 'c2',
            errorResponseDTO: {
              message: 'Item has exceeded renewal limit, not allowed to renew',
              classification: 'RenewFailed',
            },
          },
        ],
      },
    });
    const session = await createLibraryClient(f).login({ username: 'u', pin: 'p' });
    const results = await session.renew(['c1', 'c2', 'c3']);
    expect(results[0]).toEqual({
      checkoutId: 'c1',
      ok: true,
      dueDate: '2026-12-15',
      timesRenewed: 3,
    });
    expect(results[1]).toMatchObject({
      checkoutId: 'c2',
      ok: false,
      message: expect.stringContaining('renewal limit'),
    });
    expect(results[2]).toMatchObject({ checkoutId: 'c3', ok: false });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(JSON.parse(patch.body!)).toEqual({
      accountId: 777,
      checkoutIds: ['c1', 'c2', 'c3'],
      renew: true,
    });
  });

  it('fails loudly when the response shape changes', async () => {
    const { f } = fakeFetch();
    const session = await createLibraryClient((async (u: string, i?: RequestInit) =>
      String(u).includes('/checkouts?')
        ? Response.json({ unexpected: true })
        : f(u, i)) as typeof fetch).login({
      username: 'u',
      pin: 'p',
    });
    await expect(session.getCheckouts()).rejects.toThrow();
  });
});
