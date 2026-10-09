CREATE TYPE "public"."job_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "job_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"leased_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "job_run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text
);
--> statement-breakpoint
ALTER TABLE "external_calendar_sources" ADD COLUMN "sync_lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "job_runs_name_started_idx" ON "job_runs" USING btree ("name","started_at");--> statement-breakpoint
-- New tables get the same treatment as migration 0005: RLS on, no policies
-- (the Data API roles get nothing).
ALTER TABLE "job_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "job_leases", "job_runs" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "job_leases", "job_runs" FROM authenticated;
  END IF;
END
$$;
