import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { LibraryAccount, Loan, Prefs, PushSub } from './types.js';

export interface UserState {
  lastManualRefreshAt?: string;
  lastSlot?: string;
}

export interface StoredLoan extends Loan {
  accountId: string;
}

/**
 * Every method takes the owner's `sub` first and every key is built from it, so a call can
 * only ever reach that user's records.
 */
export interface Repo {
  listAccounts(sub: string): Promise<LibraryAccount[]>;
  getAccount(sub: string, id: string): Promise<LibraryAccount | undefined>;
  putAccount(sub: string, account: LibraryAccount): Promise<void>;
  /** Deletes the account and its loans. */
  deleteAccount(sub: string, id: string): Promise<void>;
  listAllAccounts(): Promise<{ sub: string; account: LibraryAccount }[]>;
  replaceLoans(sub: string, accountId: string, loans: Loan[]): Promise<void>;
  listLoans(sub: string): Promise<StoredLoan[]>;
  getPrefs(sub: string): Promise<Prefs | undefined>;
  putPrefs(sub: string, prefs: Prefs): Promise<void>;
  listAllPrefs(): Promise<{ sub: string; prefs: Prefs }[]>;
  getState(sub: string): Promise<UserState>;
  putState(sub: string, state: UserState): Promise<void>;
  listSubs(sub: string): Promise<PushSub[]>;
  putSub(sub: string, s: PushSub): Promise<void>;
  deleteSub(sub: string, endpoint: string): Promise<void>;
}

const subKey = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

export class MemoryRepo implements Repo {
  private items = new Map<string, Record<string, unknown>>();
  private key = (sub: string, sk: string) => `USER#${sub}|${sk}`;
  private scan<T>(sub: string | undefined, prefix: string): { sub: string; sk: string; v: T }[] {
    const out: { sub: string; sk: string; v: T }[] = [];
    for (const [k, v] of this.items) {
      const [pk, sk] = k.split('|') as [string, string];
      const owner = pk.slice(5);
      if ((sub === undefined || owner === sub) && sk.startsWith(prefix)) {
        out.push({ sub: owner, sk, v: structuredClone(v) as T });
      }
    }
    return out;
  }
  private put(sub: string, sk: string, v: unknown) {
    this.items.set(this.key(sub, sk), structuredClone(v) as Record<string, unknown>);
  }
  async listAccounts(sub: string) {
    return this.scan<LibraryAccount>(sub, 'ACCOUNT#').map((x) => x.v);
  }
  async getAccount(sub: string, id: string) {
    return this.scan<LibraryAccount>(sub, `ACCOUNT#${id}`)[0]?.v;
  }
  async putAccount(sub: string, a: LibraryAccount) {
    this.put(sub, `ACCOUNT#${a.id}`, a);
  }
  async deleteAccount(sub: string, id: string) {
    this.items.delete(this.key(sub, `ACCOUNT#${id}`));
    for (const x of this.scan(sub, `LOAN#${id}#`)) this.items.delete(this.key(sub, x.sk));
  }
  async listAllAccounts() {
    return this.scan<LibraryAccount>(undefined, 'ACCOUNT#').map((x) => ({
      sub: x.sub,
      account: x.v,
    }));
  }
  async replaceLoans(sub: string, accountId: string, loans: Loan[]) {
    for (const x of this.scan(sub, `LOAN#${accountId}#`)) this.items.delete(this.key(sub, x.sk));
    for (const l of loans) this.put(sub, `LOAN#${accountId}#${l.checkoutId}`, { ...l, accountId });
  }
  async listLoans(sub: string) {
    return this.scan<StoredLoan>(sub, 'LOAN#').map((x) => x.v);
  }
  async getPrefs(sub: string) {
    return this.scan<Prefs>(sub, 'PREFS')[0]?.v;
  }
  async putPrefs(sub: string, p: Prefs) {
    this.put(sub, 'PREFS', p);
  }
  async listAllPrefs() {
    return this.scan<Prefs>(undefined, 'PREFS').map((x) => ({ sub: x.sub, prefs: x.v }));
  }
  async getState(sub: string) {
    return this.scan<UserState>(sub, 'STATE')[0]?.v ?? {};
  }
  async putState(sub: string, s: UserState) {
    this.put(sub, 'STATE', { ...(await this.getState(sub)), ...s });
  }
  async listSubs(sub: string) {
    return this.scan<PushSub>(sub, 'PUSHSUB#').map((x) => x.v);
  }
  async putSub(sub: string, s: PushSub) {
    this.put(sub, `PUSHSUB#${subKey(s.endpoint)}`, s);
  }
  async deleteSub(sub: string, endpoint: string) {
    this.items.delete(this.key(sub, `PUSHSUB#${subKey(endpoint)}`));
  }
}

