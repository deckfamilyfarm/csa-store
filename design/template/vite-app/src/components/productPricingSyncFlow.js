export const canSyncLocalLine = (roles = []) => roles.includes('admin') ||
  (roles.includes('localline_push') && roles.some(role => ['pricing_admin', 'pricing_publisher'].includes(role)));

export const publicationRunning = release => ['queued', 'running'].includes(release?.status);
export function publicationMessage(release) {
  if (release.status === 'completed') return 'Synced — Local Line prices and sale verified.';
  if (release.status === 'queued') return 'Waiting for the server to start your update…';
  const labels = {
    'Checking local values, product match, and current remote values.': 'Fetching prices from Local Line and checking your saved changes…',
    'Applying approved values.': 'Updating prices and sale on Local Line…',
    'Confirming the published values with the destination.': 'Verifying the updated prices on Local Line…'
  };
  const messages = [...new Set((release.actions || []).filter(a => a.status !== 'completed').map(a => labels[a.message] || a.message).filter(Boolean))];
  return messages.join(' ') || (release.status === 'running' ? 'Updating prices on Local Line…' : 'Sync needs attention. Review the saved publication in Review & Publish.');
}

// Called only by an explicit Sync click. A retained audit/receipt recovers an
// uncertain submission before any new work is created. Progress GETs never write.
export async function syncProductLocalLine({ productId, data, resume, get, post, saveJob, progress,
  wait = () => new Promise(resolve => setTimeout(resolve, 1500)) }) {
  if (data.localOnly) throw new Error('Remote sync is disabled in local test mode.');
  let job = resume;
  if (!job) {
    if (!data.revisionId) throw new Error('Save complete pricing inputs before syncing.');
    if (data.syncBlocker) throw new Error(data.syncBlocker);
    progress('Checking saved prices and permissions…');
    if (['pending', 'local-preview'].includes(data.revisionStatus)) {
      await post(`enterprise-pricing/revisions/${data.revisionId}/approve-localline`, {});
    }
    progress('Fetching current prices from Local Line…');
    const audit = await post('product-sync/audits', { platforms: ['localline'], productIds: [Number(productId)],
      productScope: 'selected', vendorGroup: 'all', enterpriseRevisionId: data.revisionId,
      publicationScope: 'localline-prices-and-sales', incoming: false });
    job = { auditId: audit.id, revisionId: data.revisionId };
    saveJob(job);
  }
  if (job.releaseId) return get(`product-sync/releases/${job.releaseId}/progress`);
  progress('Fetching current prices from Local Line…');
  let audit = await get(`product-sync/audits/${job.auditId}`);
  while (audit.status === 'running') {
    await wait();
    audit = await get(`product-sync/audits/${job.auditId}`);
    progress('Fetching current prices from Local Line…');
  }
  const result = await get(`product-sync/audits/${job.auditId}/actions?direction=outgoing&pageSize=100`);
  const actions = result.rows || [];
  if (audit.error || audit.status !== 'completed' || !actions.length || actions.some(a =>
    a.platform !== 'localline' || Number(a.productId) !== Number(productId) || !['changed', 'synced'].includes(a.status))) {
    saveJob(null); // No publication was submitted for a blocked check.
    throw new Error([audit.error, ...actions.filter(a => !['changed', 'synced'].includes(a.status)).map(a => a.message)]
      .filter(Boolean).join(' ') || 'Local Line could not verify every package. Review package mappings before syncing.');
  }
  const receiptPath = `product-sync/audits/${job.auditId}/actions/${actions[0].id}/release`;
  progress('Sending saved prices and sale to Local Line…');
  // Failure to look up a receipt is not evidence that it does not exist.
  let release = await get(receiptPath);
  if (!release) {
    try {
      release = await post('product-sync/releases', { auditId: job.auditId, actionIds: actions.map(a => a.id),
        name: `Local Line product ${productId} · prices and sale`, background: true });
    } catch (error) {
      release = await get(receiptPath).catch(() => null);
      if (!release) throw new Error(`Could not confirm the sync request. Click Resume sync to recover this same request. ${error.message}`);
    }
  }
  saveJob({ ...job, releaseId: release.id });
  return release;
}
