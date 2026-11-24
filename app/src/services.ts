import { httpApi } from './lib/api';
import { createCognitoAuth } from './lib/auth';
import { createMockServices } from './lib/mock';
import { createPushService } from './lib/push';
import type { Services } from './types';

export function createServices(): Services {
  if (import.meta.env.VITE_MOCK) return createMockServices();
  return {
    auth: createCognitoAuth(
      import.meta.env.VITE_USER_POOL_ID as string,
      import.meta.env.VITE_USER_POOL_CLIENT_ID as string,
    ),
    api: httpApi,
    push: createPushService(import.meta.env.VITE_VAPID_PUBLIC_KEY as string),
  };
}
