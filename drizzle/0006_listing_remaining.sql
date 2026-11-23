ALTER TABLE "listings" ADD COLUMN "remaining_amount" numeric(20, 7);--> statement-breakpoint
UPDATE "listings" l SET "remaining_amount" = GREATEST(0, l."max_amount" - COALESCE((
  SELECT SUM(t."amount") FROM "trades" t
  WHERE t."listing_id" = l."id" AND t."state"::text IN ('listed', 'agreed', 'locked', 'claimed')), 0));--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "remaining_amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_remaining_in_range" CHECK ("listings"."remaining_amount" >= 0 AND "listings"."remaining_amount" <= "listings"."max_amount");
