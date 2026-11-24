import { DynamoRepo, type Repo } from './lib/db.js';
import { type CredentialStore, SsmCredentialStore } from './lib/credentials.js';
import { createLibraryClient } from './lib/library/client.js';
import { mapLimit, refreshAccount } from './lib/refresh.js';
import type { LibraryClient } from './lib/types.js';

export interface ScrapeEvent {
  sub?: string;
  accountId?: string;
}

export async function runScrape(
  deps: { repo: Repo; creds: CredentialStore; library: LibraryClient },
  event: ScrapeEvent,
) {
  let targets: { sub: string; id: string }[];
  if (event.sub) {
    const accounts = await deps.repo.listAccounts(event.sub);
    targets = accounts
      .filter((a) => !event.accountId || a.id === event.accountId)
      .map((a) => ({ sub: event.sub!, id: a.id }));
  } else {
    targets = (await deps.repo.listAllAccounts()).map((x) => ({ sub: x.sub, id: x.account.id }));
  }
  await mapLimit(targets, 3, (t) => refreshAccount(deps, t.sub, t.id));
  return { refreshed: targets.length };
}

export const handler = (event: ScrapeEvent) =>
  runScrape(
    {
      repo: new DynamoRepo(process.env.TABLE_NAME!),
      creds: new SsmCredentialStore(),
      library: createLibraryClient(),
    },
    event ?? {},
  );
