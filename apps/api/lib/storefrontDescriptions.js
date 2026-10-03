export const TURKEY_PICKUP_DESCRIPTION = 'Turkeys ordered here will be delivered to your selected pickup location on the Saturday before Thanksgiving. Choose your pickup location at checkout, then collect your turkey during that location’s listed pickup hours.';

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
