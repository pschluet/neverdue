import { QueryClient, useQuery } from '@tanstack/react-query';
import type { Api } from '../types';

// Tab switches reuse cached data; window focus after the stale time still refetches.
export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000, retry: 1 } } });

export const keys = {
  me: ['me'],
  loans: ['loans'],
  adminUsers: ['admin', 'users'],
  prefs: ['prefs'],
} as const;

export const useMe = (api: Api) => useQuery({ queryKey: keys.me, queryFn: () => api.getMe() });
export const useLoans = (api: Api) =>
  useQuery({ queryKey: keys.loans, queryFn: () => api.getLoans() });
export const useAdminUsers = (api: Api) =>
  useQuery({ queryKey: keys.adminUsers, queryFn: () => api.adminListUsers() });
export const usePrefs = (api: Api) =>
  useQuery({ queryKey: keys.prefs, queryFn: () => api.getPrefs() });
