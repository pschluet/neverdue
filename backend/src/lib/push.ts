import webpush from 'web-push';
import type { PushSub } from './types.js';

export interface Pusher {
  /** Resolves 'gone' when the push service says the subscription no longer exists. */
  send(sub: PushSub, payload: { title: string; body: string }): Promise<'ok' | 'gone'>;
}

export function createPusher(publicKey: string, privateKey: string): Pusher {
  webpush.setVapidDetails('mailto:no-reply@pauldev.io', publicKey, privateKey);
  return {
    async send(sub, payload) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        return 'ok';
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return 'gone';
        throw e;
      }
    },
  };
}
