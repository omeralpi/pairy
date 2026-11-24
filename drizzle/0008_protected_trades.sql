CREATE TYPE "public"."resolution_outcome" AS ENUM('buyer', 'seller');--> statement-breakpoint
CREATE TYPE "public"."resolution_status" AS ENUM('collecting', 'submitted', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trade_mode" AS ENUM('claimable', 'protected');--> statement-breakpoint
ALTER TYPE "public"."trade_state" ADD VALUE 'escrow_created';--> statement-breakpoint
ALTER TYPE "public"."trade_state" ADD VALUE 'funded';--> statement-breakpoint
ALTER TYPE "public"."trade_state" ADD VALUE 'released';--> statement-breakpoint
ALTER TYPE "public"."trade_state" ADD VALUE 'resolved_buyer';--> statement-breakpoint
ALTER TYPE "public"."trade_state" ADD VALUE 'resolved_seller';--> statement-breakpoint
CREATE TABLE "arbiter_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"outcome" "resolution_outcome" NOT NULL,
	"rule" smallint NOT NULL,
	"recipient" text NOT NULL,
	"amount" numeric(20, 7) NOT NULL,
	"unsigned_xdr" text NOT NULL,
	"tx_hash" text NOT NULL,
	"signed_xdr" text NOT NULL,
	"signers" text[] DEFAULT '{}' NOT NULL,
	"status" "resolution_status" DEFAULT 'collecting' NOT NULL,
	"prepared_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"submitted_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arbiter_resolutions_rule_valid" CHECK ("arbiter_resolutions"."rule" IN (1, 2, 3))
);
--> statement-breakpoint
CREATE TABLE "dispute_answers" (
	"trade_id" uuid NOT NULL,
	"role" "trade_role" NOT NULL,
	"cash_handed_over" boolean NOT NULL,
	"note" text,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_answers_trade_id_role_pk" PRIMARY KEY("trade_id","role"),
	CONSTRAINT "dispute_answers_note_length" CHECK ("dispute_answers"."note" IS NULL OR char_length("dispute_answers"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "mode" "trade_mode" DEFAULT 'claimable' NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "acceptance_version" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "seller_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "buyer_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "escrow_admin" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "escrow_contract_id" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "create_tx" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "fund_tx" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "release_tx" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "dispute_tx" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "resolve_tx" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "funded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "dispute_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "dispute_opened_by" "trade_role";--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "escrow_prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "arbiter_resolutions" ADD CONSTRAINT "arbiter_resolutions_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_answers" ADD CONSTRAINT "dispute_answers_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arbiter_resolutions_one_open" ON "arbiter_resolutions" USING btree ("status") WHERE "arbiter_resolutions"."status" = 'collecting';--> statement-breakpoint
CREATE INDEX "trades_listing_idx" ON "trades" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_escrow_contract_idx" ON "trades" USING btree ("escrow_contract_id");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_protected_usdc" CHECK ("trades"."mode"::text <> 'protected' OR "trades"."asset"::text = 'USDC');--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_protected_terms" CHECK (("trades"."mode"::text = 'protected') = ("trades"."acceptance_version" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_mode_states" CHECK (("trades"."mode"::text = 'claimable' AND "trades"."state"::text IN ('listed', 'agreed', 'locked', 'claimed', 'reclaimed', 'cancelled')) OR ("trades"."mode"::text = 'protected' AND "trades"."state"::text IN ('listed', 'agreed', 'escrow_created', 'funded', 'released', 'resolved_buyer', 'resolved_seller', 'cancelled')));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_escrow_recorded" CHECK ("trades"."state"::text NOT IN ('escrow_created', 'funded', 'released', 'resolved_buyer', 'resolved_seller') OR ("trades"."escrow_contract_id" IS NOT NULL AND "trades"."create_tx" IS NOT NULL AND "trades"."escrow_admin" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_fund_recorded" CHECK ("trades"."state"::text NOT IN ('funded', 'released', 'resolved_buyer', 'resolved_seller') OR ("trades"."fund_tx" IS NOT NULL AND "trades"."funded_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_release_recorded" CHECK ("trades"."state"::text <> 'released' OR "trades"."release_tx" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_resolve_recorded" CHECK ("trades"."state"::text NOT IN ('resolved_buyer', 'resolved_seller') OR ("trades"."resolve_tx" IS NOT NULL AND "trades"."dispute_tx" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_dispute_recorded" CHECK ("trades"."mode"::text <> 'protected' OR "trades"."disputed" = false OR ("trades"."dispute_tx" IS NOT NULL AND "trades"."disputed_at" IS NOT NULL AND "trades"."dispute_recorded_at" IS NOT NULL AND "trades"."dispute_opened_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_protected_accepted" CHECK ("trades"."mode"::text <> 'protected' OR "trades"."state"::text IN ('listed', 'cancelled') OR ("trades"."seller_accepted_at" IS NOT NULL AND "trades"."buyer_accepted_at" IS NOT NULL));