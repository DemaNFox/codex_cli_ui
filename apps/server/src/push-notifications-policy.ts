const PUSH_PROVIDER_HOSTS = new Set([
  'android.googleapis.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443')
    )
      return false;
    const hostname = url.hostname.toLowerCase();
    return (
      PUSH_PROVIDER_HOSTS.has(hostname) ||
      hostname === 'notify.windows.com' ||
      hostname.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}
