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

- `pull`: products/cache, fulfillments/drop sites, orders, reporting cache, subscriber snapshot, and the pack-day team scorecard.
- `dashboard`: publish the Google dashboard if the latest product, fulfillment, and order pulls completed recently.
- `full`: run `pull`, then publish the dashboard.

## Cron Entries

The deployed crontab is currently written in UTC with Pacific daylight-time comments. These entries schedule the daily pull at 3:40 AM PT during daylight time and the Monday dashboard publish at 4:35 AM PT during daylight time. The daily pull also refreshes `auto-pack-day-team` after orders and subscribers are synced. A scorecard failure is recorded in the automation result without invalidating a successful source pull.

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

The dashboard publisher accepts `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for service-account auth. It publishes `auto-weekly-summary`, `auto-monthly-summary`, and `auto-employee-credits` to the FFCSA dashboard spreadsheet (`1ZQc0HYI150kKa6aiJ_bA4RLLhfJCL83QPeIPfEG0xXI`) by default. The editable `auto-gp-per-member` forecast tab is preserved during publishes. The weekly and monthly tabs freeze rows 1–2 and columns A–B. `DASHBOARD_SHEET_ID` overrides the output spreadsheet. The source weekly layout and `Credits` tab remain in the previous workbook (`1plDSzQo8PZqQbCAt9Xb1BRd-cdJmkpoGwSmCFQvolUc`); `DASHBOARD_SOURCE_SHEET_ID` overrides that input workbook, and `DASHBOARD_SOURCE_GID` selects its weekly source tab. The legacy `GOOGLE_SHEETS_ID` is accepted only as a source-workbook override.

The daily scorecard shows every cycle in the last two calendar months, newest first. Tuesday uses Monday–Tuesday Packout, Dairy and Frozen Packing, and Delivery task hours divided by Tuesday paid retail orders; Saturday uses Thursday–Saturday task hours divided by Friday and Saturday orders. Delivery is a driving proxy, not vehicle-only time. One shared target is the 25th percentile of combined packing and delivery minutes per order across all completed cycles since February 2026; a completed cycle needs both task groups recorded. The publish uses the previous completed Pacific calendar day and rechecks history so late Timesheets entries can correct a prior score. Run `npm --prefix apps/api run publish:pack-day` for a standalone refresh, or `node --env-file=.env apps/api/scripts/publishPackDayTeamView.js --dry-run` at the repository root to check the calculations without a Google write.

## Pack-day efficiency email

The brief report goes to `jdeck88@gmail.com` by default (`PACK_DAY_EFFICIENCY_EMAIL_TO` overrides it). It uses the same paid-order and Timesheets calculations as `auto-pack-day-team`, and includes the previous day's packing, delivery, total, and comparison with the shared target. If either labor category is missing, it says the efficiency is pending. Email uses the existing SMTP/Gmail configuration.

Install the line in [`scripts/pack-day-efficiency-email.cron`](../scripts/pack-day-efficiency-email.cron) in the server's UTC crontab. It runs at 17:00 and 18:00 UTC on Wednesday and Sunday; `--scheduled` sends only when the local Pacific time is 10:00 AM, covering both daylight and standard time. This is after the daily 3:40 AM Pacific order pull. Cron output goes to `tmp/pack-day-efficiency-email.log`.

Preview the Tuesday report without sending mail:

```bash
node --env-file=.env apps/api/scripts/emailPackDayEfficiency.js --dry-run --cycle-date=2026-10-13
```

For an intentional manual send, omit `--dry-run` and supply the cycle date. The scheduled command uses `--scheduled` and always selects the previous Pacific day.

Both summaries put subscriber counts, order averages, and sales versus the same-year average under GIVENS. Regular subscribers are active subscription plans excluding employee tiers; SNAP price-list members are counted separately. The subscription export does not name the membership tier, so employee subscriptions are identified by the current $100, $150, and $250 monthly plan amounts. Monthly order averages are weighted by order count, and monthly sales are compared with the average published month in the same year. The forecast tab has editable projected counts beside the current counts; its base GP and exit assumptions are below the main table.

Optional automation tuning:

- `LOCAL_LINE_AUTOMATION_ORDER_CUTOFF`, default `2026-01-01T00:00:00.000Z`.
- `LOCAL_LINE_AUTOMATION_JOB_TIMEOUT_MS`, default 3 hours.
- `LOCAL_LINE_AUTOMATION_DASHBOARD_MAX_PULL_AGE_HOURS`, default 26 hours.
- `LOCAL_LINE_JOB_STALE_SECONDS`, default 1800 seconds before an old queued/running job is marked stale.
