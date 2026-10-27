CREATE TABLE "active_days" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"practised" boolean DEFAULT false NOT NULL,
	CONSTRAINT "active_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" uuid,
	"anon_id" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install_days" (
	"anon_id" text NOT NULL,
	"day" date NOT NULL,
	"signed_in" boolean DEFAULT false NOT NULL,
	CONSTRAINT "install_days_anon_id_day_pk" PRIMARY KEY("anon_id","day")
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"anon_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"platform" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_days" ADD CONSTRAINT "active_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_days_day_idx" ON "active_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "events_name_at_idx" ON "events" USING btree ("name","at");--> statement-breakpoint
CREATE INDEX "events_user_at_idx" ON "events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "install_days_day_idx" ON "install_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "installs_user_idx" ON "installs" USING btree ("user_id");--> statement-breakpoint
-- Practice from before analytics existed counts too: every day someone played a chapter or finished a breath.
INSERT INTO "active_days" ("user_id", "day", "practised")
SELECT "user_id", ("at" AT TIME ZONE 'Asia/Kolkata')::date, true FROM "playback_events" WHERE "seconds" > 0
UNION
SELECT "user_id", ("completed_at" AT TIME ZONE 'Asia/Kolkata')::date, true FROM "breathing_sessions"
ON CONFLICT DO NOTHING;
