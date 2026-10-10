-- Free hosted scheduler for the Lodge staging site: Supabase pg_cron calls
-- the app's /api/jobs/tick every 5 minutes through pg_net. (Vercel Cron
-- runs on production deployments only, and only daily on the Hobby plan.)
-- Run as `postgres` in the Supabase SQL editor of the Lodge project.
--
-- 1. Store the three values in Vault YOURSELF first (SQL editor; never in
--    chat, git or this file):
--      select vault.create_secret('https://<staging address>/api/jobs/tick', 'lodge_tick_url');
--      select vault.create_secret('<CRON_SECRET from Vercel>', 'lodge_cron_secret');
--      select vault.create_secret('<Protection Bypass for Automation secret>', 'lodge_bypass_secret');
--    To change one later: select vault.update_secret(id, '<new value>')
--    using the id from vault.secrets.
-- 2. Run the rest of this file.
-- 3. Check: select * from cron.job_run_details order by start_time desc limit 5;
--    and /admin/system shows each job's last run.
-- To stop: select cron.unschedule('lodge-jobs-tick');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('lodge-jobs-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lodge-jobs-tick');

SELECT cron.schedule(
  'lodge-jobs-tick',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'lodge_tick_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'lodge_cron_secret'),
      'x-vercel-protection-bypass', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'lodge_bypass_secret')
    ),
    timeout_milliseconds := 60000
  );
  $job$
);
