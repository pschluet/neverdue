import type { PushService, PushSubscriptionJson } from '../types';

export function isIos(ua = navigator.userAgent, maxTouch = navigator.maxTouchPoints) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouch > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** On iOS, web push only works once the app is on the Home Screen. */
export function pushStatus(): 'ready' | 'needs-install' | 'unsupported' {
  if (isIos() && !isStandalone()) return 'needs-install';
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return 'unsupported';
  }
  return 'ready';
}

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function createPushService(vapidPublicKey: string): PushService {
  const registration = () => navigator.serviceWorker.ready;
  return {
    status: pushStatus,
    async isSubscribed() {
      if (pushStatus() !== 'ready') return false;
      return Boolean(await (await registration()).pushManager.getSubscription());
    },
    async subscribe() {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted');
      const reg = await registration();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      return sub.toJSON() as PushSubscriptionJson;
    },
    async unsubscribe() {
      const sub = await (await registration()).pushManager.getSubscription();
      if (!sub) return null;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      return endpoint;
    },
  };
}
