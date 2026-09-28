import assert from "node:assert/strict";
import { test } from "node:test";
import { requireVendorId, validateVendorAssignment, validateSavedProductVendor, matchLocalLineVendor, confirmLocalLineVendor } from "./productVendor.js";

test("local saves require an existing named vendor, including updates that omit vendorId", async () => {
  const vendor = { id: 7, name: "Farm" };
  const product = { id: 1, vendorId: null };
  const connection = { query: async (sql, params) => [sql.includes("FROM products") ? [product] : params[0] === vendor.id ? [vendor] : []] };
  for (const value of [undefined, null, "", " ", 0, -1, 1.2, true, [], {}]) assert.throws(() => requireVendorId(value), /vendor is required/);
  await assert.rejects(validateVendorAssignment(connection, 99), /assigned vendor is invalid/);
  await assert.rejects(validateSavedProductVendor(connection, 1), /vendor is required/);
  product.vendorId = 7;
  assert.deepEqual(await validateSavedProductVendor(connection, 1), vendor);
  assert.deepEqual(await validateVendorAssignment(connection, "7"), vendor);
  vendor.name = " ";
  await assert.rejects(validateSavedProductVendor(connection, 1), /assigned vendor is invalid/);
});

test("Local Line vendor matching never treats an unrelated local ID as a remote match", () => {
  const product = { vendorId: 7 }, vendor = { id: 7, name: "Farm" };
  assert.equal(matchLocalLineVendor(product, vendor, [{ id: 7, name: "Other" }, { id: 42, name: " farm " }]), 42);
  assert.throws(() => matchLocalLineVendor(product, vendor, [{ id: 7, name: "Other" }]), /no matching vendor/);
  assert.throws(() => matchLocalLineVendor(product, vendor, [{ id: 42, name: "Farm" }, { id: 43, name: "Farm" }]), /multiple matches/);
  assert.equal(matchLocalLineVendor(product, vendor, [{ id: 7, name: "Farm" }, { id: 43, name: "Farm" }]), 7);
});

test("remote confirmation requires the expected vendor, including expanded API responses", () => {
  for (const vendor of [7, "7", { id: 7, name: "Farm" }]) confirmLocalLineVendor({ vendor }, 7);
  for (const vendor of [null, undefined, 0, 8, { id: 8 }]) assert.throws(() => confirmLocalLineVendor({ vendor }, 7), /did not confirm/);
});
