// What Pairy stores, and nothing more (SOW D3): Stellar public keys, listing
// terms, claimable balance IDs and transaction hashes, and trade state. No
// private keys or anything a key could be derived from, no names, no phone
// numbers, no identity documents. Per-deal chat lives only until the trade
// reaches a terminal state.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { ASSET_CODES } from "@/lib/stellar/assets";
import { TRADE_MODES, TRADE_STATES } from "@/lib/trade/state-machine";

export const assetCode = pgEnum("asset_code", ASSET_CODES);
export const tradeState = pgEnum("trade_state", TRADE_STATES);
export const tradeRole = pgEnum("trade_role", ["seller", "buyer"]);
/** claimable: a Stellar claimable balance (Phase 1). protected: a Trustless Work escrow with the arbiter. */
export const tradeMode = pgEnum("trade_mode", TRADE_MODES);
export const resolutionOutcome = pgEnum("resolution_outcome", ["buyer", "seller"]);
export const resolutionStatus = pgEnum("resolution_status", ["collecting", "submitted", "expired", "failed"]);
/** sell_crypto: the owner holds crypto and wants cash. buy_crypto: the reverse. */
export const listingSide = pgEnum("listing_side", ["sell_crypto", "buy_crypto"]);
export const listingStatus = pgEnum("listing_status", ["active", "paused", "closed"]);

