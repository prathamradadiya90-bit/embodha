CREATE TABLE "download_devices" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"platform" text NOT NULL,
	"label" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "download_devices_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "downloads" (
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"chapter_id" uuid NOT NULL,
	"media_asset_id" uuid,
	"height" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "downloads_user_id_device_id_chapter_id_pk" PRIMARY KEY("user_id","device_id","chapter_id")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "download_heights" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "download_devices" ADD CONSTRAINT "download_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_user_id_device_id_download_devices_user_id_id_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "public"."download_devices"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "downloads_chapter_idx" ON "downloads" USING btree ("chapter_id");