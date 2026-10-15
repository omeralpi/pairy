CREATE TYPE "public"."asset_code" AS ENUM('XLM', 'USDC');--> statement-breakpoint
CREATE TYPE "public"."listing_side" AS ENUM('sell_crypto', 'buy_crypto');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('active', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."trade_role" AS ENUM('seller', 'buyer');--> statement-breakpoint
CREATE TYPE "public"."trade_state" AS ENUM('listed', 'agreed', 'locked', 'claimed', 'reclaimed', 'cancelled');--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"side" "listing_side" NOT NULL,
	"asset" "asset_code" NOT NULL,
	"min_amount" numeric(20, 7) NOT NULL,
	"max_amount" numeric(20, 7) NOT NULL,
	"fiat_code" text NOT NULL,
	"rate" numeric(20, 4) NOT NULL,
	"city_id" text NOT NULL,
	"city_name" text NOT NULL,
	"country_code" text NOT NULL,
	"latitude" numeric(9, 5) NOT NULL,
	"longitude" numeric(9, 5) NOT NULL,
	"note" text,
	"status" "listing_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"type" text NOT NULL,
	"by" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"seller" text NOT NULL,
	"buyer" text NOT NULL,
	"opened_by" "trade_role" NOT NULL,
	"asset" "asset_code" NOT NULL,
	"amount" numeric(20, 7) NOT NULL,
	"fiat_code" text NOT NULL,
	"fiat_amount" numeric(20, 2) NOT NULL,
	"state" "trade_state" DEFAULT 'listed' NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"window_seconds" integer NOT NULL,
	"balance_id" text,
	"lock_tx" text,
	"claim_tx" text,
	"reclaim_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"public_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_owner_users_public_key_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("public_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_users_public_key_fk" FOREIGN KEY ("seller") REFERENCES "public"."users"("public_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_buyer_users_public_key_fk" FOREIGN KEY ("buyer") REFERENCES "public"."users"("public_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_trade_idx" ON "chat_messages" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trade_events_trade_idx" ON "trade_events" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trades_seller_idx" ON "trades" USING btree ("seller");--> statement-breakpoint
CREATE INDEX "trades_buyer_idx" ON "trades" USING btree ("buyer");