export const users = pgTable("users", {
  publicKey: text("public_key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time SEP-53 login challenges. */
export const authChallenges = pgTable("auth_challenges", {
  nonce: text("nonce").primaryKey(),
  publicKey: text("public_key").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Live login sessions; logout deletes the row, so a replayed cookie stops working. */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  publicKey: text("public_key")
    .notNull()
    .references(() => users.publicKey),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull().references(() => users.publicKey),
    side: listingSide("side").notNull(),
    asset: assetCode("asset").notNull(),
    minAmount: numeric("min_amount", { precision: 20, scale: 7 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 20, scale: 7 }).notNull(),
    /** max_amount less every trade that holds or used up its amount; recomputed by lib/listing/remaining.ts. */
    remainingAmount: numeric("remaining_amount", { precision: 20, scale: 7 }).notNull(),
    fiatCode: text("fiat_code").notNull(),
    /** Fiat per one unit of the asset. */
    rate: numeric("rate", { precision: 20, scale: 4 }).notNull(),
    /** City chosen by the user; coordinates are that city's centroid. */
    cityId: text("city_id").notNull(),
    cityName: text("city_name").notNull(),
    countryCode: text("country_code").notNull(),
    latitude: numeric("latitude", { precision: 9, scale: 5 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 5 }).notNull(),
    note: text("note"),
    status: listingStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("listings_status_idx").on(t.status),
    check("listings_min_amount_positive", sql`${t.minAmount} > 0`),
    check("listings_max_amount_gte_min", sql`${t.maxAmount} >= ${t.minAmount}`),
    check("listings_rate_positive", sql`${t.rate} > 0`),
    check("listings_remaining_in_range", sql`${t.remainingAmount} >= 0 AND ${t.remainingAmount} <= ${t.maxAmount}`),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id").notNull().references(() => listings.id),
    seller: text("seller").notNull().references(() => users.publicKey),
    buyer: text("buyer").notNull().references(() => users.publicKey),
    openedBy: tradeRole("opened_by").notNull(),
    asset: assetCode("asset").notNull(),
    amount: numeric("amount", { precision: 20, scale: 7 }).notNull(),
    fiatCode: text("fiat_code").notNull(),
    fiatAmount: numeric("fiat_amount", { precision: 20, scale: 2 }).notNull(),
    state: tradeState("state").notNull().default("listed"),
    disputed: boolean("disputed").notNull().default(false),
    windowSeconds: integer("window_seconds").notNull(),
    balanceId: text("balance_id"),
    lockTx: text("lock_tx"),
    claimTx: text("claim_tx"),
    reclaimTx: text("reclaim_tx"),
    /** Ledger close time of the lock, when known. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** Last trade.sync search of Horizon; throttles polling. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Protected trades. Every column is nullable or defaulted, so the build
    // before them keeps working on this schema. window_seconds stays NOT
    // NULL; a protected trade stores 0.
    mode: tradeMode("mode").notNull().default("claimable"),
    /** The protected-trade terms both sides accepted (ACCEPTANCE_VERSION). */
    acceptanceVersion: text("acceptance_version"),
    sellerAcceptedAt: timestamp("seller_accepted_at", { withTimezone: true }),
    buyerAcceptedAt: timestamp("buyer_accepted_at", { withTimezone: true }),
    /** The one-time creation key's public address; its secret is never sent. */
    escrowAdmin: text("escrow_admin"),
    escrowContractId: text("escrow_contract_id"),
    createTx: text("create_tx"),
    fundTx: text("fund_tx"),
    releaseTx: text("release_tx"),
    disputeTx: text("dispute_tx"),
    resolveTx: text("resolve_tx"),
    /** Ledger close times of the fund, dispute and resolve transactions. */
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** When Pairy recorded the dispute; the 24 h answer window starts here (DECISIONS 1). */
    disputeRecordedAt: timestamp("dispute_recorded_at", { withTimezone: true }),
    /** The signer of the dispute transaction, read from the transaction. */
    disputeOpenedBy: tradeRole("dispute_opened_by"),
    /** Last Trustless Work prepare for this trade; throttles them. */
    escrowPreparedAt: timestamp("escrow_prepared_at", { withTimezone: true }),
  },
  (t) => [
    index("trades_seller_idx").on(t.seller),
    index("trades_buyer_idx").on(t.buyer),
    // The remaining-amount recompute and the listing lock read trades by listing.
    index("trades_listing_idx").on(t.listingId),
    // One escrow backs at most one trade.
    uniqueIndex("trades_escrow_contract_idx").on(t.escrowContractId),
    // One on-chain lock backs at most one trade.
    uniqueIndex("trades_balance_id_idx").on(t.balanceId),
    check("trades_seller_not_buyer", sql`${t.seller} <> ${t.buyer}`),
    check("trades_amount_positive", sql`${t.amount} > 0`),
    check("trades_fiat_amount_nonnegative", sql`${t.fiatAmount} >= 0`),
    // Every state past agreed is backed by an on-chain lock, and each terminal
    // settlement by the transaction that made it.
    check(
      "trades_lock_recorded",
      sql`${t.state} NOT IN ('locked', 'claimed', 'reclaimed') OR (${t.balanceId} IS NOT NULL AND ${t.lockTx} IS NOT NULL)`,
    ),
    check("trades_claim_recorded", sql`${t.state} <> 'claimed' OR ${t.claimTx} IS NOT NULL`),
    check("trades_reclaim_recorded", sql`${t.state} <> 'reclaimed' OR ${t.reclaimTx} IS NOT NULL`),
    // Protected trades. A trade_state value added in 0008 cannot be used
    // before 0008's transaction commits, and prod runs 0006-0008 in one
    // (FIXES R-4), so these compare state::text.
    check("trades_protected_usdc", sql`${t.mode}::text <> 'protected' OR ${t.asset}::text = 'USDC'`),
    check("trades_protected_terms", sql`(${t.mode}::text = 'protected') = (${t.acceptanceVersion} IS NOT NULL)`),
    check(
      "trades_mode_states",
      sql`(${t.mode}::text = 'claimable' AND ${t.state}::text IN ('listed', 'agreed', 'locked', 'claimed', 'reclaimed', 'cancelled')) OR (${t.mode}::text = 'protected' AND ${t.state}::text IN ('listed', 'agreed', 'escrow_created', 'funded', 'released', 'resolved_buyer', 'resolved_seller', 'cancelled'))`,
    ),
    check(
      "trades_escrow_recorded",
      sql`${t.state}::text NOT IN ('escrow_created', 'funded', 'released', 'resolved_buyer', 'resolved_seller') OR (${t.escrowContractId} IS NOT NULL AND ${t.createTx} IS NOT NULL AND ${t.escrowAdmin} IS NOT NULL)`,
    ),
    check(
      "trades_fund_recorded",
      sql`${t.state}::text NOT IN ('funded', 'released', 'resolved_buyer', 'resolved_seller') OR (${t.fundTx} IS NOT NULL AND ${t.fundedAt} IS NOT NULL)`,
    ),
    check("trades_release_recorded", sql`${t.state}::text <> 'released' OR ${t.releaseTx} IS NOT NULL`),
    check(
      "trades_resolve_recorded",
      sql`${t.state}::text NOT IN ('resolved_buyer', 'resolved_seller') OR (${t.resolveTx} IS NOT NULL AND ${t.disputeTx} IS NOT NULL)`,
    ),
    check(
      "trades_dispute_recorded",
      sql`${t.mode}::text <> 'protected' OR ${t.disputed} = false OR (${t.disputeTx} IS NOT NULL AND ${t.disputedAt} IS NOT NULL AND ${t.disputeRecordedAt} IS NOT NULL AND ${t.disputeOpenedBy} IS NOT NULL)`,
    ),
    check(
      "trades_protected_accepted",
      sql`${t.mode}::text <> 'protected' OR ${t.state}::text IN ('listed', 'cancelled') OR (${t.sellerAcceptedAt} IS NOT NULL AND ${t.buyerAcceptedAt} IS NOT NULL)`,
    ),
  ],
);

/** Append-only history of a trade's transitions, with tx hashes. */
export const tradeEvents = pgTable(
  "trade_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id").notNull().references(() => trades.id),
    type: text("type").notNull(),
    by: text("by").notNull(),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trade_events_trade_idx").on(t.tradeId)],
);

/** Per-deal chat. Purged when the trade reaches a terminal state. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_trade_idx").on(t.tradeId)],
);

/**
 * Each side's one answer in a protected trade's dispute: was the cash handed
 * over in full? Never updated (DECISIONS 10). The note is cleared with the
 * chat on a terminal state; the yes/no answers stay.
 */
export const disputeAnswers = pgTable(
  "dispute_answers",
  {
    tradeId: uuid("trade_id").notNull().references(() => trades.id),
    role: tradeRole("role").notNull(),
    cashHandedOver: boolean("cash_handed_over").notNull(),
    note: text("note"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tradeId, t.role] }),
    check("dispute_answers_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
  ],
);

/**
 * A resolution the arbiter's signers are signing: the unsigned transaction
 * and the signatures collected so far. Public data only; it can only be
 * submitted as prepared.
 */
export const arbiterResolutions = pgTable(
  "arbiter_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id").notNull().references(() => trades.id),
    outcome: resolutionOutcome("outcome").notNull(),
    /** The published rule (1, 2 or 3) that gave the outcome. */
    rule: smallint("rule").notNull(),
    recipient: text("recipient").notNull(),
    /** The whole escrow balance at prepare time. */
    amount: numeric("amount", { precision: 20, scale: 7 }).notNull(),
    unsignedXdr: text("unsigned_xdr").notNull(),
    /** The unsigned transaction's hash; signatures do not change it. */
    txHash: text("tx_hash").notNull(),
    /** The unsigned transaction plus the signatures collected so far. */
    signedXdr: text("signed_xdr").notNull(),
    signers: text("signers").array().notNull().default(sql`'{}'`),
    status: resolutionStatus("status").notNull().default("collecting"),
    preparedBy: text("prepared_by").notNull(),
    /** The transaction's maxTime; null falls back to created_at + 10 min. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    submittedTx: text("submitted_tx"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("arbiter_resolutions_rule_valid", sql`${t.rule} IN (1, 2, 3)`),
    // At most one resolution is being signed at a time, across all trades.
    uniqueIndex("arbiter_resolutions_one_open").on(t.status).where(sql`${t.status} = 'collecting'`),
  ],
);
