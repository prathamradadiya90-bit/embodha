CREATE TABLE "razorpay_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instructor_id" uuid NOT NULL,
	"price_point_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"plan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "razorpay_plans_plan_id_unique" UNIQUE("plan_id")
);
--> statement-breakpoint
ALTER TABLE "razorpay_plans" ADD CONSTRAINT "razorpay_plans_instructor_id_instructors_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."instructors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "razorpay_plans" ADD CONSTRAINT "razorpay_plans_price_point_id_price_points_id_fk" FOREIGN KEY ("price_point_id") REFERENCES "public"."price_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "razorpay_plans_lookup_idx" ON "razorpay_plans" USING btree ("instructor_id","price_point_id","currency");