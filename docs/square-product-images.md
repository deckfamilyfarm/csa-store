# Square product photos and shared market setup

Normal **Store → Product Sync → Square** checks include prices, selling units
and saved primary photos. The product editor's **Sync Square** and **Sync Both**
also include the photo in their existing frozen revision and durable release.
Products without photos keep their current icon and can still sync prices.
Older in-flight sync receipts and price-only matching shortcuts keep their
original scope.

For a photo-only update, select **Product images — all locations** under Check.
This compares each saved primary product photo with its approved Square item. Select
**All vendors** for the entire catalog, check images, select eligible updates,
then review the current and proposed pictures before approving publication.

Square uses the parent item's first image as its POS icon and primary Square
Online image. Publishing moves the saved photo to the front and retains other
Square photos. It preserves item/variation locations, prices, selling units,
stock, taxes, channels and online visibility. Existing item availability still
controls which locations sell an item. Products without photos are left alone;
missing, unapproved, or conflicting item matches require review.

The photo-only check is separate from price publication. It does not stage unsaved edits
or require an enterprise price approval. Square Push authorizes publication;
scheduled releases also require Pricing Admin. Review, scheduling, progress and
history use the normal persisted Product Sync actions and releases.

The `square_sync_images` table freezes JPEG bytes, upload keys and receipts.
Identical photos are reused across products. Unknown upload results retry the
same bytes/key; item attachment requests also retain their exact body and key.
Retries read Square before writing. Source, link or remote-image drift holds the
action. Missing/deleted uploaded images require receipt review. Preserve these
records when cancelling or reviewing a release.

To generate an HTML preview without publishing:

```sh
node --env-file=.env apps/api/scripts/auditSquareProductImages.js
```

Pass `--audit-id=ID` to export an existing audit. This command writes only the
local review, cache and frozen assets; it never uploads images or changes Square
items.

For explicitly authorized publication of a reviewed image-only audit:

```sh
node --env-file=.env apps/api/scripts/publishSquareProductImages.js --audit-id=ID
node --env-file=.env apps/api/scripts/publishSquareProductImages.js --audit-id=ID --apply
```

The first command previews eligibility. The second creates/resumes durable
releases reserved for this worker, so an older deployed scheduler cannot claim
the new image protocol. Reruns recover existing action releases before starting
any remaining work.

## One shared mode on iPads and iPhones

In Square Dashboard → Settings → Device management → Modes, create/select one
saved mode using the Standard template. Under Devices, choose each device and
use Actions → Switch mode to assign that same mode. Verify its Assigned devices
list. Complete pending offline payments before switching modes.

Modes share checkout/security/add-on settings across devices and locations.
The item grid needs its own copy: on an iOS device in Standard Mode, set up the
master grid, then use Settings → Checkout Settings → Sync Item Grid and choose
the target locations. This replaces their grids. It is a one-time copy; repeat
after changing the master layout. Keep the separate market locations for
location-based sales reporting.

The current CSA Store Square integration cannot assign modes or copy grids;
these controls are in Square Dashboard/POS. See Square's
[mode instructions](https://squareup.com/help/us/en/article/8114-create-and-manage-device-profiles)
and [grid syncing instructions](https://squareup.com/help/us/en/article/8668-sync-your-item-grid-across-locations).

## Validation

`python3 scripts/test-stabilization.py --docker` includes
`squareProductImages.integration.test.js` with mocked image hosts and Square.
It covers shared uploads, multiple variations, enterprise products, missing
photos/mappings, permissions, unchanged location/pricing/inventory fields,
lost upload/attachment responses, rejection recovery, and source/remote drift.
Pure helpers and UI review summaries are covered by `squareItemLocations.test.js`,
`productSyncView.test.js` and `productSyncSummary.test.js`.
