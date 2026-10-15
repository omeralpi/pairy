// What Pairy stores, and nothing more (SOW D3): Stellar public keys, listing
// terms, claimable balance IDs and transaction hashes, and trade state. No
// private keys or anything a key could be derived from, no names, no phone
// numbers, no identity documents. Per-deal chat lives only until the trade
// reaches a terminal state.

import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { ASSET_CODES } from "@/lib/stellar/assets";
import { TRADE_STATES } from "@/lib/trade/state-machine";

export const assetCode = pgEnum("asset_code", ASSET_CODES);
export const tradeState = pgEnum("trade_state", TRADE_STATES);
export const tradeRole = pgEnum("trade_role", ["seller", "buyer"]);
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

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull().references(() => users.publicKey),
    side: listingSide("side").notNull(),
    asset: assetCode("asset").notNull(),
    minAmount: numeric("min_amount", { precision: 20, scale: 7 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 20, scale: 7 }).notNull(),
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
  (t) => [index("listings_status_idx").on(t.status)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trades_seller_idx").on(t.seller),
    index("trades_buyer_idx").on(t.buyer),
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
