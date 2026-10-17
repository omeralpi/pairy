ALTER TABLE "listings" ADD CONSTRAINT "listings_min_amount_positive" CHECK ("listings"."min_amount" > 0);--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_max_amount_gte_min" CHECK ("listings"."max_amount" >= "listings"."min_amount");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_rate_positive" CHECK ("listings"."rate" > 0);--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_not_buyer" CHECK ("trades"."seller" <> "trades"."buyer");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_amount_positive" CHECK ("trades"."amount" > 0);--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_fiat_amount_nonnegative" CHECK ("trades"."fiat_amount" >= 0);--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_lock_recorded" CHECK ("trades"."state" NOT IN ('locked', 'claimed', 'reclaimed') OR ("trades"."balance_id" IS NOT NULL AND "trades"."lock_tx" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_claim_recorded" CHECK ("trades"."state" <> 'claimed' OR "trades"."claim_tx" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_reclaim_recorded" CHECK ("trades"."state" <> 'reclaimed' OR "trades"."reclaim_tx" IS NOT NULL);