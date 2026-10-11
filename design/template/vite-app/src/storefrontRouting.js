export function usesAdminPortal(href) {
  const url = new URL(href);
  const route = url.hash.replace(/^#\/?/, '').split('?')[0];
  // Emailed password-reset links still use the shared account recovery screen.
  if (route === 'reset-password') return false;
  const pathRoute = url.pathname.replace(/^\//, '').split('/')[0];
  return url.hostname === 'admin.deckfamilyfarm.com' || pathRoute === 'admin' || url.searchParams.get('experience') === 'admin';
}

export function usesTurkeyStorefront(href) {
  if (usesAdminPortal(href)) return false;
  const url = new URL(href);
  const route = url.hash.replace(/^#\/?/, '').split('?')[0];
  const reserved = ['admin', 'account', 'subscribe', 'dropsites', 'reset-password'];
  const pathRoute = url.pathname.replace(/^\//, '').split('/')[0];
  if (reserved.includes(route) || reserved.includes(pathRoute) || route.startsWith('liability/') || pathRoute === 'liability') return false;
  if (['subscribe','dropsites','store'].includes(url.searchParams.get('experience'))) return false;
  return url.hostname === 'turkeys.deckfamilyfarm.com' || pathRoute === 'turkeys' || url.searchParams.get('experience') === 'turkeys' || route === 'turkeys' || route.startsWith('turkeys/');
}
