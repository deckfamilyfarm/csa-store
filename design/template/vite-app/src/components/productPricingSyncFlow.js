export const canSyncPlatforms = (roles = [], platforms = ['localline']) => roles.includes('admin') ||
  (platforms.every(platform => roles.includes(`${platform}_push`)) && roles.some(role => ['pricing_admin', 'pricing_publisher'].includes(role)));
export const canSyncLocalLine = roles => canSyncPlatforms(roles, ['localline']);
export const channelNames = platforms => platforms.map(p => p === 'square' ? 'Square' : 'Local Line').join(' and ');
export const samePlatforms = (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export const releasePlatforms = release => [...new Set((release?.actions || []).map(a => a.platform))];

export const publicationRunning = release => ['queued', 'running'].includes(release?.status);
export function publicationMessage(release) {
  const platforms = releasePlatforms(release);
  const label = channelNames(platforms.length ? platforms : ['localline']);
  if (release.status === 'completed') return label === 'Local Line' ? 'Synced — Local Line prices and sale verified.' : `Synced — ${label} prices verified.`;
  if (release.status === 'queued') return 'Waiting for the server to start your update…';
  const labels = {
    'Checking local values, product match, and current remote values.': `Fetching prices from ${label} and checking your saved changes…`,
    'Applying approved values.': label === 'Local Line' ? 'Updating prices and sale on Local Line…' : `Updating prices on ${label}…`,
    'Confirming the published values with the destination.': `Verifying the updated prices on ${label}…`
  };
  const messages = [...new Set((release.actions || []).filter(a => a.status !== 'completed' || platforms.length > 1).map(a => {
    const message = a.status === 'completed' ? 'Synced.' : labels[a.message] || a.message;
    return message && (platforms.length > 1 ? `${channelNames([a.platform])}: ${message}` : message);
  }).filter(Boolean))];
  return messages.join(' ') || (release.status === 'running' ? `Updating prices on ${label}…` : 'Sync needs attention. Review the saved publication in Review & Publish.');
}

// Called only by an explicit Sync click. A retained audit/receipt recovers an
// uncertain submission before any new work is created. Progress GETs never write.
export async function syncProductChannels({ productId, data, resume, get, post, saveJob, progress, platforms = ['localline'],
  wait = () => new Promise(resolve => setTimeout(resolve, 1500)) }) {
  if (data.localOnly) throw new Error('Remote sync is disabled in local test mode.');
  if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some(p=>!['localline','square'].includes(p))) throw new Error('Select valid sync destinations.');
  if (platforms.includes('square') && !data.input?.squareEnabled) throw new Error('This product is not enabled for Square.');
  const label = channelNames(platforms), onlyLL = samePlatforms(platforms,['localline']);
  let job = resume;
  if (job && !samePlatforms(job.platforms || ['localline'], platforms)) throw new Error('Resume the previous sync for its original destinations first.');
  if (!job) {
    if (!data.revisionId) throw new Error('Save complete pricing inputs before syncing.');
    if (platforms.includes('localline') && data.syncBlocker) throw new Error(data.syncBlocker);
    progress('Checking saved prices and permissions…');
    if (['pending', 'local-preview'].includes(data.revisionStatus)) {
      await post(`enterprise-pricing/revisions/${data.revisionId}/${onlyLL ? 'approve-localline' : 'approve-channels'}`, onlyLL ? {} : {platforms});
    }
    progress(`Fetching current prices from ${label}…`);
    const audit = await post('product-sync/audits', { platforms, productIds: [Number(productId)],
      productScope: 'selected', vendorGroup: 'all', enterpriseRevisionId: data.revisionId,
      publicationScope: onlyLL ? 'localline-prices-and-sales' : 'enterprise-selected-prices', incoming: false, productEditorSync: true });
    job = { auditId: audit.id, revisionId: data.revisionId, platforms };
    saveJob(job);
  }
  if (job.releaseId) return get(`product-sync/releases/${job.releaseId}/progress`);
  progress(`Fetching current prices from ${label}…`);
  let audit = await get(`product-sync/audits/${job.auditId}`);
  while (audit.status === 'running') {
    await wait();
    audit = await get(`product-sync/audits/${job.auditId}`);
    progress(`Fetching current prices from ${label}…`);
  }
  const result = await get(`product-sync/audits/${job.auditId}/actions?direction=outgoing&pageSize=100`);
  const actions = result.rows || [];
  if (audit.error || audit.status !== 'completed' || !actions.length || platforms.some(p=>!actions.some(a=>a.platform===p)) || actions.some(a =>
    !platforms.includes(a.platform) || Number(a.productId) !== Number(productId) || !['changed', 'synced'].includes(a.status))) {
    saveJob(null); // No publication was submitted for a blocked check.
    throw new Error([audit.error, ...actions.filter(a => !['changed', 'synced'].includes(a.status)).map(a => a.message)]
      .filter(Boolean).join(' ') || `${label} could not verify every package. Review package mappings before syncing.`);
  }
  const receiptPath = `product-sync/audits/${job.auditId}/actions/${actions[0].id}/release`;
  progress(`Sending saved prices to ${label}…`);
  // Failure to look up a receipt is not evidence that it does not exist.
  let release = await get(receiptPath);
  if (!release) {
    try {
      release = await post('product-sync/releases', { auditId: job.auditId, actionIds: actions.map(a => a.id),
        name: `${label} product ${productId} · pricing sync`, background: true });
    } catch (error) {
      release = await get(receiptPath).catch(() => null);
      if (!release) throw new Error(`Could not confirm the sync request. Click Resume sync to recover this same request. ${error.message}`);
    }
  }
  saveJob({ ...job, releaseId: release.id });
  return release;
}

export const syncProductLocalLine = args => syncProductChannels({...args, platforms:['localline']});
