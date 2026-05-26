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

The dashboard publisher accepts `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for service-account auth. Dashboard sheet targeting can be set with `DASHBOARD_SHEET_ID`, `DASHBOARD_SOURCE_GID`, and `DASHBOARD_TARGET_TITLE`.

Optional automation tuning:

- `LOCAL_LINE_AUTOMATION_ORDER_CUTOFF`, default `2026-01-01T00:00:00.000Z`.
- `LOCAL_LINE_AUTOMATION_JOB_TIMEOUT_MS`, default 3 hours.
- `LOCAL_LINE_AUTOMATION_DASHBOARD_MAX_PULL_AGE_HOURS`, default 26 hours.
- `LOCAL_LINE_JOB_STALE_SECONDS`, default 1800 seconds before an old queued/running job is marked stale.
