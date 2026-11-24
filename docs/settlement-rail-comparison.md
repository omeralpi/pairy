# Settlement rail comparison: CAP-23 claimable balances vs Trustless Work escrow

This note explains why Pairy v1 settles trades with Stellar's built-in claimable balances (CAP-23) and not with Trustless Work's Soroban escrow. It sets out what Trustless Work's escrow requires, from its own documentation and source code, and what claimable balances provide, from CAP-23 and Stellar's documentation.

Sources were read on 2026-10-15. Trustless Work publishes two documentation versions (V1 and V2) and keeps separate contract branches for each, so every quote below names the version it comes from. GitHub links are pinned to a commit so they keep pointing at the text quoted.

The dated [Phase 2 section](#phase-2-2026-11-24) at the end records what has changed since, and why Pairy's opt-in protected trades now use Trustless Work's escrow while the default trade does not.

## The trade we need to settle

Two people meet in person. The seller has crypto (testnet XLM or testnet USDC). The buyer has cash. We need:

1. The seller locks the crypto at the meeting point, once both people are there, so the buyer can see it is really there before handing over the cash.
2. The buyer, and only the buyer, can take it at the meeting, once the cash has changed hands.
3. If the buyer never takes it, the seller gets it back on their own after a fixed time.
4. Nobody else, including Pairy, can move the funds at any point.

There are two humans and nobody else. Any design that needs a third signer breaks requirement 4.

## Summary of findings

| # | Finding | Source |
|---|---|---|
| 1 | Trustless Work's escrow requires a dispute resolver. | V1 and V2 docs and contracts |
| 2 | The resolver cannot also be an approver, service provider, release signer, the receiver or the platform. | V2 docs, enforced by the V2 contract. V1 has no such rule. |
| 3 | There is no deadline field, so the only way funds go back to the funder is a dispute settled by the resolver. | V1 and V2 |
| 4 | The resolver chooses which addresses get paid and how much. | V1 and V2 contracts |
| 5 | OfferHub and ArcusX, both built on Trustless Work, are remote freelance marketplaces, not local, in-person or cash-settled. | Trustless Work and SCF pages |
| 6 | Claimable balances give two claimants, time conditions and no third role. | CAP-23, Stellar docs |

### 1. A dispute resolver is required

**V2.** The deploy endpoint lists `disputeResolvers` as a required field of `roles`. The contract rejects an empty list. The error page says:

> "roles.dispute\_resolvers must contain at least one address."

Source: [ESCROW_DISPUTE_RESOLVERS_LIST_EMPTY](https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/errors/escrow/escrow-dispute-resolvers-list-empty) (V2 docs). The deploy schema on [Deploy (single release, V2)](https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/deploy/initialize-escrow) lists `"required":["approvers","serviceProviders","platform","releaseSigners","disputeResolvers","receiver","admin"]`.

**V1.** In the V1 contract, `Roles.dispute_resolver` is a plain `Address` field and cannot be left out. Source: [`storage/types.rs`, single-release-main @ 6e4d40e](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/6e4d40e25057dc51fcffd9c5cbee05eaf369380a/contracts/escrow/src/storage/types.rs#L29-L36).

### 2. The resolver cannot overlap with the other roles

**V2 documentation, error page.** [ESCROW_DISPUTE_RESOLVER_OVERLAPS_WITH_OTHER_ROLE](https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/errors/escrow/escrow-dispute-resolver-overlaps-with-other-role):

> "A dispute resolver cannot also appear in approvers, service\_providers, release\_signers or be the receiver / platform."

The same page gives the fix: "Give the dispute resolver a distinct address that appears in no other role".

**V2 documentation, roles page.** [Roles in Trustless Work (V2)](https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/roles-in-trustless-work), section "Dispute Resolver separation", says the resolver "cannot also hold a role capable of opening the dispute they would resolve". It then lists Approver, Service Provider, Release Signer, Platform and "relevant Receiver".

**V2 contract (enforced on-chain).** [`validate_dispute_resolver_role_overlap`, single-release-develop-v2 @ 1d22d0c](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/1d22d0c1b9c5788f4fd7184e42024bbe10303756/contracts/escrow/src/core/validators/escrow.rs#L126-L138) rejects any resolver found in `approvers`, `service_providers` or `release_signers`, or equal to `receiver` or `platform`.

**Recent change.** The `platform` exclusion was added through [issue #109](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues/109) ("dispute_resolver role can overlap with platform, enabling self-dealing"), closed on 2026-08-27. Under V2, Pairy cannot be both the platform and the resolver on the same escrow.

**V1 is different.** The V1 roles page lists "Platform Address + Dispute Resolver" as a "common combination", with the risk "Platform gains significant influence over outcomes" ([Roles in Trustless Work (V1)](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview/roles-in-trustless-work)). The V1 contract's escrow validator has no overlap check at all ([`validators/escrow.rs`, single-release-main @ 6e4d40e](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/6e4d40e25057dc51fcffd9c5cbee05eaf369380a/contracts/escrow/src/core/validators/escrow.rs)). It only blocks the resolver from *opening* a dispute (`DisputeResolverCannotDisputeTheEscrow`).

**What this means for a two-person trade.** The resolver can be neither the buyer (the receiver) nor the seller (who would hold the approver, service-provider or release-signer role). So the resolver has to be a third address. Pairy would have to run it or appoint it. This holds in V1 and V2. Under V1 it is not a rule but follows from the role design: a resolver who is also one of the two traders could simply decide the dispute in their own favour.

### 3. No deadline field; the only route back to the funder is a dispute

**V2 deploy payload.** The full field list of `DeployEscrowV2Dto` is `signer`, `engagementId`, `title`, `description`, `roles`, `amount`, `platformFee`, `milestones` and `trustline`. None of them is a deadline, expiry or timeout ([Deploy (single release, V2)](https://docs.trustlesswork.com/trustless-work/v2-en/api-rest/deploy/initialize-escrow)).

**V2 contract.** The on-chain `Escrow` struct has `engagement_id`, `title`, `roles`, `description`, `amount`, `platform_fee`, `milestones`, `dispute`, `released`, `trustline` and `receiver_memo`. It has no time field ([`storage/types.rs` @ 1d22d0c](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/1d22d0c1b9c5788f4fd7184e42024bbe10303756/contracts/escrow/src/storage/types.rs#L58-L70)). A search of the contract sources on every published branch (V1 and V2, single- and multi-release) found no ledger-timestamp check and no deadline, expiry or timeout logic.

**V2 documentation says deadlines are off-chain.** The [Dispute Resolution (V2)](https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/escrow-lifecycle/dispute-resolution) page lists "setting review deadlines" among the processes "your application may still need". It then says:

> "Those are application-layer responsibilities unless explicitly encoded in the contract."

**Which calls move funds.** Funds leave a Trustless Work escrow in only three ways. The first is `release_funds` / `approve_and_release_milestones`, which pays the `receiver` and is signed by a release signer. The second is `resolve_dispute`, signed by a dispute resolver. The third is `withdraw_remaining_funds`, also signed by a dispute resolver ([CONTRACT_DOCUMENTATION.md §5 @ 1d22d0c](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/1d22d0c1b9c5788f4fd7184e42024bbe10303756/CONTRACT_DOCUMENTATION.md)). The funder holds no role by default; the V2 roles page says "Funders are not a role". So if the buyer never shows up, the seller can get the funds back only through a dispute that the resolver settles.

### 4. The resolver decides where funds go

`resolve_dispute` takes a `distributions` map of address to amount. The contract checks the caller, that the escrow is disputed, and that the amounts add up to the whole balance. It does **not** check that the addresses belong to the escrow's parties ([`validate_dispute_resolution_conditions` @ 1d22d0c](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/blob/1d22d0c1b9c5788f4fd7184e42024bbe10303756/contracts/escrow/src/core/validators/dispute.rs#L48-L80)). The V2 docs say this is intended: resolution is "not restrict[ed]" to paying the receiver or refunding the funder, and their example sends funds to "Vendor A", "Vendor B" and "Customer" ([Dispute Resolution (V2)](https://docs.trustlesswork.com/trustless-work/v2-en/introduction/technology-overview/escrow-lifecycle/dispute-resolution)).

That flexibility is right for a marketplace with a support team. For Pairy it would mean a Pairy-run address that can send a user's locked funds anywhere. Pairy v1 is designed so that no such address exists.

### 5. OfferHub and ArcusX

- **OfferHub.** Trustless Work lists it among its open-source dApps. Its docs say it "composes" Airtm, "Trustless Work: non-custodial escrow engine + disputes" and Stellar USDC, with "platform customer support as resolver" ([OfferHub: Marketplace](https://docs.trustlesswork.com/trustless-work/oss-dapps/offerhub-marketplace)). Its SCF #44 submission calls it "a freelance marketplace on Stellar where client payments lock into Soroban escrow and release only upon delivery" ([SCF submission](https://communityfund.stellar.org/submissions/recQJGuWgzvNmv2sM)). Its SCF project page lists "design, programming, writing, consulting" ([SCF project](https://communityfund.stellar.org/project/offer-hub-o3j)). Remote: yes. Built on Trustless Work: yes.
- **ArcusX.** Trustless Work's ecosystem page labels it "Built with Trustless Work" and calls it "a freelancing platform built on Stellar that enables fast, low-cost, and trustless payments through real escrow infrastructure". The page also says it "focuses on digitally skilled individuals" ([Trustless Work ecosystem: ArcusX](https://www.trustlesswork.com/ecosystem/arcusx)). An older, archived ArcusX repository ([Arcus-DAO/ArcusX](https://github.com/Arcus-DAO/ArcusX), archived) describes a version built on Base. The Stellar version's own repository was not publicly reachable when checked.

Neither one is local, in person or cash-settled.

### 6. What CAP-23 gives instead

CAP-23 ([core/cap-0023.md](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0023.md), status "Final", protocol 14) adds two operations, `CreateClaimableBalanceOp` and `ClaimClaimableBalanceOp`. Each balance has a list of claimants (at most 10, `Claimant claimants<10>`). Each claimant is an account plus a predicate, which is a condition on time. The predicate types are `UNCONDITIONAL`, `AND`, `OR`, `NOT`, `BEFORE_ABSOLUTE_TIME` and `BEFORE_RELATIVE_TIME`.

The parts Pairy relies on:

- **Only a listed claimant can claim, and only while its predicate is true.** The claim fails "if there is no `i` such that `claimants[i].destination = sourceAccount` or if `claimants[i].predicate` is not satisfied" (CAP-23, ClaimClaimableBalanceOp step 2). A claim is an ordinary transaction from the claimant's own account, so only that account's key can make it.
- **Relative time is fixed when the lock lands.** At creation, "`CLAIM_PREDICATE_BEFORE_RELATIVE_TIME` will be converted to `CLAIM_PREDICATE_BEFORE_ABSOLUTE_TIME` by adding `relBefore` to the `closeTime`" of the ledger (CAP-23, CreateClaimableBalanceOp step 7). Stellar's [claimable balances guide](https://developers.stellar.org/docs/build/guides/transactions/claimable-balances) describes `BEFORE_RELATIVE_TIME(X)` as claimable "before X seconds + the ledger close time in which the ClaimableBalanceEntry was created", and `NOT(BEFORE_RELATIVE_TIME(X))` as claimable "at or after" that moment. The two windows meet exactly and never overlap.
- **There are no other roles.** The entry holds an asset, an amount, the claimants and the reserve. There is no admin, no resolver and no field that can be changed after creation. CAP-23 calls the claimant list "finite and immutable".
- **The reserve returns to the creator.** The guide says: "each claimant in that entry increases the source account's minimum balance by one base reserve". The [sponsored reserves guide](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves) says: "the account that created it gets the base reserve back". So the seller pays the two base reserves and gets them back whether the buyer claims or the seller reclaims.
- **Trustlines.** The guide says: "A trustline must be established by the claimant to the asset before it can claim the claimable balance, otherwise, the claim will result in an `op_no_trust` error." Creating the balance does not need the buyer's trustline; claiming it does. That is why the SOW has the lock screen block the seller until the buyer's USDC trustline exists.

Pairy's lock is exactly:

```
buyer:  BEFORE_RELATIVE_TIME(259200)        // can claim during the first 72 hours
seller: NOT(BEFORE_RELATIVE_TIME(259200))   // can reclaim from hour 72 onward
```

It is built from four stock SDK calls, assembled with `TransactionBuilder` (`Claimant.predicateBeforeRelativeTime`, `Claimant.predicateNot`, `Operation.createClaimableBalance`, `Operation.claimClaimableBalance`) in [`lib/stellar/settlement.ts`](../lib/stellar/settlement.ts).

## Side by side, for this trade

| | CAP-23 claimable balance (Pairy v1) | Trustless Work single-release escrow |
|---|---|---|
| What holds the funds | A ledger entry built into the protocol | A Soroban contract deployed per escrow |
| Parties that must be named | Buyer, seller | Approver(s), service provider(s), release signer(s), receiver, platform, dispute resolver(s), and in V2 an admin |
| Minimum number of distinct addresses | 2 | 3 (the resolver must differ from both traders) |
| Buyer gets the funds by | Claiming, signed with the buyer's own key | A release signer releasing to the receiver, once all milestones are approved |
| Seller gets the funds back by | Reclaiming after 72 hours, signed with the seller's own key | A dispute, resolved by the resolver |
| Deadline | Part of the lock itself (time predicates) | None on-chain; the docs leave deadlines to the application |
| Can a third party move the funds | No; no such role exists | Yes, the resolver, during a dispute, to any addresses |
| Dispute resolution | None | Built in |
| Fees to use the rail | Network fee only | The contract also takes a Trustless Work fee (30 basis points in the V1 validator) plus any platform fee |

## What claimable balances do not do

Choosing CAP-23 has a cost, and Pairy states it rather than hiding it:

- **There is no dispute resolution.** Once the seller locks, the buyer can claim at any moment inside 72 hours, whether or not the cash has changed hands. Pairy v1 protects the buyer from a seller who takes the cash and never sends. It protects the seller only against the buyer not acting, not against theft. This is why the lock screen tells the seller to lock only when both people are at the meeting point.
- **A balance can be stranded.** CAP-23 notes that if every claimant account is merged and no key survives, the balance can no longer be claimed. Stellar's guide adds "there is no recovery mechanism for a claimable balance in general".
- **Asset issuers keep their powers.** If the issuer revokes the buyer's authorization, the claim fails with `NOT_AUTHORIZED`. On testnet, Circle's USDC issuer `GBBD47IF…LFLA5` has `auth_revocable: true` and `auth_clawback_enabled: false` (Horizon, 2026-10-15). This applies equally to any escrow that holds the asset.

When dispute resolution becomes part of the product, Trustless Work is the planned rail (SOW Phase 2). By then, a resolver is a role Pairy actually needs, not a workaround.

## How the lock appears on stellar.expert

stellar.expert shows the lock's conditions in plain words rather than as protocol fields. On 2026-10-15 we checked how, with a probe lock built with the same predicates as `settlement.ts` (1 testnet XLM, throwaway accounts, sent by a one-off script, not by the Pairy app): [6cf9488b…c694d](https://stellar.expert/explorer/testnet/tx/6cf9488bcfbc069f6c8c4da69e0179fcdfa334ce58b70f89bf0940ddc0fc694d). The transaction page reads:

```
GA5I…FHVC created claimable balance BATE…W7PU 1 XLM claimable by
GCRS…YWQ3 (before 3 days from now), GA5I…FHVC (after 3 days from now)
```

That wording comes from stellar.expert's formatter ([`claim-conditions-xdr-parser.js`](https://github.com/stellar-expert/ui-framework/blob/c162c8de188344ca49d971cb61faf16d686f6c16/claimable-balance/claim-conditions-xdr-parser.js)). It writes `BEFORE_RELATIVE_TIME(259200)` as "before 3 days from now" and its `NOT` as "after 3 days from now". 259200 seconds is 72 hours, which is 3 days. Horizon stores the same lock as absolute times (`abs_before: 2026-10-18T06:51:32Z`, and `not` of that for the seller), because the ledger converts relative to absolute when the lock lands. [EVIDENCE.md](../EVIDENCE.md) uses the wording the explorer actually shows.

This probe is not deliverable evidence. Nobody reclaims it, so it matures on 2026-10-18.

## Upstream

The SOW commits to proposing gaps upstream rather than forking a contract. The upstream issue asks Trustless Work for an optional on-chain deadline after which the funder can recover the funds without a resolver. With that, a two-party trade like this one would not need a third address. The issue is filed as [Trustless-Work/trustlesswork-smart-contract-stellar#132](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues/132).

## Phase 2 (2026-11-24)

Written on 2026-11-24. Everything above is the 2026-10-15 reading and still describes the default trade, which is unchanged: a claimable balance with exactly two claimants and no third role.

### What changed since 2026-10-15

- **Pairy now offers a protected trade, opt-in and for USDC only.** Its USDC sits in a Trustless Work V2 single-release escrow instead of a claimable balance. Pairy writes and deploys no contract: every escrow comes from Trustless Work's own factory, and Pairy's server only asks Trustless Work's API for unsigned transactions and never signs one. The rule, the arbiter and the acceptance text are in [arbitration.md](arbitration.md); the dated test runs behind every point below are in [phase2-gates.md](phase2-gates.md).
- **Requirements 2, 3 and 4 are given up, for protected trades only.** The buyer cannot take the USDC alone: the seller releases it (requirement 2). The seller cannot take it back alone after a fixed time: there is no deadline, so a stalled trade goes back only through a dispute (requirement 3, finding 3). And finding 2 holds: the resolver must be a third address (requirement 4). In a protected trade it is the arbiter account, which only the two Pairy builders together can sign for (two signers at weight 1, its own key at weight 0, every threshold 2). The platform role goes to a separate account whose own key is switched off, at a fee of 0, so nobody can use the platform's right to open a dispute.
- **Findings 1, 3 and 4 still hold for the escrow Pairy uses.** There is no deadline: a stalled protected trade goes back to the seller only through a dispute. Once a dispute is open, the resolver can pay any address; only Pairy's code holds the arbiter to the rule's two outcomes.
- **What testnet showed in November 2026.**
  - A classic 2-of-2 Stellar account works as the only dispute resolver. Trustless Work's API and the V2 contract accepted it, and its `resolve_dispute` needs only the account's envelope signatures. On the day-12 gate (2026-11-24) each builder's signature alone was refused (`tx_bad_auth`) and the two together paid out, once to the buyer and once to the seller.
  - The seller, as approver, service provider and release signer, releases alone with one signature, through Trustless Work's `/approve-and-release-milestones` call. No milestone-status step comes first.
  - Every exit, refunds included, pays 0.3% to Trustless Work's fee address, which each release and resolve names as an argument. Pairy pins that address and refuses a transaction that names another.
  - Trustless Work prepares each transaction valid for 300 seconds. Before the two arbiter signers sign a resolution, Pairy moves only its time limit to one hour; every other field stays byte for byte as Trustless Work prepared it.
  - Trustless Work's read model kept a resolved escrow's status at "active", so Pairy reads an escrow's state from Soroban RPC instead, in the server and in each trader's browser.
  - An escrow's storage lives about 7 days after its creation. A longer-idle escrow can still be read, and its next call restores it for a small extra fee.
- **A new dependency.** Pairy builds no contract call itself, so a protected trade can move only while Trustless Work's hosted V2 API (in beta) prepares its transactions. If the API is down, nothing moves and the USDC stays in the escrow.

### Why the resolver is accepted now

The October reading rejected a resolver because nothing required one: a two-person trade only needs two claimants. What it cannot do is settle a disagreement (see [What claimable balances do not do](#what-claimable-balances-do-not-do)), and that takes someone able to decide. Phase 2 accepts that someone only under three limits:

1. **Only in a protected trade.** The default trade keeps its two claimants. Its "Flag a problem" moves no money, and no arbiter ever sees it.
2. **Only by opt-in.** A protected trade starts off. The trader who opens a trade must switch it on, and both traders must accept the acceptance text, word for word from [arbitration.md](arbitration.md), before any escrow exists. A server switch can stop new protected trades at any time.
3. **Only under a fixed rule.** The rule was committed on 2026-11-23, before the first test escrow. The arbiter cannot open a dispute, does not read the chat and does not judge: the outcome follows from each trader's yes-or-no answer to "Was the cash handed over in full?", and is either all to the buyer or all back to the seller. The arbiter page prepares only that outcome, and every resolution is public on chain and in Trustless Work's escrow viewer.

What a protected trade still cannot promise, said plainly in arbitration.md and on the acceptance screen: the arbiter's keys could sign something else outside Pairy's page, a lost arbiter key leaves a disputed trade's USDC locked in the escrow, and the escrow has no deadline.

### Issue #132, as of 2026-11-24

[#132](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues/132) is open. No maintainer has replied; it has no label, no assignee and no linked pull request. Its only comments are two requests to be assigned from outside contributors (2026-10-19 and 2026-10-24), the last activity on it. Nothing in Phase 2 waits for it: with an on-chain deadline, a stalled protected trade could go back to the seller without a dispute, but protected trades work without one. This paragraph is checked again, and dated again, on the closeout day.
