import type { CredentialStore } from './credentials.js';
import type { Repo } from './db.js';

export class LinkError extends Error {}

interface Deps {
  repo: Repo;
  creds: CredentialStore;
}

/** The sub whose records hold this user's cards and checkouts. */
export async function dataOwner(repo: Repo, sub: string): Promise<string> {
  return (await repo.getLink(sub))?.owner ?? sub;
}

/** Moves every card (PIN first, so a card never ends up without credentials) and its checkouts. */
export async function moveCards(deps: Deps, from: string, to: string) {
  for (const a of await deps.repo.listAccounts(from)) {
    await deps.creds.move(from, to, a.id);
    await deps.repo.moveAccount(from, to, a.id);
  }
}

/** Links two users, merging their cards under whichever already holds more. */
export async function linkUsers(deps: Deps, a: string, b: string) {
  if (a === b) throw new LinkError("You can't link a user to themselves");
  if ((await deps.repo.getLink(a)) || (await deps.repo.getLink(b))) {
    throw new LinkError('Unlink that user first');
  }
  const [cardsA, cardsB] = await Promise.all([
    deps.repo.listAccounts(a),
    deps.repo.listAccounts(b),
  ]);
  const [owner, other] = cardsB.length > cardsA.length ? [b, a] : [a, b];
  await moveCards(deps, other, owner);
  await deps.repo.putLink(a, { partner: b, owner });
  await deps.repo.putLink(b, { partner: a, owner });
}

/** Separates a linked pair; `keeper` ends up with all the cards. */
export async function unlinkUsers(deps: Deps, sub: string, keeper: string) {
  const link = await deps.repo.getLink(sub);
  if (!link) throw new LinkError('That user is not linked');
  if (keeper !== sub && keeper !== link.partner) throw new LinkError('Pick one of the two users');
  if (keeper !== link.owner) await moveCards(deps, link.owner, keeper);
  await deps.repo.deleteLink(sub);
  await deps.repo.deleteLink(link.partner);
}
