import React from 'react';
import { subscriptionStoreUrl } from './subscribeNavigation.js';
import { farmHoldDateLabel, pickupDateLabel } from './turkeyPickup.js';

export function TurkeyPickupInfo({ catalog }) {
  const { sale, pickups, pickupGroups } = catalog;
  const date = pickupDateLabel(sale.pickupDate);
  const holdDate = farmHoldDateLabel(sale.pickupDate);
  const farmPickup = pickups.some(pickup => /\bfarm\b/i.test(pickup.name));
  return <section className="turkey-pickup-info" id="turkey-pickup-locations" aria-labelledby="turkey-pickup-title">
    <span className="turkey-eyebrow">Plan your Thanksgiving pickup</span>
    <h2 id="turkey-pickup-title">Available pickup locations</h2>
    <p className="turkey-pickup-intro">All turkeys ordered here will be delivered to the pickup location you choose on <strong>{date || 'the Saturday before Thanksgiving'}</strong>{date ? ', the Saturday before Thanksgiving' : ''}. Please make sure you can collect your order during that location’s listed pickup hours.</p>
    {pickups.length ? <div className="turkey-location-cards">{pickups.map(pickup => <article className="turkey-card turkey-location-card" key={pickup.id}>
      {pickupGroups.length > 1 && <span className="turkey-eyebrow">{pickupGroups.find(group => group.id === pickup.groupId)?.name}</span>}
      <h3>{pickup.name}</h3>
      {pickup.address && <p className="turkey-location-address">{pickup.address}</p>}
      {pickup.hours && <p><strong>Pickup hours:</strong> {pickup.hours} · Pacific time</p>}
      {pickup.instructions && <p className="turkey-location-instructions">{pickup.instructions}</p>}
    </article>)}</div> : <p>Pickup locations will be listed here when they are available at checkout.</p>}
    <div className="turkey-pickup-notes">
      <section><h3>CSA member delivery</h3><p>CSA members can order through the <a href={subscriptionStoreUrl()}>CSA store</a> as usual for delivery now, with their next CSA order. You’ll need to store your turkey in your home freezer until Thanksgiving.</p><p><strong>Orders placed on this turkey site are for pickup at the locations listed above on {date || 'the Saturday before Thanksgiving'}. Member credit cannot be applied here.</strong></p></section>
      {farmPickup && <section><h3>Need a later farm pickup?</h3><p>Choose Farm Pickup at checkout, then {sale.contactEmail ? <a href={`mailto:${sale.contactEmail}?subject=${encodeURIComponent('Turkey preorder — farm pickup hold request')}`}>email the farm</a> : 'email the farm'} to request a hold and arrange a pickup time. With the farm’s confirmation, your turkey can be held after Saturday for collection through <strong>{holdDate || 'the day before Thanksgiving'}</strong>{holdDate ? ', the day before Thanksgiving' : ''}.</p></section>}
    </div>
  </section>;
}
