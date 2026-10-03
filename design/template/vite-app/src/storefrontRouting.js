export function usesTurkeyStorefront(href) {
  const url = new URL(href);
  const route = url.hash.replace(/^#\/?/, '').split('?')[0];
  const reserved = ['admin', 'account', 'subscribe', 'dropsites', 'reset-password'];
  const pathRoute = url.pathname.replace(/^\//, '').split('/')[0];
  if (reserved.includes(route) || reserved.includes(pathRoute) || route.startsWith('liability/') || pathRoute === 'liability') return false;
  if (['subscribe','dropsites','store'].includes(url.searchParams.get('experience'))) return false;
  return url.hostname === 'turkeys.deckfamilyfarm.com' || pathRoute === 'turkeys' || url.searchParams.get('experience') === 'turkeys' || route === 'turkeys' || route.startsWith('turkeys/');
}
