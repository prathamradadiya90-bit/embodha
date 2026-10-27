CREATE TABLE "app_errors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"screen" text,
	"platform" text NOT NULL,
	"app_version" text,
	"os_version" text,
	"device" text,
	"anon_id" text NOT NULL,
	"user_id" uuid,
	"client_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"screen" text,
	"platform" text NOT NULL,
	"app_version" text,
	"os_version" text,
	"device" text,
	"handled_at" timestamp with time zone,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_errors" ADD CONSTRAINT "app_errors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_errors_at_idx" ON "app_errors" USING btree ("at");--> statement-breakpoint
CREATE INDEX "app_errors_fingerprint_idx" ON "app_errors" USING btree ("fingerprint","at");--> statement-breakpoint
CREATE INDEX "app_errors_user_idx" ON "app_errors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");