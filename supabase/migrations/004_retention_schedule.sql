-- 004_retention_schedule.sql : runs the deletion jobs the privacy policy promises (section 9).
-- Enable pg_cron first: Supabase > Database > Extensions > pg_cron. Times are UTC (Ghana time).
create extension if not exists pg_cron;

select cron.unschedule(jobname) from cron.job
 where jobname in ('purge-booking-pii', 'purge-abuse-flags', 'purge-audit-log', 'purge-consents');

select cron.schedule('purge-booking-pii', '15 2 * * *', $$select purge_expired_booking_pii(90)$$);   -- daily
select cron.schedule('purge-abuse-flags', '20 2 * * *', $$select purge_expired_abuse_flags()$$);     -- daily
select cron.schedule('purge-audit-log',   '0 3 1 * *',  $$select purge_old_audit_log()$$);           -- monthly
select cron.schedule('purge-consents',    '10 3 1 * *', $$select purge_old_consent_events()$$);      -- monthly

-- Check: a 'retention_purge' row should appear in audit_log every day.
--   select created_at, detail from audit_log where action = 'retention_purge' order by created_at desc limit 7;
