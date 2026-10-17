# Pairy v1 evidence

This file collects the evidence promised in section 6.1 of the statement of work (SOW) for the Stellar Community Fund InstaWards grant that funds this version of Pairy, one section per deliverable. Links point to a transaction on the Stellar testnet explorer, a CI run on GitHub, a recording, the live demo or a file in this repository.

**Status:** in progress. Anything marked `PENDING` does not exist yet. It will be replaced by a real link when it is produced, never by a placeholder that only looks real.

Pairy runs on the Stellar **testnet** only. No real money is involved anywhere. Pairy has zero users; it is a testnet reference implementation, not a product in use.

**Where the transactions come from.** Most transactions below were produced by the scripts in [`scripts/evidence/`](scripts/evidence/), and their recorded outputs are in [`scripts/evidence/out/`](scripts/evidence/out/). Six were not. The two early reclaim attempts on the real 72-hour locks and the hosted-demo smoke test's claim came from one-off scripts kept out of the repository because they read testnet keys. The smoke test's lock and the device-wallet lock and claim were signed by hand in a browser. Every hash can still be checked on stellar.expert.

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

"3 days" is how stellar.expert displays 259,200 seconds, which is 72 hours. In protocol terms the buyer's condition is `BEFORE_RELATIVE_TIME(259200)` and the seller's is its `NOT`; [more detail](docs/settlement-rail-comparison.md#how-the-lock-appears-on-stellarexpert).

To check a **claim** or a **reclaim**, open its link. The line reads "*account* claimed balance *id*". For a claim, *account* is the buyer. For a reclaim, it is the seller. The balance id matches the one created by the lock. The same transaction can be confirmed independently on Stellar's own servers at `https://horizon-testnet.stellar.org/transactions/<hash>`.

---

## Deliverable 1: CAP-23 settlement layer and TradeStateMachine

Evidence type: public GitHub repo, green CI run, transaction hashes on stellar.expert, this file.

### Code

| Item | Link | Status |
|---|---|---|
| Public repository | PENDING (repo not yet public) | PENDING |
| `lib/stellar/settlement.ts` (the settlement surface: the four stock SDK calls, assembled with `TransactionBuilder`) | [lib/stellar/settlement.ts](lib/stellar/settlement.ts) | Written; not yet published |
| `lib/trade/state-machine.ts` (TradeStateMachine) | [lib/trade/state-machine.ts](lib/trade/state-machine.ts) | Written; not yet published |
| Green CI run on the public repo | PENDING | PENDING |

### Testnet transactions

Each row is one transaction on stellar.expert. The 60-second reclaim uses a test lock whose window is 60 seconds instead of 72 hours, waited out during the test run. The real 72-hour reclaim uses a balance locked on purpose and left alone until it matures on its own.

| Step | Native XLM | Testnet USDC |
|---|---|---|
| Lock (72-hour window) | [`7c5b7f75…3899`](https://stellar.expert/explorer/testnet/tx/7c5b7f75cdd14eab7adf97ed5ca408b659f60021700daba6ac6321ec1d263899) | [`aa3001a4…25d8`](https://stellar.expert/explorer/testnet/tx/aa3001a462f433d0df06528e45e7fd26d2f5bdc88fd3dead9477a3a573ff25d8) |
| Claim by the buyer | [`50337eab…81ad`](https://stellar.expert/explorer/testnet/tx/50337eab3e73da498dd440bb894985d4d1b6cf6af079562830af09e5c0ba81ad) | [`bc61af15…8d62`](https://stellar.expert/explorer/testnet/tx/bc61af1514b7057bf9f071a48a78d6d7e8ad8e835ca8af7f8719ad23eb308d62) |
| Lock (60-second test window) | [`cfa40fc3…c1a8`](https://stellar.expert/explorer/testnet/tx/cfa40fc3cd8cc5c75dc7e42686adcab350b4e5814c9461daa06be926e777c1a8) | [`3faa888b…de24`](https://stellar.expert/explorer/testnet/tx/3faa888b743ffc929464971fa05b7379e278a2a92ae73799b6f57e4134c0de24) |
| Early reclaim attempt before the 60 seconds were up (rejected on-chain with `op_cannot_claim`, as it should be) | [`491b3d15…06b8`](https://stellar.expert/explorer/testnet/tx/491b3d15316b0ba98c813ba232ec5f69c1e2550e34c66c523aadbc0fbd0606b8) | [`bc4cd234…56cf`](https://stellar.expert/explorer/testnet/tx/bc4cd234b08e8cb0239b70200f1286af4fd390b63288bcb73de386c27c5b56cf) |
| Reclaim by the seller after 60 seconds | [`45e5053f…81b8`](https://stellar.expert/explorer/testnet/tx/45e5053f106f2cc66dcb7a79aa041472957cc5688aea205b7596528ad8fc81b8) | [`c1ade40e…8b78`](https://stellar.expert/explorer/testnet/tx/c1ade40ea7126f6f8435356bb51323e2daf2a10c8cc9d29a92094c30153e8b78) |
| Lock deliberately abandoned (72-hour window), opened 2026-10-15 ~06:55 UTC, matures 2026-10-18 ~06:55 UTC | [`02b073e7…0598`](https://stellar.expert/explorer/testnet/tx/02b073e7e976360eda6467f56e8508d25ee97afbafbdbd9ad7f28e8dcbbd0598) | [`340d915d…62a9`](https://stellar.expert/explorer/testnet/tx/340d915d875621a6c86075840c7cfa0a624a286c090c8055275cd4b2dcde62a9) |
| Early reclaim attempt on that real 72-hour lock, before it matured (rejected on-chain with `op_cannot_claim`: the window is enforced) | [`a8bb0db5…9c00`](https://stellar.expert/explorer/testnet/tx/a8bb0db50e6ab7e56c344b6aa9b4cc90219c24e30e582fdeabea40a125f49c00) | [`0079ce6f…ae7c`](https://stellar.expert/explorer/testnet/tx/0079ce6fe6a1895a5c12239c96ce8f0381f8db15e97f86e8d91d8392d75cae7c) |
| Reclaim by the seller after the real 72 hours matured | Scheduled: the XLM lock matures 2026-10-18 06:54:57 UTC | Scheduled: the USDC lock matures 2026-10-18 06:55:27 UTC |

### Measured fees and reserves (stroops)

1 XLM = 10,000,000 stroops. These numbers are read from the transactions above. The "network parameter" column shows the testnet settings on 2026-10-15 (Horizon, latest ledger) for comparison only; it is not a measurement of Pairy's transactions.

| Item | Network parameter (2026-10-15) | Measured on Pairy's transactions |
|---|---|---|
| Fee charged, lock transaction | base fee 100 per operation | 100 (every lock above, Horizon `fee_charged`) |
| Fee charged, claim transaction | base fee 100 per operation | 100, paid by the buyer |
| Fee charged, reclaim transaction | base fee 100 per operation | 100. A rejected early reclaim is also charged 100 |
| Reserve locked against the seller while the balance exists (one base reserve per claimant, two claimants) | base reserve 5,000,000 per claimant, so 10,000,000 for two | 10,000,000. The seller's `num_sponsoring` goes 0 → 2 and minimum balance 10,000,000 → 20,000,000. The reserve is not deducted from the balance; it raises the minimum the seller must keep, so it cannot be spent until the lock ends. XLM seller balance 100,000,000,000 → 99,949,999,900 = the 50,000,000 locked + the 100 fee |
| Reserve returned to the seller on claim or reclaim | same amount, returned to the creator ([Stellar docs](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves)) | Returned to the seller: after the buyer's claim the seller's `num_sponsoring` is back to 0 and minimum balance back to 10,000,000, while the buyer's stays 0. The buyer receives the amount (+49,999,900 = 5 XLM − their own 100 fee), not the reserve |

### Trustless Work comparison and upstream issue

**Summary.** Pairy settles with CAP-23 claimable balances because a two-person trade has only two humans. Trustless Work's Soroban escrow needs a third one. Checked against Trustless Work's own docs and code on 2026-10-15:

- **A dispute resolver is required.** V2 rejects an escrow with no resolver ("roles.dispute\_resolvers must contain at least one address"). In V1 the resolver is a mandatory field.
- **The resolver must be a separate address.** V2 docs: "A dispute resolver cannot also appear in approvers, service\_providers, release\_signers or be the receiver / platform", and the V2 contract enforces it. V1 neither states nor enforces this rule.
- **There is no deadline field**, in the V2 deploy payload or in the contract. If the buyer never shows up, the only way the funds go back to the seller is a dispute settled by the resolver. The resolver can split the funds across any addresses.
- **OfferHub and ArcusX** are both built on Trustless Work and are both remote freelance marketplaces. Neither one is local, in person or cash-settled.
- **CAP-23** gives exactly what the trade needs: two claimants, time conditions that meet exactly at 72 hours, and no third role. The cost, stated plainly: there is no dispute resolution. The buyer can claim at any moment inside the window whether or not the cash has changed hands. v1 protects the seller only against the buyer not acting, not against theft.

| Item | Link | Status |
|---|---|---|
| Full written comparison, with quotes and sources | [docs/settlement-rail-comparison.md](docs/settlement-rail-comparison.md) | Written |
| Upstream issue (Trustless Work: optional on-chain deadline with a funder refund path) | PENDING (to be filed on [Trustless-Work/trustlesswork-smart-contract-stellar](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues)) | PENDING |

---

## Deliverable 2: device-generated keys and the trade flow

Evidence type: transaction hash on stellar.expert, screen recordings, green CI runs.

| Item | What it shows | Link | Status |
|---|---|---|---|
| Transaction signed by a device-generated wallet | A testnet transaction signed by a key generated in the user's own browser by the device wallet, which sends Pairy only public keys and signatures | Lock [`c0c9e6c2…64c8`](https://stellar.expert/explorer/testnet/tx/c0c9e6c29dc15f6112afbc97fc2110f8bc1a37275ca0684ea649590805a164c8) and claim [`bc74206a…3d6b`](https://stellar.expert/explorer/testnet/tx/bc74206a5780adf6bbf35b24450ef53c548588014078c628e9db21a7b1223d6b), each signed in the browser by a device-generated wallet during a local end-to-end trade on 2026-10-15 (seller and buyer on two separate browser origins) | Done for device ↔ device |
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
| Live demo URL (testnet) | Listings on the map, at the city level each user chose | https://pairy.org | Live since 2026-10-15 UTC (also at https://pairy-seven.vercel.app). Smoke-tested end to end on the hosted demo: a seller using a device-generated wallet in the browser listed 1 to 20 XLM in Istanbul, a scripted buyer using the same public API and sign-in opened a 10 XLM trade, the seller agreed and locked [`e8a800ad…4151`](https://stellar.expert/explorer/testnet/tx/e8a800ad91e2121d5beb7f55172ca46af801ec36967a9e923a4853fa53634151) (buyer `rel_before 259200`, seller `not rel_before 259200`), the buyer claimed [`83087e00…4d9a`](https://stellar.expert/explorer/testnet/tx/83087e00e84c10e2cda251f632a26e013b612f7cb0bd5f2cd8b9e68c95a54d9a), the trade reached `claimed` and its chat went from 1 message to 0 |
| Public repository | Source for everything above | PENDING | PENDING |
| 2-minute walkthrough video | The full flow, including the lock screen stating the buyer-claim bound | PENDING | PENDING |
| Settlement steps on stellar.expert | Every lock, claim and reclaim made in the demo, reachable through the links in Deliverable 1 and 2 | Hosted demo lock and claim in the row above; all others in Deliverable 1 | Partial |

---

## Reviewer checklist (SOW 6.2)

| Deliverable | Evidence present | Evidence partial | Evidence missing | Comments |
|---|---|---|---|---|
| Deliverable 1 | ☐ | ☐ | ☐ | |
| Deliverable 2 | ☐ | ☐ | ☐ | |
| Deliverable 3 | ☐ | ☐ | ☐ | |
