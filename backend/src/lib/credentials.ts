import {
  DeleteParameterCommand,
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { Credentials } from './types.js';

export interface CredentialStore {
  get(sub: string, accountId: string): Promise<Credentials>;
  put(sub: string, accountId: string, creds: Credentials): Promise<void>;
  delete(sub: string, accountId: string): Promise<void>;
  /** Removes every credential the user owns. */
  deleteAll(sub: string): Promise<void>;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Path is built from the JWT sub and a server-generated ULID only. */
export function credentialPath(sub: string, accountId: string): string {
  if (!ULID.test(accountId)) throw new Error('Invalid account id');
  if (!/^[A-Za-z0-9-]+$/.test(sub)) throw new Error('Invalid user id');
  return `/neverdue/users/${sub}/accounts/${accountId}`;
}

export class SsmCredentialStore implements CredentialStore {
  constructor(private readonly ssm = new SSMClient({})) {}

  async get(sub: string, accountId: string) {
    const r = await this.ssm.send(
      new GetParameterCommand({ Name: credentialPath(sub, accountId), WithDecryption: true }),
    );
    return JSON.parse(r.Parameter?.Value ?? '{}') as Credentials;
  }
  async put(sub: string, accountId: string, creds: Credentials) {
    await this.ssm.send(
      new PutParameterCommand({
        Name: credentialPath(sub, accountId),
        Value: JSON.stringify(creds),
        Type: 'SecureString',
        Overwrite: true,
      }),
    );
  }
  async delete(sub: string, accountId: string) {
    try {
      await this.ssm.send(new DeleteParameterCommand({ Name: credentialPath(sub, accountId) }));
    } catch (e) {
      if ((e as Error).name !== 'ParameterNotFound') throw e;
    }
  }
  async deleteAll(sub: string) {
    if (!/^[A-Za-z0-9-]+$/.test(sub)) throw new Error('Invalid user id');
    let NextToken: string | undefined;
    do {
      const page = await this.ssm.send(
        new GetParametersByPathCommand({
          Path: `/neverdue/users/${sub}`,
          Recursive: true,
          NextToken,
        }),
      );
      const names = (page.Parameters ?? []).map((p) => p.Name!).filter(Boolean);
      for (let i = 0; i < names.length; i += 10)
        await this.ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
      NextToken = page.NextToken;
    } while (NextToken);
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly map = new Map<string, Credentials>();
  async get(sub: string, id: string) {
    const c = this.map.get(credentialPath(sub, id));
    if (!c) throw new Error('ParameterNotFound');
    return c;
  }
  async put(sub: string, id: string, c: Credentials) {
    this.map.set(credentialPath(sub, id), c);
  }
  async delete(sub: string, id: string) {
    this.map.delete(credentialPath(sub, id));
  }
  async deleteAll(sub: string) {
    const prefix = `/neverdue/users/${sub}/`;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}
