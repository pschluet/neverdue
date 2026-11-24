import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';

export interface DirectoryUser {
  sub: string;
  email: string;
  /** Cognito status, e.g. CONFIRMED or FORCE_CHANGE_PASSWORD (invited, never signed in). */
  status: string;
  enabled: boolean;
  createdAt?: string;
}

export class UserExistsError extends Error {}

export interface UserDirectory {
  list(): Promise<DirectoryUser[]>;
  create(email: string): Promise<DirectoryUser>;
  setEnabled(sub: string, enabled: boolean): Promise<void>;
  delete(sub: string): Promise<void>;
}

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;
const toUser = (u: UserType): DirectoryUser => ({
  sub: attr(u, 'sub') ?? '',
  email: attr(u, 'email') ?? u.Username ?? '',
  status: u.UserStatus ?? 'UNKNOWN',
  enabled: u.Enabled ?? true,
  createdAt: u.UserCreateDate?.toISOString(),
});

export class CognitoUserDirectory implements UserDirectory {
  constructor(
    private readonly poolId: string,
    private readonly cognito = new CognitoIdentityProviderClient({}),
  ) {}

  async list() {
    const users: DirectoryUser[] = [];
    let PaginationToken: string | undefined;
    do {
      const r = await this.cognito.send(
        new ListUsersCommand({ UserPoolId: this.poolId, PaginationToken }),
      );
      users.push(...(r.Users ?? []).map(toUser));
      PaginationToken = r.PaginationToken;
    } while (PaginationToken);
    return users;
  }

  async create(email: string) {
    try {
      const r = await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: this.poolId,
          Username: email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
      return toUser(r.User!);
    } catch (e) {
      if ((e as Error).name === 'UsernameExistsException') throw new UserExistsError();
      throw e;
    }
  }

  // The pool signs in by email, so a sub is also accepted as the Username.
  async setEnabled(sub: string, enabled: boolean) {
    const Cmd = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
    await this.cognito.send(new Cmd({ UserPoolId: this.poolId, Username: sub }));
  }

  async delete(sub: string) {
    await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId, Username: sub }));
  }
}

export class MemoryUserDirectory implements UserDirectory {
  readonly users: DirectoryUser[] = [];
  async list() {
    return structuredClone(this.users);
  }
  async create(email: string) {
    if (this.users.some((u) => u.email.toLowerCase() === email.toLowerCase()))
      throw new UserExistsError();
    const u: DirectoryUser = {
      sub: `user-${this.users.length + 1}`,
      email,
      status: 'FORCE_CHANGE_PASSWORD',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.users.push(u);
    return structuredClone(u);
  }
  async setEnabled(sub: string, enabled: boolean) {
    const u = this.users.find((x) => x.sub === sub);
    if (u) u.enabled = enabled;
  }
  async delete(sub: string) {
    const i = this.users.findIndex((x) => x.sub === sub);
    if (i >= 0) this.users.splice(i, 1);
  }
}
