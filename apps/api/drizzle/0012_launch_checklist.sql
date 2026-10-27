CREATE TABLE "launch_signoffs" (
	"key" text PRIMARY KEY NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"source" text PRIMARY KEY NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"last_event" text,
	"received" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launch_signoffs" ADD CONSTRAINT "launch_signoffs_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;