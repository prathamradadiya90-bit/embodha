CREATE TABLE "reconciliation_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" text,
	"gross_minor" bigint,
	"fee_minor" bigint,
	"tax_minor" bigint,
	"amount_inr_paise" bigint,
	"booked_inr_paise" bigint,
	"settled_at" timestamp with time zone,
	"settlement_ref" text,
	"status" text NOT NULL,
	"note" text,
	"explanation" text,
	"explained_by" uuid,
	"explained_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"file_name" text,
	"rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fee_tax_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fee_source" text DEFAULT 'estimate' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gross_inr_paise" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "charged_currency" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "charged_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settled_inr_paise" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciliation_line_id" bigint;--> statement-breakpoint
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_explained_by_users_id_fk" FOREIGN KEY ("explained_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_lines_ref_idx" ON "reconciliation_lines" USING btree ("channel","ref","kind");--> statement-breakpoint
CREATE INDEX "reconciliation_lines_recon_idx" ON "reconciliation_lines" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "reconciliation_lines_status_idx" ON "reconciliation_lines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconciliations_channel_idx" ON "reconciliations" USING btree ("channel","created_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciliation_line_id_reconciliation_lines_id_fk" FOREIGN KEY ("reconciliation_line_id") REFERENCES "public"."reconciliation_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_unreconciled_idx" ON "payments" USING btree ("channel","captured_at") WHERE reconciled_at is null and not is_test;
--> statement-breakpoint
-- Fees booked before now stay 'estimate'. A website fee then included Razorpay's GST on it, or was 2% when the
-- payment had no fee yet; the first settlement fetch that covers the sale puts the real figure in.
UPDATE "payments" SET "gross_inr_paise" = "gross_minor" WHERE "currency" = 'INR';--> statement-breakpoint
-- Store sales: the product each was bought as, from the store products as they stand.
UPDATE "payments" p SET "product_id" = sp."product_id" FROM "store_products" sp
  WHERE p."channel" IN ('apple', 'google') AND p."product_id" IS NULL AND sp."store" = p."channel"
    AND ((p."course_id" IS NOT NULL AND sp."owner_type" = 'course' AND sp."owner_id" = p."course_id")
      OR (p."course_id" IS NULL AND sp."owner_type" = 'instructor_plan' AND sp."owner_id" = p."instructor_id"));--> statement-breakpoint
-- A store sale's share becomes payable once that store's monthly report includes it (spec: Live earnings).
UPDATE "splits" s SET "payable_from" = NULL FROM "payments" p
  WHERE p."id" = s."payment_id" AND p."channel" IN ('apple', 'google') AND s."payout_line_id" IS NULL AND s."state" = 'pending';
