import type { CredentialStore } from './credentials.js';
import type { Repo } from './db.js';
import type { LibraryClient, LibrarySession } from './types.js';
import { LoginError } from './types.js';

/** Reads checkouts + fees from an open session and stores the snapshot. */
export async function storeSnapshot(
  repo: Repo,
  sub: string,
  accountId: string,
  session: LibrarySession,
  now = new Date(),
) {
  const [loans, fees] = await Promise.all([session.getCheckouts(), session.getFees()]);
  const account = await repo.getAccount(sub, accountId);
  if (!account) return;
  await repo.replaceLoans(sub, accountId, loans);
  await repo.putAccount(sub, {
    ...account,
    fees,
    lastRefreshedAt: now.toISOString(),
    lastError: undefined,
  });
}

/** Refreshes one account; failures are recorded on the account, never thrown. */
export async function refreshAccount(
  deps: { repo: Repo; creds: CredentialStore; library: LibraryClient },
  sub: string,
  accountId: string,
): Promise<void> {
  try {
    const creds = await deps.creds.get(sub, accountId);
    const session = await deps.library.login(creds);
    await storeSnapshot(deps.repo, sub, accountId, session);
  } catch (e) {
    const account = await deps.repo.getAccount(sub, accountId);
    if (!account) return;
    const message =
      e instanceof LoginError && e.kind === 'bad-credentials'
        ? 'Sign-in failed. Check the card number and PIN.'
        : 'Could not reach the library. Will retry on the next refresh.';
    await deps.repo.putAccount(sub, { ...account, lastError: message });
  }
}

export async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
    }),
  );
}