export class DynamoRepo implements Repo {
  private doc: DynamoDBDocumentClient;
  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async query(sub: string, prefix: string) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':sk': prefix },
          ExclusiveStartKey,
        }),
      );
      items.push(...(r.Items ?? []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async queryIndex(gsi1pk: string) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :g',
          ExpressionAttributeValues: { ':g': gsi1pk },
          ExclusiveStartKey,
        }),
      );
      items.push(...(r.Items ?? []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private put(sub: string, sk: string, data: object, extra: object = {}) {
    return this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk: `USER#${sub}`, sk, data, ...extra } }),
    );
  }
  private async get<T>(sub: string, sk: string): Promise<T | undefined> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `USER#${sub}`, sk } }),
    );
    return r.Item?.data as T | undefined;
  }
  private del(sub: string, sk: string) {
    return this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `USER#${sub}`, sk } }),
    );
  }
  private async batch(requests: object[]) {
    for (let i = 0; i < requests.length; i += 25) {
      let pending: object[] = requests.slice(i, i + 25);
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const r = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }),
        );
        pending = (r.UnprocessedItems?.[this.table] as object[] | undefined) ?? [];
      }
      if (pending.length) throw new Error('DynamoDB batch write did not complete');
    }
  }

  async listAccounts(sub: string) {
    return (await this.query(sub, 'ACCOUNT#')).map((i) => i.data as LibraryAccount);
  }
  getAccount(sub: string, id: string) {
    return this.get<LibraryAccount>(sub, `ACCOUNT#${id}`);
  }
  putAccount(sub: string, a: LibraryAccount) {
    return this.put(sub, `ACCOUNT#${a.id}`, a, {
      gsi1pk: 'ACCOUNT',
      gsi1sk: `USER#${sub}#${a.id}`,
    }).then(() => undefined);
  }
  async deleteAccount(sub: string, id: string) {
    const loans = await this.query(sub, `LOAN#${id}#`);
    await this.batch(loans.map((l) => ({ DeleteRequest: { Key: { pk: l.pk, sk: l.sk } } })));
    await this.del(sub, `ACCOUNT#${id}`);
  }
  async listAllAccounts() {
    return (await this.queryIndex('ACCOUNT')).map((i) => ({
      sub: String(i.pk).slice(5),
      account: i.data as LibraryAccount,
    }));
  }
  async replaceLoans(sub: string, accountId: string, loans: Loan[]) {
    const existing = await this.query(sub, `LOAN#${accountId}#`);
    const keep = new Set(loans.map((l) => `LOAN#${accountId}#${l.checkoutId}`));
    const stale = existing.filter((e) => !keep.has(String(e.sk)));
    await this.batch([
      ...stale.map((l) => ({ DeleteRequest: { Key: { pk: l.pk, sk: l.sk } } })),
      ...loans.map((l) => ({
        PutRequest: {
          Item: {
            pk: `USER#${sub}`,
            sk: `LOAN#${accountId}#${l.checkoutId}`,
            data: { ...l, accountId },
          },
        },
      })),
    ]);
  }
  async listLoans(sub: string) {
    return (await this.query(sub, 'LOAN#')).map((i) => i.data as StoredLoan);
  }
  getPrefs(sub: string) {
    return this.get<Prefs>(sub, 'PREFS');
  }
  putPrefs(sub: string, p: Prefs) {
    return this.put(sub, 'PREFS', p, { gsi1pk: 'PREFS', gsi1sk: `USER#${sub}` }).then(
      () => undefined,
    );
  }
  async listAllPrefs() {
    return (await this.queryIndex('PREFS')).map((i) => ({
      sub: String(i.pk).slice(5),
      prefs: i.data as Prefs,
    }));
  }
  async getState(sub: string) {
    return (await this.get<UserState>(sub, 'STATE')) ?? {};
  }
  async putState(sub: string, s: UserState) {
    await this.put(sub, 'STATE', { ...(await this.getState(sub)), ...s });
  }
  async listSubs(sub: string) {
    return (await this.query(sub, 'PUSHSUB#')).map((i) => i.data as PushSub);
  }
  async putSub(sub: string, s: PushSub) {
    await this.put(sub, `PUSHSUB#${subKey(s.endpoint)}`, s);
  }
  async deleteSub(sub: string, endpoint: string) {
    await this.del(sub, `PUSHSUB#${subKey(endpoint)}`);
  }
}
