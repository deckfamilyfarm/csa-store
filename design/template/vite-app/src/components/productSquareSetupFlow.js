import { canSyncPlatforms } from './productPricingSyncFlow.js';

const has = (roles, role) => roles.includes('admin') || roles.includes(role);
export const canReadSquareSetup = (roles = []) => roles.some(role => ['admin', 'square_pull', 'square_push', 'pricing_admin'].includes(role));
export const canLinkSquare = (roles = []) => has(roles, 'square_pull');
export const canCreateSquare = (roles = []) => has(roles, 'square_pull') && has(roles, 'square_push');
export const availableSquareLink = row => Boolean(row.linked?.squareVariationId && row.linked?.pricingType);
export const squareSetupReady = setup => Boolean(setup?.enabled && setup.rows?.length && setup.rows.every(availableSquareLink));
export const recoverableSquareCreation = creation => ['sending', 'created'].includes(creation?.status);

export async function previewProductSquareCreation({ productId, roles, get, post }) {
  if (!canCreateSquare(roles)) throw new Error('Square Pull and Square Push access are required to create and link a product.');
  const [current, setup] = await Promise.all([
    get(`enterprise-pricing/products/${productId}/sync`),
    get(`enterprise-pricing/products/${productId}/square-setup`)
  ]);
  // Recover the frozen original before checking or approving newer prices.
  if (recoverableSquareCreation(setup.creation) || setup.creation?.status === 'completed') return setup.creation;
  if (current.localOnly) throw new Error('Remote updates are disabled in local test mode.');
  if (!setup.enabled) throw new Error('The Square connection is not configured.');
  if (!current.revisionId || !current.input?.squareEnabled) throw new Error('Save complete pricing with Square enabled before creating this item.');
  if (setup.rows?.some(row => row.linked)) throw new Error('This product already has a Square link. Match its remaining packages to the existing item.');
  if (['pending', 'local-preview'].includes(current.revisionStatus)) {
    if (!canSyncPlatforms(roles, ['square'])) throw new Error('A Pricing Publisher with Square Push must approve the saved pricing before creation.');
    await post(`enterprise-pricing/revisions/${current.revisionId}/approve-channels`, { platforms: ['square'] });
  }
  const preview = await post('square/products/preview', { productId: Number(productId) });
  if (Number(preview.productId) !== Number(productId)) throw new Error('The Square creation preview belongs to another product. Refresh and review it.');
  return preview;
}

export async function approveProductSquareLink({ productId, roles, row, candidate, post }) {
  if (!canLinkSquare(roles)) throw new Error('Square Pull access is required to approve a match.');
  if (Number(row.productId) !== Number(productId) || !candidate?.squareItemId || !candidate?.squareVariationId)
    throw new Error('Choose a Square variation for this product’s package.');
  return post('square/matches/approve', { productId: Number(productId), packageId: Number(row.packageId),
    squareItemId: candidate.squareItemId, squareVariationId: candidate.squareVariationId, matchScore: candidate.score });
}

export async function finishProductSquareCreation({ productId, roles, creation, post }) {
  if (!canCreateSquare(roles)) throw new Error('Square Pull and Square Push access are required to create and link a product.');
  if (!creation?.id || Number(creation.productId) !== Number(productId)) throw new Error('Review the creation preview for this product first.');
  // Never generate a replacement request after an interrupted response.
  return post(`square/products/${encodeURIComponent(creation.id)}/create`, {});
}
