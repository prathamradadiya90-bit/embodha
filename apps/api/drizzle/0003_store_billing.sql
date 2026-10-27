DROP INDEX "store_products_owner_idx";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "store_products_owner_idx" ON "store_products" USING btree ("owner_type","owner_id","store");