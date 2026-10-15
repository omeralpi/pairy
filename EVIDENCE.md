# Pairy v1 evidence

This file collects the evidence promised in section 6.1 of the Pairy Instaward SOW, one section per deliverable. Every link here points to something public: a transaction on the Stellar testnet explorer, a CI run on GitHub, a recording or the live demo.

**Status:** in progress. Anything marked `PENDING` does not exist yet. It will be replaced by a real link when it is produced, never by a placeholder that only looks real.

Pairy runs on the Stellar **testnet** only. No real money is involved anywhere. Pairy has zero users; it is a testnet reference implementation, not a product in use.

---

## How to check a lock yourself (no technical background needed)

A "lock" is the transaction where the seller puts the crypto aside for the buyer. This is how to check that a lock is set up correctly:

1. Click the lock's transaction link below. It opens on **stellar.expert**, a public Stellar explorer that Pairy does not run.
2. Find the line that says **"created claimable balance"**. After the words **"claimable by"** you will see two accounts, each followed by a condition in brackets.
3. Check the two conditions:
   - The **buyer's** account must say **"before 3 days from now"**. The buyer can take the funds only during the first 72 hours.
   - The **seller's** account must say **"after 3 days from now"**. The seller can take the funds back only once those 72 hours are over.
4. There must be **exactly two** accounts, the buyer and the seller. A third account in the list means the lock is wrong.
5. If either account says **"unconditional"**, the lock is broken. "Unconditional" means that account could take the funds at any time.

"3 days" is how stellar.expert displays 259,200 seconds, which is 72 hours. The SOW describes the rows as "before relative time 259200" and "not before relative time 259200". That is the same condition in its raw protocol form, but it is **not** the wording stellar.expert shows. We checked the explorer's actual wording on 2026-10-15; the details are in [docs/settlement-rail-comparison.md](docs/settlement-rail-comparison.md#how-the-lock-appears-on-stellarexpert).

To check a **claim** or a **reclaim**, open its link. The line reads "*account* claimed balance *id*". For a claim, *account* is the buyer. For a reclaim, it is the seller. The balance id matches the one created by the lock. The same transaction can be confirmed independently on Stellar's own servers at `https://horizon-testnet.stellar.org/transactions/<hash>`.

---

## Deliverable 1: CAP-23 settlement layer and TradeStateMachine

Evidence type: public GitHub repo, green CI run, transaction hashes on stellar.expert, this file.

### Code

| Item | Link | Status |
|---|---|---|
| Public repository | PENDING (repo not yet public) | PENDING |
| `lib/stellar/settlement.ts` (the entire settlement surface: four stock SDK calls) | [lib/stellar/settlement.ts](lib/stellar/settlement.ts) | Written; not yet published |
| `lib/trade/state-machine.ts` (TradeStateMachine) | [lib/trade/state-machine.ts](lib/trade/state-machine.ts) | Written; not yet published |
| Green CI run on the public repo | PENDING | PENDING |

### Testnet transactions

Each row is one transaction on stellar.expert. The 60-second reclaim uses a test lock whose window is 60 seconds instead of 72 hours, waited out during the test run. The real 72-hour reclaim uses a balance locked on purpose in Week 1 and left alone until it matured on its own.

| Step | Native XLM | Testnet USDC |
|---|---|---|
| Lock (72-hour window) | PENDING | PENDING |
| Claim by the buyer | PENDING | PENDING |
| Lock (60-second test window) | PENDING | PENDING |
| Reclaim by the seller after 60 seconds | PENDING | PENDING |
| Lock deliberately abandoned in Week 1 (72-hour window) | PENDING | PENDING |
| Reclaim by the seller after the real 72 hours matured | PENDING (cannot exist until 72 hours after the abandoned lock) | PENDING (as left) |

### Measured fees and reserves (stroops)

1 XLM = 10,000,000 stroops. These numbers are read from the transactions above once they exist. The "network parameter" column shows the testnet settings on 2026-10-15 (Horizon, latest ledger) for comparison only; it is not a measurement of Pairy's transactions.

| Item | Network parameter (2026-10-15) | Measured on Pairy's transactions |
|---|---|---|
| Fee charged, lock transaction | base fee 100 per operation | PENDING |
| Fee charged, claim transaction | base fee 100 per operation | PENDING |
| Fee charged, reclaim transaction | base fee 100 per operation | PENDING |
| Reserve locked against the seller while the balance exists (one base reserve per claimant, two claimants) | base reserve 5,000,000 per claimant, so 10,000,000 for two | PENDING |
| Reserve returned to the seller on claim or reclaim | same amount, returned to the creator ([Stellar docs](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves)) | PENDING |

