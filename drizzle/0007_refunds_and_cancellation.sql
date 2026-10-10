ALTER TABLE "payments" ADD COLUMN "refund_of_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "initiated_by" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_payment_id_fk" FOREIGN KEY ("refund_of_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_links_charge" CHECK (("payments"."kind" = 'REFUND') = ("payments"."refund_of_payment_id" IS NOT NULL));