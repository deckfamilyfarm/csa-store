export const TURKEY_PICKUP_DESCRIPTION = 'Turkeys ordered here will be delivered to your selected pickup location on the Saturday before Thanksgiving. Choose your pickup location at checkout, then collect your turkey during that location’s listed pickup hours.';

const LEGACY_TURKEY_INTRO = 'Reserve your Deck Family Farm turkey for Saturday pickup.';

export const DEFAULT_TURKEY_ABOUT_DESCRIPTION = `At Deck Family Farm, our turkeys are raised on pasture, where grass, herbs, and clover can make up to 20% of their diet.

We move our birds daily to fresh forage, keeping them well-fed and happy. At night, they are housed to help protect them from predators.`;

export function turkeyAboutDescription(sale = {}) {
  const description = sale.about_description ?? sale.description;
  return !description?.trim() || description.trim() === LEGACY_TURKEY_INTRO
    ? DEFAULT_TURKEY_ABOUT_DESCRIPTION : description;
}

export const DEFAULT_HERITAGE_DESCRIPTION = `Heritage Black turkeys, raised on organic pastures and given time to grow slowly. With a higher proportion of dark meat and a smaller breast, they offer rich, full turkey flavor. A wonderful centerpiece for those who enjoy a traditional bird and savor the dark meat.\n\n${TURKEY_PICKUP_DESCRIPTION}`;

export const DEFAULT_BROAD_BREASTED_DESCRIPTION = `Broad Breasted White turkeys, raised on organic pastures. These turkeys have generous breasts with plenty of tender, mild-flavored white meat, alongside flavorful dark meat in the legs and thighs. A classic Thanksgiving centerpiece with plenty to share around the table.\n\n${TURKEY_PICKUP_DESCRIPTION}`;

export function turkeyBreed(name) {
  if (/\bheritage\b|\bblack\s+turkeys?\b/i.test(name || '')) return 'heritage';
  if (/\bbroad[\s-]+breasted[\s-]+white\b/i.test(name || '')) return 'broad-breasted-white';
  return null;
}

export function preorderDescriptions(sale = {}) {
  return {
    heritageDescription: sale.heritage_description || DEFAULT_HERITAGE_DESCRIPTION,
    broadBreastedDescription: sale.broad_breasted_description || DEFAULT_BROAD_BREASTED_DESCRIPTION
  };
}

export function turkeyDescription(breed, descriptions) {
  if (breed === 'heritage') return descriptions.heritageDescription;
  if (breed === 'broad-breasted-white') return descriptions.broadBreastedDescription;
  return TURKEY_PICKUP_DESCRIPTION;
}