### Trustless Work comparison and upstream issue

**Summary.** Pairy settles with CAP-23 claimable balances because a two-person trade has only two humans. Trustless Work's Soroban escrow needs a third one. Checked against Trustless Work's own docs and code on 2026-10-15:

- **A dispute resolver is required.** V2 rejects an escrow with no resolver ("roles.dispute\_resolvers must contain at least one address"). In V1 the resolver is a mandatory field.
- **The resolver must be a separate address.** V2 docs: "A dispute resolver cannot also appear in approvers, service\_providers, release\_signers or be the receiver / platform", and the V2 contract enforces it. The SOW lists every role except `platform`; Trustless Work added `platform` on 2026-08-27, after the SOW was written. V1 neither states nor enforces this rule.
- **There is no deadline field**, in the V2 deploy payload or in the contract. If the buyer never shows up, the only way the funds go back to the seller is a dispute settled by the resolver. The resolver can split the funds across any addresses.
- **OfferHub and ArcusX** are both built on Trustless Work and are both remote freelance marketplaces. OfferHub's own docs say its order flow covers "both goods and services", so it is not strictly digital-only. Neither one is local, in person or cash-settled.
- **CAP-23** gives exactly what the trade needs: two claimants, time conditions that meet exactly at 72 hours, and no third role. The cost, stated plainly: there is no dispute resolution. The buyer can claim at any moment inside the window whether or not the cash has changed hands. v1 protects the seller only against the buyer not acting, not against theft.

| Item | Link | Status |
|---|---|---|
| Full written comparison, with quotes and sources | [docs/settlement-rail-comparison.md](docs/settlement-rail-comparison.md) | Written |
| Upstream issue (Trustless Work: optional on-chain deadline with a funder refund path) | PENDING (draft ready in [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md); not filed yet) | PENDING |

---

## Deliverable 2: device-generated keys and the trade flow

Evidence type: transaction hash on stellar.expert, screen recordings, green CI runs.

| Item | What it shows | Link | Status |
|---|---|---|---|
| Transaction signed by a device-generated wallet | A testnet transaction signed by a key that was generated in the user's own browser and never left it | PENDING | PENDING |
| Export / re-import recording | A key exported from one browser, re-imported in a second browser profile, then used to sign a testnet transaction | PENDING | PENDING |
| Re-imported key's signing transaction | The transaction signed in the second browser profile | PENDING | PENDING |
| Two-wallet-type end-to-end run: recording | Two test users, one on Freighter and one on a device-generated wallet, completing a trade end to end | PENDING | PENDING |
| Two-wallet-type end-to-end run: lock hash | The lock from that run | PENDING | PENDING |
| Two-wallet-type end-to-end run: claim hash | The claim from that run | PENDING | PENDING |
| CI test `no-secret-fields` (passing run) | Fails the build if any API endpoint ever accepts a secret key or a pincode | PENDING | Test written ([tests/ci/no-secret-fields.test.ts](tests/ci/no-secret-fields.test.ts)); no public CI run yet |
| CI test `coordination-purge-on-terminal` (passing run) | Asserts that a trade's chat messages are deleted once the trade is claimed, reclaimed or cancelled | PENDING | Test written ([tests/ci/coordination-purge-on-terminal.test.ts](tests/ci/coordination-purge-on-terminal.test.ts)); no public CI run yet |

---

## Deliverable 3: map and hosted demo

Evidence type: live demo URL, public repo, walkthrough video.

| Item | What it shows | Link | Status |
|---|---|---|---|
| Live demo URL (testnet) | Listings on the map, at the city level each user chose | PENDING | PENDING |
| Public repository | Source for everything above | PENDING | PENDING |
| 2-minute walkthrough video | The full flow, including the lock screen stating the buyer-claim bound | PENDING | PENDING |
| Settlement steps on stellar.expert | Every lock, claim and reclaim made in the demo, reachable through the links in Deliverable 1 and 2 | PENDING | PENDING |

---

## Reviewer checklist (SOW 6.2)

| Deliverable | Evidence present | Evidence partial | Evidence missing | Comments |
|---|---|---|---|---|
| Deliverable 1 | ☐ | ☐ | ☐ | |
| Deliverable 2 | ☐ | ☐ | ☐ | |
| Deliverable 3 | ☐ | ☐ | ☐ | |
