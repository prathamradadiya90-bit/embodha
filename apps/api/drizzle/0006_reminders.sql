CREATE TABLE "held_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"send_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_log" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_log_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "held_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "held_pushes" ADD CONSTRAINT "held_pushes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_pushes" ADD CONSTRAINT "held_pushes_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_pushes_send_after_idx" ON "held_pushes" USING btree ("send_after");