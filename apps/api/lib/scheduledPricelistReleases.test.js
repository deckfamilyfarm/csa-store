import test from "node:test";
import assert from "node:assert/strict";
import { pushItemRemote } from "./scheduledPricelistReleases.js";

function fixture(pushProduct) {
  const writes = [];
  let released = 0;
  const db = {};
  return {
    writes,
    released: () => released,
    options: {
      db,
      pushProduct,
      pool: {
        getConnection: async () => ({
          query: async (sql, params) => {
            writes.push({ sql, params });
          },
          release: () => {
            released += 1;
          },
        }),
      },
    },
  };
}

test("scheduled pushes record the confirmed create/update result and remote product ID", async () => {
  const f = fixture(async (db, id) => {
    assert.equal(id, 42);
    assert.equal(db, f.options.db);
    return { ok: true, localLineProductId: 1164232, imagesOk: true };
  });
  const result = await pushItemRemote({ id: 8, productId: 42 }, f.options);
  assert.equal(result.ok, true);
  assert.equal(f.writes[0].params[0], "applied");
  assert.match(f.writes[0].params[1], /1164232/);
  assert.equal(f.writes[1].params[0], "remote_applied");
  assert.equal(
    JSON.parse(f.writes[1].params[2]).remoteResult.localLineProductId,
    1164232,
  );
  assert.equal(f.released(), 1);
});

test("an unconfirmed scheduled push cannot be marked applied", async () => {
  const f = fixture(async () => ({ ok: true, localLineProductId: null }));
  const result = await pushItemRemote({ id: 8, productId: 42 }, f.options);
  assert.equal(result.ok, false);
  assert.ok(f.writes.every((write) => write.params[0] === "failed"));
});

test("scheduled post-create failures keep the detailed error for retry", async () => {
  const f = fixture(async () => {
    throw new Error(
      "Local Line image upload failed after linking product 1164232",
    );
  });
  const result = await pushItemRemote({ id: 8, productId: 42 }, f.options);
  assert.equal(result.ok, false);
  assert.match(result.message, /image upload failed/);
  assert.ok(f.writes.every((write) => write.params[0] === "failed"));
  assert.ok(
    f.writes[1].params.some(
      (value) => typeof value === "string" && value.includes("1164232"),
    ),
  );
  assert.equal(f.released(), 1);
});
