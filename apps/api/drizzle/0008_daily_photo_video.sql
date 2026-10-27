-- One of each per day: a quote, a photo and a video. The date alone was the key before.
ALTER TABLE "daily_content" DROP CONSTRAINT "daily_content_pkey";--> statement-breakpoint
ALTER TABLE "daily_content" ADD CONSTRAINT "daily_content_date_type_pk" PRIMARY KEY("date","type");--> statement-breakpoint
ALTER TABLE "daily_content" ADD COLUMN "width" smallint;--> statement-breakpoint
ALTER TABLE "daily_content" ADD COLUMN "height" smallint;