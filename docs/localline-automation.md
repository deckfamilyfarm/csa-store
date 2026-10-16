# Local Line Automation

CSA Store can run a cron-safe Local Line automation pipeline from the deployed server. The script records an aggregate `automation` job in `local_line_job_runs`, starts the same tracked child jobs used by the Admin UI, and uses a MySQL lock so overlapping cron runs exit instead of running twice.

## Commands

From `/home/jdeck/code/csa-store` on the server:

```bash
node --env-file=.env apps/api/scripts/runLocalLineAutomation.js --mode=pull
node --env-file=.env apps/api/scripts/runLocalLineAutomation.js --mode=dashboard
node --env-file=.env apps/api/scripts/runLocalLineAutomation.js --mode=full
```

Modes:

- `pull`: products/cache, fulfillments/drop sites, orders, reporting cache, and subscriber snapshot.
- `dashboard`: publish the Google dashboard if the latest product, fulfillment, and order pulls completed recently.
- `full`: run `pull`, then publish the dashboard.

## Cron Entries

The deployed crontab is currently written in UTC with Pacific daylight-time comments. These entries schedule the daily pull at 3:40 AM PT during daylight time and the Monday dashboard publish at 4:35 AM PT during daylight time.

```cron
# **************************************** #
# CSA Store Local Line Automation
# **************************************** #

# 3:40 AM PT daily during daylight time - pull Local Line data into CSA Store
40 10 * * * cd /home/jdeck/code/csa-store && /usr/bin/node --env-file=.env apps/api/scripts/runLocalLineAutomation.js --mode=pull >> /home/jdeck/code/csa-store/tmp/localline-automation.log 2>&1

# 4:35 AM PT every Monday during daylight time - publish dashboard after Monday pull
35 11 * * 1 cd /home/jdeck/code/csa-store && /usr/bin/node --env-file=.env apps/api/scripts/runLocalLineAutomation.js --mode=dashboard >> /home/jdeck/code/csa-store/tmp/localline-automation.log 2>&1
```

## Master pricelist: Thursday and Friday at 4 AM Pacific

The CSA Store exporter publishes the configured Google master pricelist from this application's local database. It uses the same export as Admin and `npm run export:master-pricelist`, including the existing Deck Family Farm, Hyland, and Creamy Cow scope. It does not invoke the old Killdeer exporter or publish catalog prices to Local Line or Square.

After deploying the updated code, use `crontab -e` on the server to **replace** the existing 5 AM `exportMasterPricelist.js` entry with the entry in [`scripts/master-pricelist.cron`](../scripts/master-pricelist.cron):

```cron
# 4:00 AM Pacific every Thursday and Friday, including daylight-saving changes
0 11,12 * * 4,5 cd /home/jdeck/code/csa-store && /usr/bin/node --env-file=.env scripts/runStoreExportMasterPricelist.js --scheduled >> /home/jdeck/.pm2/logs/csa-store-pricelist-export.log 2>&1
```

The server's cron runs in UTC. The wrapper checks `America/Los_Angeles` and invokes `apps/api/scripts/exportMasterPricelist.js` only during 04:00 on Thursday or Friday, skipping the alternate UTC hour. Keep the old Killdeer export line commented out and leave the hourly scheduled-pricelist-release job in place; that is a separate publication workflow. The existing Google credentials and spreadsheet configuration in this repository's `.env` are reused.

Manual export and preview commands continue to work at any time. Check the schedule without publishing using `node --test scripts/runStoreExportMasterPricelist.test.js`, and inspect `/home/jdeck/.pm2/logs/csa-store-pricelist-export.log` after scheduled runs.

## Tracking

- Admin > Local Line shows the latest automation job plus child job details.
- CLI logs go to `tmp/localline-automation.log` when run through cron.
- Dataset cursors remain in `local_line_sync_cursors`.
- Job history remains in `local_line_job_runs`.

Useful server checks:

```bash
tail -n 100 /home/jdeck/code/csa-store/tmp/localline-automation.log
```

```sql
SELECT dataset_key, job_type, status, started_at, finished_at
FROM local_line_job_runs
ORDER BY id DESC
LIMIT 10;
```

## Environment

The dashboard publisher accepts `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for service-account auth. It publishes `Dashboard-auto-26`, `Dashboard-auto-26v2`, and `Dashboard-auto-employee-credits26` to the FFCSA dashboard spreadsheet (`1ZQc0HYI150kKa6aiJ_bA4RLLhfJCL83QPeIPfEG0xXI`) by default. The editable `gp_per_member` forecast tab is preserved during publishes. `DASHBOARD_SHEET_ID` overrides the output spreadsheet. The source weekly layout and `Credits` tab remain in the previous workbook (`1plDSzQo8PZqQbCAt9Xb1BRd-cdJmkpoGwSmCFQvolUc`); `DASHBOARD_SOURCE_SHEET_ID` overrides that input workbook, and `DASHBOARD_SOURCE_GID` selects its weekly source tab. The legacy `GOOGLE_SHEETS_ID` is accepted only as a source-workbook override.

Optional automation tuning:

- `LOCAL_LINE_AUTOMATION_ORDER_CUTOFF`, default `2026-01-01T00:00:00.000Z`.
- `LOCAL_LINE_AUTOMATION_JOB_TIMEOUT_MS`, default 3 hours.
- `LOCAL_LINE_AUTOMATION_DASHBOARD_MAX_PULL_AGE_HOURS`, default 26 hours.
- `LOCAL_LINE_JOB_STALE_SECONDS`, default 1800 seconds before an old queued/running job is marked stale.
