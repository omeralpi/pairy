# Rehearsal of migration 0006 (remaining amount) against the old build

Date: 2026-11-24, 07:20 to 08:35 UTC. Everything below ran on one machine against a throwaway docker Postgres. Nothing was pushed, deployed or run against a hosted database.

Migration `0006_listing_remaining` (commit `38b5357`) adds `listings.remaining_amount` as `NOT NULL`. Production will be migrated before the matching code is deployed, so for a short window the build that is live does not know the column. This rehearsal checks what that window looks like, and what the release step has to do after it.

## Setup

| Piece | What was used |
|---|---|
| Database | `postgres:16-alpine` (16.15) in its own compose project `pairy-wp17`, published on `127.0.0.1:35417`, removed with `down -v` afterwards |
| Old build | `72800bb` (the commit production runs today) in a detached scratch worktree, `next build` + `next start -p 3005` |
| New build | `phase2/track-b` at `3363de1`, the same way, on the same port after the old build was stopped |
| Clients | tRPC over HTTP from Node 22.23.2 (SEP-53 sign-in with throwaway, unfunded testnet keys), and headless Chrome 158 driven over the DevTools protocol for the pages |
| Accounts | T (`GBU4…BUMT`) owns the listings; B (`GCTQ…66IC`) and C (`GBYW…NWP6`) trade on them |

## Steps and results

### 1. Migrate to 0005 with the old code, seed every state

`pnpm db:migrate` from the `72800bb` checkout applied 0000 to 0005 (6 rows in `drizzle.__drizzle_migrations`; `listings` has no `remaining_amount`). Plain SQL then seeded 3 users, 7 listings and 12 trades, one in every 0005 state:

| Listing | Status | min to max | Trades | Expected after 0006 |
|---|---|---|---|---|
| L1 | active | 10 to 100.5 USDC | listed 10.1234567, agreed 20, locked 30, claimed 5, reclaimed 50, cancelled 60 | 100.5 − (10.1234567 + 20 + 30 + 5) = 35.3765433 |
| L2 | active | 10 to 100 USDC | locked 60, locked 60, locked 60 (oversold) | clamped to 0 |
| L3 | paused | 10 to 100 XLM (buying) | locked 40 | 60 |
| L4 | closed | 25 USDC | cancelled 25 | 25 |
| L5 | active | 10 to 100 USDC | listed 100 | 0 |
| L6 | active | 10 to 100 USDC | none | 100 |
| L7 | active, owned by C | 5 to 50 USDC (buying) | none | 50 |

As a control, the old build's `listing.create` succeeded on 0005 (listing L0, 10 to 100 USDC), and every read answered: `listing.list` (5 active), `listing.byId`, `listing.mine` (6), `trade.mine` (12 for T), `trade.byId`, `auth.me`.

### 2. Apply 0006 from `phase2/track-b` while the old build is up

`pnpm db:migrate` from the `3363de1` checkout applied only 0006 (7 rows now). The column is `numeric(20,7) NOT NULL` and the CHECK `listings_remaining_in_range` is present. Every backfilled value matched the table above, with L0 at 100.

### 3. The old build on the migrated database

Every read still works, over HTTP and in Chrome: `listing.list` with and without filters (6 active listings; the old build does not know the "less than the minimum left" rule, so L2 and L5 are still listed), `listing.byId`, `listing.mine` (7), `trade.mine` (12 for T, 8 for B), `trade.byId`, the map (pins and list view), a listing page, My listings, Trades and a trade page. Nothing in the old build's log, and one entry in the Postgres log, which is the next step.

`listing.create` fails, as expected. The API answered `500 INTERNAL_SERVER_ERROR` with the production message "Something went wrong. Please try again." and the Postgres log has the cause:

```
ERROR:  null value in column "remaining_amount" of relation "listings" violates not-null constraint
DETAIL:  Failing row contains (3f1296b3-…, GBU4…BUMT, sell_crypto, USDC, 10.0000000, 100.0000000, USD, 1.0000, 745044, Istanbul, TR, 41.01000, 28.95000, L8: attempted by the old build after 0006, active, 2026-11-24 08:29:55.384996+00, null).
STATEMENT:  insert into "listings" ("id", "owner", "side", "asset", "min_amount", "max_amount", "fiat_code", "rate", "city_id", "city_name", "country_code", "latitude", "longitude", "note", "status", "created_at") values (default, $1, …, default, default) returning …
```

No row was written. So between the production migration and the deploy, nobody can post a listing; everything else keeps working.

The old build's trade writes do go through, and they do not maintain the new column. Through the old build, B opened a trade of 60 on L6 and T cancelled the listed 10.1234567 trade on L1. Stored against recomputed afterwards:

| Listing | Stored | Should be |
|---|---|---|
| L1 | 35.3765433 | 45.5 |
| L6 | 100 | 40 |

### 4. The new build on the same database

The old build was stopped and `3363de1` started on the same port. The sessions carried over. `listing.list` now hides L2 and L5 (0 left is below their minimum) and every listing read carries `remainingAmount`. Before anything else, the pages showed the drift from step 3: L6 said "100 of 100 USDC left" and My listings "35.3765433 of 100.5 USDC left" for L1.

The backfill statement of 0006 (its second statement, run by hand, unchanged) was then run twice:

```sql
UPDATE "listings" l SET "remaining_amount" = GREATEST(0, l."max_amount" - COALESCE((
  SELECT SUM(t."amount") FROM "trades" t
  WHERE t."listing_id" = l."id" AND t."state"::text IN ('listed', 'agreed', 'locked', 'claimed')), 0));
```

The first run changed exactly L1 (35.3765433 → 45.5) and L6 (100 → 40) and nothing else. The second run left every value as it was, and `remaining_amount IS DISTINCT FROM` the recomputed value matched 0 rows. L6 then showed "40 of 100 USDC left" and My listings "45.5 of 100.5 USDC left".

### 5. A fresh listing through the new build (the three R4 states)

T created "Selling 10 to 100 USDC" (L9). Its page said **"100 of 100 USDC left"**. B opened a trade of 60: the page, My listings and the map card said **"40 of 100 USDC left"**, and C's attempt to open 50 was refused with `BAD_REQUEST` "Only 40 USDC left on this listing. Enter 10 to 40.". B cancelled: the page said **"100 of 100 USDC left"** again and the stored value was 100.0000000 with the one trade `cancelled`. The map card shows the left label only once something is reserved; a full listing's card shows the range alone.

## What this means for the release

1. Migrate production first, then deploy immediately: during the window only `listing.create` fails (500), every read and every trade action works.
2. Right after the new build is live, run 0006's backfill `UPDATE` once more. Trades opened or cancelled by the old build during the window leave `remaining_amount` stale, and that statement corrects every listing in one go; running it again is harmless.
3. Listings whose remaining amount is below their minimum disappear from the map at the deploy (L2 and L5 here); their owners still see them under My listings with the "Hidden from the map" note.
