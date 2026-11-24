import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoRepo, type Repo } from './lib/db.js';
import {
  buildMessage,
  currentSlot,
  hasMatches,
  localDate,
  matchItems,
} from './lib/notify-logic.js';
import { dataOwner } from './lib/links.js';
import { createPusher, type Pusher } from './lib/push.js';

/** Runs hourly: sends one grouped push to each user whose delivery slot is now. */
export async function runNotify(deps: { repo: Repo; pusher: Pusher; now?: () => Date }) {
  const now = (deps.now ?? (() => new Date()))();
  let sent = 0;
  for (const { sub, prefs } of await deps.repo.listAllPrefs()) {
    const slot = currentSlot(prefs, now);
    if (!slot) continue;
    const state = await deps.repo.getState(sub);
    if (state.lastSlot === slot) continue; // at most one send per slot

    // Linked users are alerted about the shared cards, using their own settings and devices.
    const owner = await dataOwner(deps.repo, sub);
    const [loans, accounts, subs] = await Promise.all([
      deps.repo.listLoans(owner),
      deps.repo.listAccounts(owner),
      deps.repo.listSubs(sub),
    ]);
    const matches = matchItems(prefs, loans, accounts, localDate(now, prefs.timeZone));
    if (!hasMatches(matches) || subs.length === 0) continue;

    const message = buildMessage(matches);
    for (const s of subs) {
      if ((await deps.pusher.send(s, message)) === 'gone')
        await deps.repo.deleteSub(sub, s.endpoint);
    }
    await deps.repo.putState(sub, { lastSlot: slot });
    sent++;
  }
  return { sent };
}

export const handler = async () => {
  const ssm = new SSMClient({});
  const r = await ssm.send(
    new GetParameterCommand({ Name: '/neverdue/vapid-private-key', WithDecryption: true }),
  );
  return runNotify({
    repo: new DynamoRepo(process.env.TABLE_NAME!),
    pusher: createPusher(process.env.VAPID_PUBLIC_KEY!, r.Parameter!.Value!),
  });
};
