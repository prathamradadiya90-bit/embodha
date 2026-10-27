ALTER TABLE "course_revisions" ALTER COLUMN "submitted_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "course_revisions" ADD COLUMN "kind" text DEFAULT 'first' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "course_revisions_open_change_idx" ON "course_revisions" USING btree ("course_id") WHERE "course_revisions"."kind" = 'change' and "course_revisions"."decision" is null;