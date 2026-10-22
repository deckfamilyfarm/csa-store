import test from "node:test";
import assert from "node:assert/strict";
import { activateEnterprisePricingLocally } from "./enterprisePricingService.js";

test("local price activation refuses connected environments before opening a database", async () => {
  const previous = process.env.CSA_LOCAL_ONLY;
  delete process.env.CSA_LOCAL_ONLY;
  try {
    await assert.rejects(() => activateEnterprisePricingLocally(1, { userId: 1 }),
      error => error.status === 403 && /isolated local mode/.test(error.message));
  } finally {
    if (previous === undefined) delete process.env.CSA_LOCAL_ONLY;
    else process.env.CSA_LOCAL_ONLY = previous;
  }
});
