CREATE TABLE "document_counters" (
	"series" text PRIMARY KEY NOT NULL,
	"last" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gst_rate_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "buyer_state" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "place_of_supply" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cgst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "sgst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "igst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_seller" jsonb;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "credit_note_no" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "gst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "cgst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "sgst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "igst_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_no_unique" UNIQUE("credit_note_no");--> statement-breakpoint
DROP SEQUENCE "public"."invoice_seq";--> statement-breakpoint
-- Sales booked before this change keep the rate and seller they were invoiced with; dollar invoices are exports.
UPDATE "payments" SET "gst_rate_bps" = COALESCE((SELECT ("value" #>> '{}')::int FROM "settings" WHERE "key" = 'gst_rate_bps'), 1800) WHERE "gst_minor" > 0;--> statement-breakpoint
UPDATE "payments" SET "invoice_seller" = COALESCE((SELECT "value" FROM "settings" WHERE "key" = 'invoice_seller'), '{"name":"Embodha","address":"","gstin":""}'::jsonb) WHERE "invoice_no" IS NOT NULL;--> statement-breakpoint
UPDATE "payments" SET "place_of_supply" = '96' WHERE "currency" = 'USD' AND "invoice_no" IS NOT NULL;
