import { fetchAuthSession } from 'aws-amplify/auth';
import type { Api } from '../types';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const httpApi: Api = {
  getMe: () => call('GET', '/me'),
  adminListUsers: async () => (await call<{ users: never[] }>('GET', '/admin/users')).users,
  adminInviteUser: async (email) => void (await call('POST', '/admin/users', { email })),
  adminSetUserEnabled: async (sub, enabled) =>
    void (await call('PATCH', `/admin/users/${encodeURIComponent(sub)}`, { enabled })),
  adminDeleteUser: async (sub) =>
    void (await call('DELETE', `/admin/users/${encodeURIComponent(sub)}`)),
  getLoans: () => call('GET', '/loans'),
  addAccount: async (input) => (await call<{ account: never }>('POST', '/accounts', input)).account,
  updateAccount: async (id, patch) =>
    (await call<{ account: never }>('PATCH', `/accounts/${id}`, patch)).account,
  deleteAccount: async (id) => void (await call('DELETE', `/accounts/${id}`)),
  renew: async (id, checkoutIds) =>
    (await call<{ results: never[] }>('POST', `/accounts/${id}/renew`, { checkoutIds })).results,
  refresh: async () => void (await call('POST', '/refresh')),
  getPrefs: () => call('GET', '/prefs'),
  putPrefs: async (prefs) => void (await call('PUT', '/prefs', prefs)),
  addPushSubscription: async (sub) => void (await call('POST', '/push-subscriptions', sub)),
  removePushSubscription: async (endpoint) =>
    void (await call('DELETE', '/push-subscriptions', { endpoint })),
};
