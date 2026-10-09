// One reviewed match/price approval, using persisted Product Sync action IDs.
// Checkpoints contain no credentials and allow an interrupted request to resume.
const cents = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
const stop = (message, needsReview = false) => Object.assign(new Error(message), { needsReview });
const sameId = (a, b) => String(a) === String(b);

export function localRetailPriceForMatch(row) {
  // Both keys describe the vendor's retail price, never a guest/member price.
  return row.localRetailPrice || row.csaRetailPrice || null;
}

export function squareMatchPriceIssue(row, candidate) {
  const retail = localRetailPriceForMatch(row);
  if (!retail) return "The server has not returned the local retail price. Refresh after the API has restarted.";
  if (!Number.isInteger(retail.amount) || retail.amount < 0) return "The local store retail price is missing. Set Retail Price in Products before updating Square.";
  if (!candidate) return "Choose a Square variation to compare prices.";
  if (candidate.pricingType !== "FIXED_PRICING" || !Number.isInteger(candidate.priceAmount)) return "The selected Square variation has no fixed price. Refresh Square Catalog and review the variation.";
  if (!retail.currency || !candidate.currency) return "A price currency is missing. Refresh the prices before updating Square.";
  if (candidate.currency !== retail.currency) return `The currencies differ: local retail uses ${retail.currency}, and Square uses ${candidate.currency}. Review the Square variation.`;
  return "";
}

export function squareMatchChoices(row) {
  const candidates = row.candidates || [];
  return row.linked && !candidates.some(c => c.squareVariationId === row.linked.squareVariationId)
    ? [{ ...row.linked, score: row.linked.matchScore }, ...candidates] : candidates;
}

export function newSquareMatchPublication(row, candidate) {
  const issue = squareMatchPriceIssue(row, candidate);
  if (issue) throw stop(issue, true);
  const amount = localRetailPriceForMatch(row).amount;
  return {
    productId: row.productId, packageId: row.packageId, productName: row.productName,
    squareItemId: candidate.squareItemId, squareVariationId: candidate.squareVariationId,
    matchScore: candidate.score, currency: candidate.currency,
    expectedCurrentAmount: candidate.priceAmount, expectedProposedAmount: amount,
    linked: row.linked?.squareVariationId === candidate.squareVariationId,
    phase: "Saving match"
  };
}

export async function publishSquareMatch(initial, { get, post, checkpoint, onRelease = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), signal, maxPolls = 240 }) {
  let state = { ...initial };
  const checkActive = () => { if (signal?.aborted) throw stop("The update was interrupted. Resume it to check its saved progress."); };
  const save = patch => { state = { ...state, ...patch }; checkpoint(state); };
  const read = async path => { checkActive(); return get(path); };
  const write = async (path, body) => { checkActive(); return post(path, body); };
  save({});
  if (!state.linked) {
    await write("square/matches/approve", {
      productId: state.productId, packageId: state.packageId, squareItemId: state.squareItemId,
      squareVariationId: state.squareVariationId, matchScore: state.matchScore
    });
    save({ linked: true, phase: "Checking prices" });
  }
  if (!state.auditId) {
    const audit = await write("product-sync/audits", {
      platforms: ["square"], productIds: [state.productId], productScope: "selected", vendorGroup: "all"
    });
    save({ auditId: audit.id, phase: "Checking prices" });
  }
  if (!state.actionId) {
    let audit;
    for (let i = 0; i < maxPolls; i++) {
      audit = await read(`product-sync/audits/${state.auditId}`);
      if (audit?.status !== "running") break;
      await wait(1250);
    }
    if (audit?.status === "running") throw stop("The match is saved and the price check is still running. Resume to continue.");
    if (!["completed", "partial"].includes(audit?.status)) throw stop(`The match is saved, but its price check failed. ${audit?.error || "Refresh the prices and try again."}`, true);
    const result = await read(`product-sync/audits/${state.auditId}/actions?platform=square&direction=outgoing&pageSize=100`);
    const action = (result.rows || []).find(a => sameId(a.productId, state.productId) && sameId(a.packageId, state.packageId) && a.kind === "price");
    if (!action || action.mapping?.squareItemId !== state.squareItemId || action.mapping?.squareVariationId !== state.squareVariationId) throw stop("The Square match changed during the price check. Refresh and review the match again.", true);
    const current = cents(action.display?.current?.price), proposed = cents(action.display?.proposed?.price);
    if (action.display?.proposed?.currency !== state.currency || action.display?.current?.currency !== state.currency || proposed !== state.expectedProposedAmount) {
      throw stop("The local store retail price changed since it was displayed. The match is saved; refresh and review the new price before updating Square.", true);
    }
    if (action.status === "synced" && current === proposed) return { ...state, phase: "Completed", alreadyMatched: true };
    if (current !== state.expectedCurrentAmount) throw stop("The Square price changed since it was displayed. The match is saved; refresh and review the new price before updating Square.", true);
    if (action.status !== "changed") throw stop(`The match is saved, but the price update needs review. ${action.message || action.status}`, true);
    save({ actionId: action.id, phase: "Starting price update" });
  }
  let receipt;
  if (!state.releaseId) {
    // Recover a committed release if the browser lost its original response.
    receipt = await read(`product-sync/audits/${state.auditId}/actions/${state.actionId}/release`);
    if (!receipt) {
      receipt = await write("product-sync/releases", {
        auditId: state.auditId, actionIds: [state.actionId],
        name: `Square link and price: ${state.productName}`, background: true
      });
    }
    save({ releaseId: receipt.id, phase: "Updating Square price" });
    onRelease(receipt);
  } else receipt = await read(`product-sync/releases/${state.releaseId}/progress`);
  if (["failed", "scheduled"].includes(receipt.status)) {
    receipt = await write(`product-sync/releases/${state.releaseId}/retry`, { background: true });
    onRelease(receipt);
  }
  for (let i = 0; i < maxPolls; i++) {
    const action = (receipt.actions || []).find(a => sameId(a.id, state.actionId));
    if (receipt.status === "completed" && action?.status === "completed") return { ...state, phase: "Completed", release: receipt };
    if (!["queued", "running"].includes(receipt.status)) {
      throw stop(`The match is saved, but Square’s price update is ${action?.status || receipt.status}. ${action?.message || "Review the release in Product Sync."}`, receipt.status === "cancelled");
    }
    save({ phase: action?.message || "Waiting for Square confirmation" });
    await wait(1250);
    receipt = await read(`product-sync/releases/${state.releaseId}/progress`);
  }
  throw stop(`Release #${state.releaseId} is still running. Resume to check its result, or view it in Product Sync.`);
}
