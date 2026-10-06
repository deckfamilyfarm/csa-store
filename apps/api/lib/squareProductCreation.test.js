import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSquareCreationPreview, squareCreationRequest, creationLinks } from "./squareProductCreation.js";

const product = { productId: 7, productName: "Classic Meatballs", vendorId: 1, vendorName: "Hyland",
  vendor: { id: 1, name: "Hyland", sourceMultiplier: 0.54, guestMarkup: 2 },
  profile: { sourceUnitPrice: 10, unitOfMeasure: "lbs", minWeight: 3, maxWeight: 5, onSale: 1, saleDiscount: 0.1 } };
const packages = [{ id: 70, name: "One pound", price: 35, numOfItems: 3, packageCode: "MB" }, { id: 71, name: "Two pounds", price: 70 }];

test("creation uses discounted vendor retail per variation, without CSA factors, markups, or package weights", () => {
  const preview = buildSquareCreationPreview(product, packages);
  assert.deepEqual(preview.variations.map(row => row.amount), [900, 900]);
  assert.ok(preview.variations.every(row => row.priceBasis === "vendor-retail-price"));
  const standard = buildSquareCreationPreview({ ...product, vendorName: "Other", vendor: { name: "Other" } }, packages);
  assert.deepEqual(standard.variations.map(row => row.amount), [3150, 6300]);
  assert.throws(() => buildSquareCreationPreview({ ...product, profile: {} }, packages), /Retail Price/);
});
test("ineligible products, invalid prices, missing vendors, and ambiguous packages cannot be created", () => {
  for (const source of [null, { ...product, isDeleted: 1 }, { ...product, categoryName: "Membership" }, { ...product, vendorName: "" }]) {
    assert.throws(() => buildSquareCreationPreview(source, packages));
  }
  assert.throws(() => buildSquareCreationPreview(product, []));
  assert.throws(() => buildSquareCreationPreview(product, [packages[0], { ...packages[1], name: packages[0].name }]), /distinct name/);
  assert.throws(() => buildSquareCreationPreview({ ...product, profile: { sourceUnitPrice: -1 } }, packages), /valid retail price/);
});
test("creation freezes one item with temporary variation IDs and no stock, images, or online settings", () => {
  const preview = buildSquareCreationPreview(product, packages);
  const request = squareCreationRequest(preview, "stable-key");
  assert.equal(request.idempotency_key, "stable-key");
  assert.equal(request.object.id, "#product-7");
  assert.equal(request.object.item_data.variations.length, 2);
  assert.deepEqual(request.object.item_data.variations[0].item_variation_data, {
    item_id: "#product-7", name: "One pound", sku: "MB", pricing_type: "FIXED_PRICING", price_money: { amount: 900, currency: "USD" }
  });
  assert.doesNotMatch(JSON.stringify(request), /track_inventory|ecom_visibility|image_ids|inventory_count/);
});
test("new items and every variation are available at all locations even when one location is configured", t => {
  const previous = process.env.SQUARE_LOCATION_ID;
  t.after(() => { if (previous === undefined) delete process.env.SQUARE_LOCATION_ID; else process.env.SQUARE_LOCATION_ID = previous; });
  process.env.SQUARE_LOCATION_ID = "single-location";
  const preview = buildSquareCreationPreview(product, packages);
  assert.equal(preview.presentAtAllLocations, true);
  const request = squareCreationRequest(preview, "all-locations-key");
  for (const object of [request.object, ...request.object.item_data.variations]) {
    assert.equal(object.present_at_all_locations, true);
    assert.equal(Object.hasOwn(object, "present_at_location_ids"), false);
    assert.equal(Object.hasOwn(object, "absent_at_location_ids"), false);
  }
});
test("links require matching IDs, parent, names, SKUs and confirmed frozen prices", () => {
  const preview = buildSquareCreationPreview(product, packages);
  const confirmed = structuredClone(squareCreationRequest(preview, "key").object);
  confirmed.id = "ITEM";
  confirmed.item_data.variations.forEach((row, i) => { row.id = `V${i}`; row.item_variation_data.item_id = "ITEM"; });
  const receipt = { id_mappings: [{ client_object_id: "#product-7", object_id: "ITEM" },
    ...packages.map((row, i) => ({ client_object_id: `#package-${row.id}`, object_id: `V${i}` }))] };
  assert.equal(creationLinks(preview, receipt, confirmed).length, 2);
  for (const mutate of [
    obj => { obj.is_deleted = true; },
    obj => { obj.present_at_all_locations = false; },
    obj => { obj.item_data.variations[0].present_at_all_locations = false; },
    obj => { obj.item_data.variations[0].absent_at_location_ids = ["excluded-location"]; },
    obj => { obj.item_data.variations[0].item_variation_data.price_money.amount++; },
    obj => { obj.item_data.variations[0].item_variation_data.item_id = "OTHER"; },
    obj => { obj.item_data.variations.pop(); }
  ]) { const changed = structuredClone(confirmed); mutate(changed); assert.throws(() => creationLinks(preview, receipt, changed)); }
  assert.throws(() => creationLinks(preview, { id_mappings: [] }, confirmed));
  const legacyPreview = { ...preview }; delete legacyPreview.presentAtAllLocations;
  const legacyItem = structuredClone(confirmed);
  for (const object of [legacyItem, ...legacyItem.item_data.variations]) {
    object.present_at_all_locations = false; object.present_at_location_ids = ["original-location"];
  }
  assert.equal(creationLinks(legacyPreview, receipt, legacyItem).length, 2);
});
