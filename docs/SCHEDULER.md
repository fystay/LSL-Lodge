# Background jobs and scheduling

Status (9 October 2026): the job system is built and verified locally
against a production build. **No scheduler is configured on any
deployment.** Until one is, nothing runs on its own: requests don't lapse
by themselves (deadlines are still enforced whenever someone books or the
owner acts), emails aren't sent, and Airbnb isn't polled. The owner can run
each task by hand from `/admin/system`.

## What runs

One endpoint, `GET /api/jobs/tick` with `Authorization: Bearer $CRON_SECRET`,
called every **5 minutes**. Each job runs when due:

| Job                  | Every  | Timeout | Overdue after | Does                                                                                                    |
| -------------------- | ------ | ------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `expire-holds`       | 5 min  | 60 s    | 20 min        | Expires lapsed requests, approvals and holds; closes their Stripe Checkout Sessions; queues the emails  |
| `send-notifications` | 5 min  | 120 s   | 20 min        | Sends up to 100 due emails (5 batches of 20); retries failures with backoff                             |
| `sync-calendars`     | 5 min  | 120 s   | 30 min        | Polls Airbnb feeds that are due (each source sets its own next time and backs off after failures)       |
| `maintenance`        | 60 min | 60 s    | 3 h           | Recovers abandoned runs and leases, marks stale feeds, prunes old data, emails the owner about problems |

Each job also has its own route (`/api/jobs/<name>`) for manual or
separate scheduling. Code: `src/server/jobs/`.

## Safety properties

- **No overlap.** Each job holds a lease row while it runs. A second trigger
  (scheduler retry, overlapping tick, manual run) is skipped. Each calendar
  source also has its own lease, so "Sync now" and the scheduled sync can't
  process the same feed together. Notification jobs are claimed with
  `FOR UPDATE SKIP LOCKED`.
- **Idempotent.** Every job can run twice, late, or after a crash without
  harm: expiry only moves expired rows; emails have idempotency keys at the
  provider; imports upsert by event UID.
- **Bounded.** Fixed timeouts per job and per outbound call (Stripe 15 s,
  feeds 10 s, email 10 s), batch limits, `maxDuration` 300 s on the routes.
- **Retries.** Emails: exponential backoff with jitter, 6 attempts, then
  FAILED. Calendar feeds: backoff from 5 minutes up to 6 hours. Stripe
  retries its own webhooks for up to 3 days. A failed job run is simply
  retried on the next tick.
- **Crash recovery.** A runner that dies leaves its lease to expire
  (timeout + 60 s). Runs left RUNNING are marked FAILED ("ABANDONED") by
  `maintenance`. Emails left mid-send are reclaimed after 15 minutes.
  Calendar source leases expire after 2 minutes.
- **Observability.** Every run is recorded (status, duration, counts, error
  code; no personal data) and shown on `/admin/system`, with "Run now".

## Alerting

- `maintenance` emails the owner (once per day per set of problems) when
  emails are backed up or failing, Stripe webhooks are failing, a calendar
  feed is unhealthy, or a job is overdue.
- A scheduler that has stopped can't report itself. **Configure an external
  uptime monitor** (for example Better Stack or UptimeRobot) to call
  `GET /api/health` every 5 minutes with
  `Authorization: Bearer $HEALTHCHECK_SECRET` and alert on any non-200.
  It returns 503 with problem codes (`job_overdue:<name>`,
  `notification_backlog`, `notifications_failed`, `webhooks_failed`,
  `calendar_sync_unhealthy`) and no personal data.

## Choosing a scheduler (owner decision)

**Option A, recommended once the Supabase project exists: `pg_cron` +
`pg_net` in Supabase.** Free, runs every minute if needed, and works for
preview and production alike. In the Supabase SQL editor (store the secret
in Vault, never inline):

```sql
-- once: enable the extensions (Database → Extensions): pg_cron, pg_net
select vault.create_secret('<CRON_SECRET value>', 'lodge_cron_secret');

select cron.schedule(
  'lodge-tick',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://<site>/api/jobs/tick',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'lodge_cron_secret')
    ),
    timeout_milliseconds := 300000
  );
  $$
);
```

**Option B: Vercel Cron.** Add to `vercel.json`:

```json
{ "crons": [{ "path": "/api/jobs/tick", "schedule": "*/5 * * * *" }] }
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. Vercel Cron
runs on **production deployments only**, and plan limits apply to how
often it may run (check the current Vercel pricing; a 5-minute schedule has
needed a paid plan). Not added to the repository, because deploying a
schedule the plan doesn't allow fails the deployment.

**Not recommended alone:** GitHub Actions `schedule` (runs can be delayed or
skipped under load).

## Verifying a scheduler

After configuring one:

1. Wait 10 minutes, then open `/admin/system`: every task should show a
   recent successful run.
2. `curl -H "Authorization: Bearer $HEALTHCHECK_SECRET" https://<site>/api/health`
   should return `{"ok":true,"problems":[]}`.
3. Point the uptime monitor at the same URL and confirm it alerts when you
   pause the schedule.

Only then describe the scheduler as active.

## Local verification done (9 October 2026)

Against a production build on a local database: unauthenticated tick → 401;
health before any run → 503 with every job overdue; first tick → all four
jobs succeeded; second tick → all "not due"; concurrent calls to one job →
the overlapping call was skipped ("lease held"); health afterwards → jobs no
longer overdue (a real failed-email problem from earlier test data was
correctly reported); wrong health secret → 401. Integration tests cover
overlap, crashed leases, timeouts, failures, abandoned runs, cadence,
health and per-source leases.
