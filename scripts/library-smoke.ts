// Usage: npx tsx scripts/library-smoke.ts
// Read-only check of the library client against the live site. Prompts for credentials (PIN hidden)
// and prints counts only: no titles, card numbers or cookies.
import { createInterface } from 'node:readline/promises';
import { createLibraryClient } from '../backend/src/lib/library/client.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const username = await rl.question('Card number / username: ');
const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
const pin = await rl.question('');
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = write;
rl.close();
console.log('');

const session = await createLibraryClient().login({ username, pin });
const loans = await session.getCheckouts();
const fees = await session.getFees();
const today = new Date().toISOString().slice(0, 10);
console.log(
  `Signed in. ${loans.length} checkouts (${loans.filter((l) => l.dueDate < today).length} overdue, ${loans.filter((l) => l.renewable).length} renewable). Fees: $${fees.total.toFixed(2)} in ${fees.items.length} item(s).`,
);
