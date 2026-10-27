CREATE SEQUENCE "public"."invoice_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_no" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_no_unique" UNIQUE("invoice_no");