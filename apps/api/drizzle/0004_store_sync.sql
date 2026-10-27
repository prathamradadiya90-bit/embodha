ALTER TABLE "store_products" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "store_state" text;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "price_point_id" uuid;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "steps" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_price_point_id_price_points_id_fk" FOREIGN KEY ("price_point_id") REFERENCES "public"."price_points"("id") ON DELETE no action ON UPDATE no action;