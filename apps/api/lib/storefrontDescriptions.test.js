import assert from 'node:assert/strict';
import test from 'node:test';
import { turkeyBreed, preorderDescriptions, turkeyDescription, TURKEY_PICKUP_DESCRIPTION } from './storefrontDescriptions.js';

test('all sizes of each turkey breed share the local preorder copy', () => {
  const descriptions = preorderDescriptions();
  for (const size of ['Small', 'Medium', 'Large']) {
    assert.equal(turkeyDescription(turkeyBreed(`Heritage Thanksgiving Turkeys, ${size}`), descriptions), descriptions.heritageDescription);
    assert.equal(turkeyDescription(turkeyBreed(`Broad Breasted White Thanksgiving Turkeys, ${size}`), descriptions), descriptions.broadBreastedDescription);
  }
  assert.equal(turkeyBreed('Black turkeys'), 'heritage');
  assert.equal(turkeyBreed('Broad-Breasted White Turkey'), 'broad-breasted-white');
  assert.match(descriptions.heritageDescription, /dark meat and a smaller breast/);
  assert.match(descriptions.broadBreastedDescription, /mild-flavored white meat/);
  for (const description of Object.values(descriptions)) {
    assert.match(description, /organic pastures/);
    assert.ok(description.endsWith(TURKEY_PICKUP_DESCRIPTION));
  }
});

test('custom preorder descriptions override defaults without using catalog copy', () => {
  const descriptions = preorderDescriptions({ heritage_description: 'Custom heritage pickup copy', broad_breasted_description: 'Custom white turkey pickup copy' });
  assert.equal(turkeyDescription('heritage', descriptions), 'Custom heritage pickup copy');
  assert.equal(turkeyDescription('broad-breasted-white', descriptions), 'Custom white turkey pickup copy');
  assert.equal(turkeyDescription(turkeyBreed('Turkey'), descriptions), TURKEY_PICKUP_DESCRIPTION);
});
