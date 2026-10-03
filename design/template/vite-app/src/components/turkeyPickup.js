export const DEFAULT_TURKEY_INTRO = 'Reserve your Deck Family Farm turkey for Saturday pickup.';

export function pickupDateLabel(date) {
  if (!date) return '';
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}

export function turkeyPickupIntro(description, date) {
  const when = pickupDateLabel(date);
  const schedule = when ? `${when}, the Saturday before Thanksgiving` : 'the Saturday before Thanksgiving';
  const introduction = !description || description.trim() === DEFAULT_TURKEY_INTRO
    ? `Reserve your Deck Family Farm turkey for pickup on ${schedule}.`
    : `${description}\n\nPickup is on ${schedule}.`;
  return `${introduction} See below for available pickup locations.`;
}

export function farmHoldDateLabel(pickupDate) {
  if (!pickupDateLabel(pickupDate)) return '';
  const year = Number(pickupDate.slice(0, 4));
  const firstNovemberDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  // US Thanksgiving is November's fourth Thursday. Holds end the preceding day.
  const day = 1 + (4 - firstNovemberDay + 7) % 7 + 21 - 1;
  return pickupDateLabel(`${year}-11-${String(day).padStart(2, '0')}`);
}
