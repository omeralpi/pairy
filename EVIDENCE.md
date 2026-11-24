# Pairy v1 evidence

This file collects the evidence promised in section 6.1 of the statement of work (SOW) for the Stellar Community Fund InstaWards grant that funds this version of Pairy, one section per deliverable. Links point to a transaction on the Stellar testnet explorer, a CI run on GitHub, a recording, the live demo or a file in this repository.

**Status:** complete as of 2026-10-19. Every item below links to its evidence. The screen recording is shared with the reviewer in the sprint closeout form rather than published here; the transactions it shows are linked below.

**Month 2.** The evidence for the second InstaWards month (Privy wallets, protected trades, remaining amounts and EURC) is in [its own section](#month-2-privy-wallets-protected-trades-remaining-amounts-and-eurc) at the end of this file. Stellar testnet is reset on 2026-12-16 at 17:00 UTC. The Phase 1 links below are pre-reset links: every transaction they point to is archived in [`scripts/evidence/archive/`](scripts/evidence/archive/), where it can still be checked after that date.

Pairy runs on the Stellar **testnet** only. No real money is involved anywhere. Pairy has zero users; it is a testnet reference implementation, not a product in use.

**Where the transactions come from.** Most transactions below were produced by the scripts in [`scripts/evidence/`](scripts/evidence/), and their recorded outputs are in [`scripts/evidence/out/`](scripts/evidence/out/). Eleven were not. The two early reclaim attempts on the real 72-hour locks, the first hosted-demo smoke test's claim and both transactions of its 2026-10-17 re-run came from one-off scripts kept out of the repository because they read testnet keys. The first smoke test's lock, the device-wallet lock and claim, and the trustline, lock and claim of the 2026-10-19 recording were signed by hand in a browser (the recording's lock in Freighter). Every hash can still be checked on stellar.expert.

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
| Public repository | [https://github.com/omeralpi/pairy](https://github.com/omeralpi/pairy) | Public since 2026-10-17 |
| `lib/stellar/settlement.ts` (the settlement surface: the four stock SDK calls, assembled with `TransactionBuilder`) | [lib/stellar/settlement.ts](lib/stellar/settlement.ts) | Published |
| `lib/trade/state-machine.ts` (TradeStateMachine) | [lib/trade/state-machine.ts](lib/trade/state-machine.ts) | Published |
| Green CI run on the public repo | [CI run 39028728435](https://github.com/omeralpi/pairy/actions/runs/39028728435) (lint, typecheck, unit tests, both scope tests, build) and [testnet run 39028729204](https://github.com/omeralpi/pairy/actions/runs/39028729204) (XLM and USDC lock, claim, early reclaim rejected, reclaim after a 60-second window, op_no_trust) | Green on commit `a15c81d`, 2026-10-17 |

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
| Reclaim by the seller after the real 72 hours matured | [`4d2afb76…6963`](https://stellar.expert/explorer/testnet/tx/4d2afb7697587517bc2f3e5a78f705de8f0ff303786bcef15aacc97286ca6963) (2026-10-19 07:58:57 UTC; matured 2026-10-18 06:54:57 UTC) | [`dafe4fe1…6db0`](https://stellar.expert/explorer/testnet/tx/dafe4fe17dd82967d182471007c1e479ae97523d1204b0f76c5fae425d386db0) (2026-10-19 07:59:07 UTC; matured 2026-10-18 06:55:27 UTC) |

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
| Upstream issue (Trustless Work: optional on-chain deadline with a funder refund path) | [Trustless-Work/trustlesswork-smart-contract-stellar#132](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues/132) | Filed 2026-10-17, open |

---

## Deliverable 2: device-generated keys and the trade flow

Evidence type: transaction hash on stellar.expert, screen recordings, green CI runs.

| Item | What it shows | Link | Status |
|---|---|---|---|
| Transaction signed by a device-generated wallet | A testnet transaction signed by a key generated in the user's own browser by the device wallet, which sends Pairy only public keys and signatures | Lock [`c0c9e6c2…64c8`](https://stellar.expert/explorer/testnet/tx/c0c9e6c29dc15f6112afbc97fc2110f8bc1a37275ca0684ea649590805a164c8) and claim [`bc74206a…3d6b`](https://stellar.expert/explorer/testnet/tx/bc74206a5780adf6bbf35b24450ef53c548588014078c628e9db21a7b1223d6b), each signed in the browser by a device-generated wallet during a local end-to-end trade on 2026-10-15 (seller and buyer on two separate browser origins) | Done for device ↔ device |
| Export / re-import recording | A key exported from one browser, re-imported in a second browser profile, then used to sign a testnet transaction | Shared with the reviewer in the sprint closeout form (one uncut recording; the export is at 1:30 and the restore in a second browser, Safari, at 2:00) | Recorded 2026-10-19 |
| Re-imported key's signing transaction | The transaction signed in the second browser profile | [`7905c39e…0cc8`](https://stellar.expert/explorer/testnet/tx/7905c39ece28bca42e07aa01423ddb2549614456e41dd75e5b2a2baec6db0cc8): the restored key adds the testnet USDC trustline | Done, 2026-10-19 |
| Two-wallet-type end-to-end run: recording | Two test users, one on Freighter and one on a device-generated wallet, completing a trade end to end | Shared with the reviewer in the sprint closeout form (same recording, from 3:30: a Freighter seller in Chrome and the restored device wallet as buyer in Safari) | Recorded 2026-10-19 |
| Two-wallet-type end-to-end run: lock hash | The lock from that run | [`4f4b3670…869d`](https://stellar.expert/explorer/testnet/tx/4f4b36707e8975e86cf13ce95dbc9df275848d8f304f3db768839ae297be869d): 20 XLM signed in Freighter by the seller, buyer `rel_before 259200`, seller `not rel_before 259200` | Done, 2026-10-19 |
| Two-wallet-type end-to-end run: claim hash | The claim from that run | [`52128ae3…74e7`](https://stellar.expert/explorer/testnet/tx/52128ae34aa42b015ecac4d53f5c18d0579f1711fac48d7b5757d74fb94274e7): claimed by the device-generated wallet | Done, 2026-10-19 |
| CI test `no-secret-fields` (passing run) | Fails the build if any API endpoint ever accepts a secret key or a pincode | [CI run 39028728435](https://github.com/omeralpi/pairy/actions/runs/39028728435), step `no-secret-fields` | Passing ([tests/ci/no-secret-fields.test.ts](tests/ci/no-secret-fields.test.ts)) |
| CI test `coordination-purge-on-terminal` (passing run) | Asserts that a trade's chat messages are deleted once the trade is claimed, reclaimed or cancelled | [CI run 39028728435](https://github.com/omeralpi/pairy/actions/runs/39028728435), step `coordination-purge-on-terminal` | Passing ([tests/ci/coordination-purge-on-terminal.test.ts](tests/ci/coordination-purge-on-terminal.test.ts)) |

---

## Deliverable 3: map and hosted demo

Evidence type: live demo URL, public repo, walkthrough video.

| Item | What it shows | Link | Status |
|---|---|---|---|
| Live demo URL (testnet) | Listings on the map, at the city level each user chose | https://pairy.org | Live since 2026-10-15 UTC (also at https://pairy-seven.vercel.app). Smoke-tested end to end on the hosted demo: a seller using a device-generated wallet in the browser listed 1 to 20 XLM in Istanbul, a scripted buyer using the same public API and sign-in opened a 10 XLM trade, the seller agreed and locked [`e8a800ad…4151`](https://stellar.expert/explorer/testnet/tx/e8a800ad91e2121d5beb7f55172ca46af801ec36967a9e923a4853fa53634151) (buyer `rel_before 259200`, seller `not rel_before 259200`), the buyer claimed [`83087e00…4d9a`](https://stellar.expert/explorer/testnet/tx/83087e00e84c10e2cda251f632a26e013b612f7cb0bd5f2cd8b9e68c95a54d9a), the trade reached `claimed` and its chat went from 1 message to 0. Re-run on 2026-10-17 after redeploying commit `1336f27`, with a scripted seller and buyer on the public API: both signed in, listed, opened a 10 XLM trade, agreed, sent a chat message, locked [`397ef90a…84f8`](https://stellar.expert/explorer/testnet/tx/397ef90ac516e657a530e6a97e8b4a71e0398879c6b1d7694632196d183d84f8) (fee charged 100 stroops), claimed [`47c50f30…fcb7`](https://stellar.expert/explorer/testnet/tx/47c50f3083f1d3e12cd76557d146f2d120452d39a3308f95c49e10be19cefcb7), the trade reached `claimed`, its chat went from 1 message to 0, and the seller's cookie was refused after logout |
| Public repository | Source for everything above | [https://github.com/omeralpi/pairy](https://github.com/omeralpi/pairy) | Public since 2026-10-17 |
| 2-minute walkthrough video | The full flow, including the lock screen stating the buyer-claim bound | Shared with the reviewer in the sprint closeout form: one uncut recording of about 10 minutes instead of a 2-minute edit, so nothing is cut; the lock screen with the 72-hour sentence is at 7:10 and the lock on stellar.expert at 8:45 | Recorded 2026-10-19 |
| Settlement steps on stellar.expert | Every lock, claim and reclaim made in the demo, reachable through the links in Deliverable 1 and 2 | Hosted demo lock and claim in the row above; all others in Deliverable 1 | Partial |

---

## Reviewer checklist (SOW 6.2)

| Deliverable | Evidence present | Evidence partial | Evidence missing | Comments |
|---|---|---|---|---|
| Deliverable 1 | ☐ | ☐ | ☐ | |
| Deliverable 2 | ☐ | ☐ | ☐ | |
| Deliverable 3 | ☐ | ☐ | ☐ | |

---

## Month 2: Privy wallets, protected trades, remaining amounts and EURC

This section collects the evidence promised in section 6.1 of the statement of work for Pairy's second InstaWards month. Sprint day 1 is 2026-11-24 and day 30 is 2026-12-23. As in Phase 1, everything runs on Stellar testnet with test money only, and Pairy has no users.

**Status: draft of 2026-11-24 (UTC).** The month-2 code is committed but is not on GitHub or on pairy.org yet. It goes out in one release (push, database migration and deploy) once the owner approves it. The target is 2026-12-07, and the hard limit is the testnet reset on 2026-12-16 at 17:00 UTC. Until then, every hosted-app item, every GitHub CI link and every recording below says **not done yet**, with what will provide it and when. What exists today is on Stellar testnet: transactions made by the repo's scripts, and by the app running on a developer's machine (`localhost`) against testnet.

**How this section is ordered.**
1. One row per SOW 6.1 item, with its status.
2. The live links that the day-30 checks open (checks 2, 3 and 5). These are made again after the reset.
3. The key table, checked on testnet.
4. The dated gate record from before the reset, which proves the SOW's gate dates. Each of its transactions is also archived in [`scripts/evidence/archive/`](scripts/evidence/archive/), so it can still be checked after the reset.
5. A paragraph on the reset.

The full gate log is [`docs/phase2-gates.md`](docs/phase2-gates.md).

### Every SOW 6.1 item

| # | SOW 6.1 item | Status | Evidence, or what will provide it and when |
|---|---|---|---|
| 1 | Day-30 check 1: sign up on https://pairy.org with an email, in two browsers, and see the same wallet | Not done yet | Deliverable 1 reaches pairy.org with the release (target 2026-12-07) and is recorded in R1. Done on localhost with a Privy test account: the same email in two fresh browsers showed the same wallet, and the second browser signed a transaction ([Privy wallets](#privy-wallets-deliverable-1)). |
| 2 | Day-30 check 2: the three protected-trade exits, checked with the SOW's five steps | Done before the reset, by the repo's script. Live links after the reset: not done yet | Release, resolved to the buyer, resolved to the seller, each with the real arbiter as the only dispute resolver ([the three exits](#the-three-protected-trade-exits-deliverable-2)). They are made again after the reset, between 2026-12-16 and 2026-12-22 ([live links](#live-links-for-the-day-30-checks)). The in-app exits on pairy.org (R2, R3) come after the release, before 2026-12-16 17:00 UTC. |
| 3 | Day-30 check 3: the arbiter account's signers on stellar.expert | Done (checked 2026-11-24). The account after the reset: not done yet | [`GCAQSD3C…XCPH`](https://stellar.expert/explorer/testnet/account/GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH): two signers at weight 1, its own key at weight 0, thresholds 2/2/2 ([the arbiter account](#the-arbiter-account)). The reset deletes it; it is created again with the same two signer keys after 2026-12-16. |
| 4 | Day-30 check 4: a listing's "left" amount changes after a trade | Not done yet on pairy.org | Comes with the release, in R4 and its screenshots. Done on localhost: "100 of 100 USDC left", then "40 of 100" after a trade of 60 opened, then "100 of 100" again after it was cancelled ([remaining amount](#remaining-amount-and-the-concurrency-test-deliverable-3)). |
| 5 | Day-30 check 5: the EURC transactions | Done before the reset, except the matured 72-hour reclaim (not done yet) | Lock, claim, early reclaim rejected on chain, 60-second reclaim, and a real 72-hour lock ([EURC](#eurc-deliverable-3)). That lock matures on 2026-11-27 at 10:37:57 UTC and is reclaimed after that. All of it is made again after the reset. |
| 6 | Every item marked done or not done in EVIDENCE.md | Done | This table. |
| 7 | The key table of SOW section 3, checked against the testnet evidence | Done (checked 2026-11-24) | [Key table](#key-table-checked-on-testnet) |
| 8 | For every new CI check, a run made to fail on purpose on a throwaway branch, next to the green run | Not done yet on GitHub. Done locally | The throwaway branches are pushed with the release, and the GitHub links go here. Until then, a local run of every CI step on each branch: [CI checks](#ci-checks-green-and-deliberate-red-runs). |
| 9 | R1: email sign-up, a lock and claim signed through Privy, the same email signing again in a second browser, the exported key imported into Varial (formerly Freighter) | Not done yet | Recorded on pairy.org after the release ([recordings](#recordings)). |
| 10 | R2: a protected trade disputed from the flag dialog, both answers, both builders signing, the resolution in the trade room, the chat gone, a non-signer refused at pairy.org/arbiter | Not done yet | Recorded on pairy.org after the release, before 2026-12-16 17:00 UTC. |
| 11 | R3: a protected trade released by the seller | Not done yet | Recorded on pairy.org after the release, before 2026-12-16 17:00 UTC. |
| 12 | R4: a listing's "left" amount before and after a trade and after a cancel, and an EURC trade | Not done yet | Recorded on pairy.org after the release. |
| 13 | R5: the full walkthrough of the hosted app | Not done yet | Recorded on pairy.org after the release. |
| 14 | Deliverable 1: each signed transaction as a stellar.expert link | Partial | Ten transactions signed by a Privy wallet on localhost, listed under [Privy wallets](#privy-wallets-deliverable-1). Not done yet: a lock and a claim signed through Privy (the default trade), first on localhost before the release and then on pairy.org in R1. |
| 15 | Deliverable 1: a green run with the `no-privy-signers` step, and its deliberate failing run | Not done yet on GitHub. Done locally | [CI checks](#ci-checks-green-and-deliberate-red-runs) |
| 16 | Deliverable 1: a dated screenshot of the Privy dashboard showing no signers, authorization keys, key quorums or custom login | Not done yet | The owner takes the dated screenshots at the release, and they are linked here. A live screen-share is offered if the Chapter Lead asks. |
| 17 | Deliverable 1: export and social (Google) login | Not done yet. Pending the day-21 gate (due 2026-12-14), an owner step | Both need a person: a Google login, and importing an exported key into Varial. The export button and the README's note on using the exported key are in place. If either fails, it is marked not done here, with the reason, and Deliverable 1 ships with email login (the SOW's "Partial"). |
| 18 | Deliverable 1: under the day-10 fallback, each tested step's result, failing call and error | Not needed | Gate D1 passed on 2026-11-24 ([Privy wallets](#privy-wallets-deliverable-1)). |
| 19 | Deliverable 2: the arbiter account: two keys at weight 1, its own key at weight 0, thresholds 2/2/2 | Done (checked 2026-11-24) | [The arbiter account](#the-arbiter-account) |
| 20 | Deliverable 2: the locked platform account | Done (checked 2026-11-24) | [The locked platform account](#the-locked-platform-account) |
| 21 | Deliverable 2: for each exit, the escrow on Trustless Work's viewer with its roles, the creation transaction signed by that trade's own creation account, and the fund, dispute and exit transactions with their payments | Done before the reset, by the repo's script | [The three exits](#the-three-protected-trade-exits-deliverable-2) |
| 22 | Deliverable 2: the fee address recorded from the first scripted release, and every later exit paying the same address | Done | `GDDL743M…RCYF`, paid by the first scripted release on 2026-11-23 and pinned as `TW_FEE_ADDRESS` in [`lib/escrow/config.ts`](lib/escrow/config.ts). Each of the three exits paid it 0.015 USDC ([the fee address](#the-three-protected-trade-exits-deliverable-2)). |
| 23 | Deliverable 2: for a resolved trade, the timeline in EVIDENCE.md shows both answers | Not done yet | The two exits resolved so far were run by the script, so nobody answered ([answers](#answers-and-the-72-hour-promise)). The in-app exits on pairy.org (R2, after the release) have answers, and `scripts/ops/protected-report.ts` prints them for this file. |
| 24 | Deliverable 2: `docs/arbitration.md` with its first-commit date | Partial | First committed 2026-11-23 18:42:21 UTC, before the first escrow. Not on GitHub yet: it is published in the release push ([when the rule was published](#when-the-arbitration-rule-was-published)). |
| 25 | Deliverable 2: the dated Phase 2 section of `docs/settlement-rail-comparison.md`, with the state of issue #132 | Not done yet | Written in the documentation update that goes out with the release, dated, with the state of [issue #132](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar/issues/132) on that day. |
| 26 | Deliverable 2: green runs with `tw-endpoint-allowlist` and the extended `coordination-purge-on-terminal`, each with its deliberate failing run | Not done yet on GitHub. Done locally | [CI checks](#ci-checks-green-and-deliberate-red-runs) |
| 27 | Deliverable 2: what cannot be shown on chain, stated as such | Done | [What cannot be shown on chain](#what-cannot-be-shown-on-chain) |
| 28 | Deliverable 2: under the day-24 fallback, the three exits come from the repo's script, and EVIDENCE.md says so | Not decided yet (day-24 gate, due 2026-12-17) | Today the three exits are the script's. If in-app protected mode is live on pairy.org by day 24, R2, R3 and the exits made after the reset come from the app. If not, this row says the exits are the script's. |
| 29 | Deliverable 3: R4, and screenshots of a listing showing "40 of 100 USDC left" before and after a trade and after a cancel | Not done yet on pairy.org | Taken on pairy.org with R4 after the release. Done on localhost, without screenshots in the repository ([remaining amount](#remaining-amount-and-the-concurrency-test-deliverable-3)). |
| 30 | Deliverable 3: the concurrency test's failing run on the old code, and its green run | Not done yet on GitHub. Done locally | [Remaining amount and the concurrency test](#remaining-amount-and-the-concurrency-test-deliverable-3) |
| 31 | Deliverable 3: EURC lock, claim, early reclaim rejected on chain, 60-second reclaim and the matured 72-hour reclaim, each showing the issuer | Done before the reset, except the matured 72-hour reclaim (not done yet: it matures on 2026-11-27 at 10:37:57 UTC) | [EURC](#eurc-deliverable-3) |
| 32 | A missed 72-hour promise, reported here (`docs/arbitration.md`) | None so far | Two disputes were resolved well within 72 hours. Four test disputes are open; their 72 hours end on 2026-11-27 ([the 72-hour promise](#answers-and-the-72-hour-promise)). |

### Live links for the day-30 checks

Stellar testnet is reset on 2026-12-16 at 17:00 UTC, a week before day 30 ([the reset](#the-testnet-reset-of-2026-12-16)). So the day-30 checks that open testnet records (SOW 6.1 checks 2, 3 and 5) get new links, made after the reset. Until 2026-12-16 17:00 UTC, the pre-reset links in the gate record below still open.

| Day-30 check | Live link after the reset | Until 2026-12-16 17:00 UTC |
|---|---|---|
| 2. The three protected-trade exits | Not done yet. They are made again between 2026-12-16 and 2026-12-22. The plan is to run them on pairy.org, with team accounts trading and both builders signing at pairy.org/arbiter. Otherwise the repo's script runs them, again with both builders' signatures. If Trustless Work's escrow contracts are not back on testnet by 2026-12-20 17:00 UTC, they are not made again, and the pre-reset record stands, with that reason. | [The three exits](#the-three-protected-trade-exits-deliverable-2) |
| 3. The arbiter account | Not done yet. It is created again after the reset, with the same two signer keys. The new address goes here and into `docs/arbitration.md`. | [`GCAQSD3C…XCPH`](https://stellar.expert/explorer/testnet/account/GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH) |
| 5. The EURC transactions | Not done yet. Lock, claim, early reclaim rejected and 60-second reclaim, plus a new 72-hour lock opened by 2026-12-18 17:00 UTC and reclaimed when it matures, by 2026-12-22. If EURC is not back on testnet by 2026-12-18 17:00 UTC, the 72-hour lock is not repeated, and this row says so. | [EURC](#eurc-deliverable-3) |
| 1 and 4 (pairy.org sign-up and "left" amounts) | These are checked on pairy.org itself. A lock and claim signed through Privy is made again after the reset. | Not done yet: comes with the release |

### Key table, checked on testnet

This is the key table of SOW section 3, extended with the accounts Pairy's test runs use. Every account that exists on chain was read from Horizon (`horizon-testnet.stellar.org`) on 2026-11-24 at 22:19 UTC; the last column says what was checked and what was found. Pairy's server holds no Stellar signing key in any outcome.

| Key or account | Who holds it | What it can do | What it cannot do | Checked on testnet on 2026-11-24 |
|---|---|---|---|---|
| Device wallet key (existing) | The user's browser, encrypted under the user's pincode ([`lib/wallet/device-wallet.ts`](lib/wallet/device-wallet.ts)) | Sign for that user | Reach Pairy's server: no API field accepts a secret key (CI test `no-secret-fields`) | Nothing to check on chain: a device-wallet account looks like any other account. |
| Varial (formerly Freighter) key (existing) | The user's Varial browser extension | Sign for that user | Reach Pairy's server | Nothing to check on chain. |
| Privy wallet key (new, Deliverable 1) | Privy. According to Privy, the key is split into two shares and put together only inside Privy's sealed enclave while signing, for the user's logged-in session ([Privy security FAQ](https://docs.privy.io/security/security-faqs)) | Sign for that user; be exported by that user | Be used by Pairy: Pairy holds only Privy's public App ID, no Privy secret, and enables none of Privy's features that let an app sign (CI test `no-privy-signers`). Whoever controls the user's email or Google account controls this wallet | The Privy test wallet [`GDOL5A7S…IKFA`](https://stellar.expert/explorer/testnet/account/GDOL5A7SX44JXOSLAJG7YK2X7H6BZI3RONWK5TN3FIY7W65S4XJ3IKFA): one signer, its own key at weight 1, nothing else. How Privy keeps that key cannot be seen on chain. |
| Privy App ID | Public, in the browser bundle | Identify Pairy's Privy app | Sign anything: it is not a key | Not on chain. |
| Escrow creation key (new, Deliverable 2), one per protected trade | The seller's browser memory, only while the escrow is created; never sent to Pairy, and dropped once the creation is recorded ([`lib/escrow/creation-key.ts`](lib/escrow/creation-key.ts)) | Sign the creation of that one escrow, as its "admin". In theory, change that escrow's terms before funding, or add a step after funding that the seller alone approves; Pairy asks for neither, and the key is gone | Move, redirect or settle funds; change roles, amount or fee once funded; open a dispute; act on any other trade | Each exit's creation transaction has that trade's creation account as its source and only signer: [`GCITNS4V…5BH5`](https://stellar.expert/explorer/testnet/account/GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5) (release), [`GDVA7ZVY…UZZV`](https://stellar.expert/explorer/testnet/account/GDVA7ZVY2NOKJQXG554NRZSMH2ITWASUGPOLHHZICV4PM7ONCORWUZZV) (to the buyer), [`GDSEUECI…HJ6K`](https://stellar.expert/explorer/testnet/account/GDSEUECIT7XDOH7A7VOAB3LP3RIC2BL24ZBFEZZCL24UBQZH6K2DHJ6K) (to the seller). Each has exactly two transactions: its Friendbot funding and the creation. It still holds its Friendbot XLM, with its own key at weight 1 and nothing else. That the key was dropped cannot be shown on chain. |
| `SESSION_SECRET` (existing) | Pairy's server | Sign Pairy's login cookies | Sign any Stellar transaction; it is not a Stellar key | Not on chain. |
| `CRON_SECRET` (existing) | Pairy's server and the hosting provider's daily scheduler | Start the daily clean-up job | Sign any Stellar transaction | Not on chain. |
| Trustless Work API key, production (new, Deliverable 2) | Pairy's server, in the hosting provider's production settings only. It is created at the release | Ask Trustless Work to prepare unsigned escrow transactions | Sign or move anything; Trustless Work never signs | Not on chain. |
| Trustless Work API key, development (new) | The team's development machine and the hosting provider's preview settings; never GitHub Actions, where CI uses recorded answers | The same, for test runs | The same | Not on chain. |
| Platform account (new, Deliverable 2) | Nobody: its own key is switched off | Receive a platform fee, which is set to 0 | Sign anything, so nobody can use its right to open a dispute | [`GAHSTUWN…ISFW`](https://stellar.expert/explorer/testnet/account/GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW): its only signer is its own key at weight 0. It has a USDC trustline holding 0 USDC, and nothing has happened since its setup ([below](#the-locked-platform-account)). |
| Platform setup key | Existed in memory for one run of [`scripts/ops/setup-platform.ts`](scripts/ops/setup-platform.ts) | Nothing now: it is the account's own key, at weight 0 | Sign anything | As above: weight 0. |
| Arbiter account (new, Deliverable 2) | Ömer Alpi and Ensar Mert Günay together: both signatures are needed, each made in Varial on the builder's own computer, never on Pairy's server | Only after the buyer or the seller opens a dispute on a protected trade: send the whole escrowed amount, less 0.3%, to any address. After a release or a resolution: sweep any leftover later sent to that escrow. Pairy's arbiter page offers only the rule's outcome, and never the sweep | Open a dispute; touch an undisputed protected trade's funds; touch any default (claimable-balance) trade. If either builder's key is lost, disputed protected trades cannot be resolved, and their USDC stays in the escrow; there is deliberately no one-person recovery key | [`GCAQSD3C…XCPH`](https://stellar.expert/explorer/testnet/account/GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH): signers `GDRJ7JMJ…LD5Q` and `GDH2MGKJ…N6J7` at weight 1, its own key at weight 0, thresholds 2/2/2, no home domain. Since its setup, two transactions have been made from it, the two resolves below, each with exactly two signatures ([below](#the-arbiter-account)). |
| Arbiter signer keys (two this month) | Each in its builder's own Varial, on their own computer: Ömer Alpi `GDRJ7JMJ…LD5Q`, Ensar Mert Günay `GDH2MGKJ…N6J7`. Dedicated: never used to trade | Co-sign as the arbiter (weight 1 each); sign in to pairy.org/arbiter | Sign anything alone; be a party to a protected trade (Pairy refuses it) | Neither key has an account of its own on testnet (Horizon answers 404): each exists only as a signer of the arbiter account. Where they are kept cannot be shown on chain. |
| Arbiter master key | Existed in memory for one run of [`scripts/ops/setup-arbiter.ts`](scripts/ops/setup-arbiter.ts) | Nothing now: weight 0 | Sign anything | As above: weight 0. |
| A single arbiter signature on a prepared resolution | Pairy's server, while the second signature is collected | Nothing alone: it is below the threshold | Move funds | On the day-12 gate, each builder's signature sent alone was refused by the network (`tx_bad_auth`; [below](#the-three-protected-trade-exits-deliverable-2)). |
| Test 2-of-2 arbiter (test runs only) | A script-made account. Both its signer keys are in `scripts/evidence/.state/` on the team's development machine, kept out of git | Resolve team-funded test escrows in repeated script runs | Be Pairy's arbiter account; be offered to a user | [`GCTEI2CN…QBUG`](https://stellar.expert/explorer/testnet/account/GCTEI2CN7HTVEJAFYLUQDIM5JOOC5SG5RGHUOCYBMG6C45FWZA2QQBUG): two signers at weight 1 (`GDDKCD…5DSO`, `GDGCHZ…45EQ`), its own key at weight 0, thresholds 2/2/2. |
| Team test accounts | `scripts/evidence/.state/` on the team's development machine | Sign team test transactions with team test money | Touch a user's funds | For example the EURC treasury [`GBNSEA54…LZBB`](https://stellar.expert/explorer/testnet/account/GBNSEA54V6EOBZZOHVC5HSDGHAZDEVJ3YVVB3QHLCQ2EVGZXMUUQLZBB): one signer at weight 1, 14 EURC. |
| Trustless Work's fee address | Trustless Work | Receive 0.3% of every exit | Act on an escrow: it has no role in one | [`GDDL743M…RCYF`](https://stellar.expert/explorer/testnet/account/GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF): pinned as `TW_FEE_ADDRESS`; it received 0.015 USDC in each of the three exits. |
| Fallback resolver and fallback euro token (`TEUR`) | Not created | Nothing | Anything | Not needed: the two-signature arbiter was accepted by Trustless Work, and Circle's faucet supplied EURC. |

### The arbiter account

[`GCAQSD3C…XCPH`](https://stellar.expert/explorer/testnet/account/GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH) ([archived account record](scripts/evidence/archive/account-GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH.json))

- **What stellar.expert shows.** Under **Signers**: `GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q` (Ömer Alpi) and `GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7` (Ensar Mert Günay), each with weight 1, and the account's own key with weight 0. Under **Thresholds**: 2 for low, medium and high. So one key alone can sign nothing.
- **Read from Horizon on 2026-11-24 at 22:19 UTC.** Exactly these three signers, and no home domain. Its history has six operations:
  - its creation by Friendbot, [`3c524473…acf7`](https://stellar.expert/explorer/testnet/tx/3c524473f55451e4bf95c82232a4c552af8767bcfd5d4a0cd35bd1dec0a8acf7) (to be archived on 2026-12-15);
  - the three settings of its setup transaction, [`3dfce09c…5bd8`](https://stellar.expert/explorer/testnet/tx/3dfce09cfba34eb32679fd64f7a91fb5ba16575ccbdbabbde7417ba3b4aa5bd8) ([archive](scripts/evidence/archive/3dfce09cfba34eb32679fd64f7a91fb5ba16575ccbdbabbde7417ba3b4aa5bd8.json)) (2026-11-23 19:34:47 UTC);
  - the two resolves of the day-12 gate, each carrying exactly two signatures, one from each builder's key.
- **One key alone is refused.** On each of those resolves, each builder's signature was first sent alone. The network refused it with `tx_bad_auth`: no fee, no ledger, and so nothing on stellar.expert. Both refusals per resolve, with their envelopes and result codes, are in the run records: [to the buyer](scripts/evidence/out/escrow-dispute-buyer-real.json) and [to the seller](scripts/evidence/out/escrow-dispute-seller-real.json).

### The locked platform account

[`GAHSTUWN…ISFW`](https://stellar.expert/explorer/testnet/account/GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW) ([archived account record](scripts/evidence/archive/account-GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW.json))

- **What stellar.expert shows.** Under **Signers**, only its own key, with weight 0, so nothing can sign for it.
- **Read from Horizon on 2026-11-24 at 22:19 UTC.** That one signer, and a USDC trustline holding 0 USDC. Its history has three operations:
  - its creation by Friendbot, [`1758f559…5b30`](https://stellar.expert/explorer/testnet/tx/1758f5594571d33e5a13ea6362692e39ffb7b12333beee9502e05c1ca43b5b30) (to be archived on 2026-12-15);
  - the USDC trustline and the weight 0, in one transaction: [`c8dcfad4…a9f8`](https://stellar.expert/explorer/testnet/tx/c8dcfad48bcb13679990b72228111697410b5511ed6970f4c1a187e7310ea9f8) ([archive](scripts/evidence/archive/c8dcfad48bcb13679990b72228111697410b5511ed6970f4c1a187e7310ea9f8.json)) (2026-11-23 19:32:07 UTC).
- **In the exits.** Every escrow names it as the platform, with a fee of 0, and it received nothing in any of the exits.

### Gate record before the reset

These are the dated runs from before the reset. Each transaction links to stellar.expert, which shows it until 2026-12-16 17:00 UTC. Each also links to its archived Horizon record, `scripts/evidence/archive/<hash>.json`, which holds the signed envelope, the result and the operations and stays checkable after the reset. A transaction marked "to be archived on 2026-12-15" is not in the archive yet. The last run before the reset, on 2026-12-15, adds it, because that run archives every stellar.expert link in this file. Every hash in this section was read back from Horizon on 2026-11-24, by 22:19 UTC.

#### Privy wallets (Deliverable 1)

**Gate D1 passed on 2026-11-24**, on localhost, with a Privy test account (email login).
- **The wallet.** Privy's `createWallet` made the Stellar wallet [`GDOL5A7S…IKFA`](https://stellar.expert/explorer/testnet/account/GDOL5A7SX44JXOSLAJG7YK2X7H6BZI3RONWK5TN3FIY7W65S4XJ3IKFA) ([archived account record](scripts/evidence/archive/account-GDOL5A7SX44JXOSLAJG7YK2X7H6BZI3RONWK5TN3FIY7W65S4XJ3IKFA.json)), and Friendbot funded it.
- **How each transaction below was signed.** It was built in the browser and shown in Pairy's own confirm dialog. Privy then signed its hash, and the browser submitted it to Horizon. Privy showed no prompt of its own.
- **What Horizon shows.** Each transaction has this wallet as its source and exactly one signature, from the wallet's key.

| When (UTC) | Run | What was signed | Transaction |
|---|---|---|---|
| 2026-11-24 08:58 | Gate D1, first browser | A 1 XLM payment | [`53a00e96…4371`](https://stellar.expert/explorer/testnet/tx/53a00e9646e6e1f320e2bb2664600b895178d257f73ea2a551165114880f4371) ([archive](scripts/evidence/archive/53a00e9646e6e1f320e2bb2664600b895178d257f73ea2a551165114880f4371.json)) |
| 2026-11-24 10:06 | The wallet page | The USDC trustline | [`ceb821f6…9767`](https://stellar.expert/explorer/testnet/tx/ceb821f6de4fe2e7508bcc6a74fa766d8b0ef203fd3dc0b22baf879d8e669767) ([archive](scripts/evidence/archive/ceb821f6de4fe2e7508bcc6a74fa766d8b0ef203fd3dc0b22baf879d8e669767.json)) |
| 2026-11-24 10:07 | A protected escrow, signed through Pairy's wallet code (spike S-06) | Fund 5 USDC | [`c8a6f25a…73d6`](https://stellar.expert/explorer/testnet/tx/c8a6f25a65bd45f20c8a9f1f51691b8952fb8ef9e848b54760e05733eed073d6) ([archive](scripts/evidence/archive/c8a6f25a65bd45f20c8a9f1f51691b8952fb8ef9e848b54760e05733eed073d6.json)) |
| 2026-11-24 10:08 | The same escrow | Release it: 4.985 USDC to the buyer, 0.015 to Trustless Work's fee address | [`0d92c195…ff9d`](https://stellar.expert/explorer/testnet/tx/0d92c195930960ed374d72a280bbe4a930a1e440b4fe33506ab01b19d74cff9d) ([archive](scripts/evidence/archive/0d92c195930960ed374d72a280bbe4a930a1e440b4fe33506ab01b19d74cff9d.json)) |
| 2026-11-24 14:29 | **A second fresh browser, same email** | The EURC trustline | [`3c869e57…b42e`](https://stellar.expert/explorer/testnet/tx/3c869e5786c06ceb1de30cc2fe73c269a80f32aff80674150535fdad073bb42e) (to be archived on 2026-12-15) |
| 2026-11-24 15:38 | A protected trade in the trade room, Privy seller | Fund 1 USDC, then release | [`cf690217…8d33`](https://stellar.expert/explorer/testnet/tx/cf6902179043b4043e97bea5527646423f4f6aeda14a51c60e19f86e8bce8d33) (to be archived on 2026-12-15), [`69bac2e3…79cf`](https://stellar.expert/explorer/testnet/tx/69bac2e3862b2812bb10b1ae389fce8281f545cd8c244e9a34dc1c3e309979cf) (to be archived on 2026-12-15) |
| 2026-11-24 17:05 | A protected trade, Privy buyer | Open a dispute | [`fd5bb2ca…54c4`](https://stellar.expert/explorer/testnet/tx/fd5bb2ca6f0b99d72da15a2baf030da5b806e85197d40ae3506f5678b67f54c4) (to be archived on 2026-12-15) |
| 2026-11-24 19:59 | A protected trade in the built app, Privy seller | Fund 1 USDC, then release | [`76174344…f6ca`](https://stellar.expert/explorer/testnet/tx/7617434443eced479df86b6dd7e7f04076801dcdcd397a01b0b40d782a9cf6ca) (to be archived on 2026-12-15), [`03444981…6635`](https://stellar.expert/explorer/testnet/tx/034449819e2812186b8129c020f057876408cbecc37e5abc63d0891af51c6635) (to be archived on 2026-12-15) |

Other parts of Deliverable 1:
- **SEP-53 sign-in through Privy.** Accepted by the unchanged `auth.verify` from two fresh browser profiles. It is a signed message, not a transaction, so it is not on chain ([`docs/phase2-gates.md`](docs/phase2-gates.md), S-03).
- **The same wallet in a second browser.** A second fresh browser, logged in with the same email, showed the same address and created no new wallet (S-04). A later rehearsal on the real onboarding and wallet pages did the same, and its second browser signed the EURC trustline above.
- **Export, then import into Varial (formerly Freighter).** Not done yet. It is the day-21 gate (due 2026-12-14), an owner step.
- **Google login.** Not done yet. It is the same day-21 gate, an owner step.
- **A lock and claim signed through Privy, in the default trade.** Not done yet. It is done on localhost before the release, then on pairy.org in R1.
- **Live on pairy.org** (day-14 gate, due 2026-12-07). Not done yet: it comes with the release.

#### The three protected-trade exits (Deliverable 2)

Gate D2 (the release) and the day-12 gate (the two resolutions) passed on 2026-11-24. How the exits were run:
- **The script.** `scripts/evidence/escrow-exits.ts` ran each exit on a 5 USDC escrow between throwaway traders.
- **The resolver.** The real arbiter account was each escrow's only dispute resolver.
- **The transactions.** Trustless Work prepared every transaction. Pairy checked each one before it was signed, sent it straight to Horizon and read it back.
- **The resolutions.** Each was signed by Ömer Alpi and Ensar Mert Günay, on their own computers ([what cannot be shown on chain](#what-cannot-be-shown-on-chain)).

| | Release (Gate D2) | Resolved to the buyer (day-12 gate) | Resolved to the seller (day-12 gate) |
|---|---|---|---|
| Escrow on Trustless Work's viewer | [`CDQOPLC2…QO34`](https://viewer.trustlesswork.com/testnet/v2/CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34) | [`CCYX2DAO…G6M2`](https://viewer.trustlesswork.com/testnet/v2/CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2) | [`CBHHSX7Z…NHNR`](https://viewer.trustlesswork.com/testnet/v2/CBHHSX7ZAVL4IXJZBEYVZVDWLZNZYCN46Y54THMJDWIGUSMABFYCNHNR) |
| Archived escrow and dated viewer screenshot | [escrow](scripts/evidence/archive/escrow-CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34.json), [screenshot](scripts/evidence/archive/2026-11-24-viewer-CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34.png) | [escrow](scripts/evidence/archive/escrow-CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2.json), [screenshot](scripts/evidence/archive/2026-11-24-viewer-CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2.png) | [escrow](scripts/evidence/archive/escrow-CBHHSX7ZAVL4IXJZBEYVZVDWLZNZYCN46Y54THMJDWIGUSMABFYCNHNR.json), [screenshot](scripts/evidence/archive/2026-11-24-viewer-CBHHSX7ZAVL4IXJZBEYVZVDWLZNZYCN46Y54THMJDWIGUSMABFYCNHNR.png) |
| Seller (approver, service provider and release signer) | `GA7GKEVE…AP5Y` | `GC3O5JDN…JIWD` | `GDEPA3WO…VKIE` |
| Buyer (receiver) | `GB2HNRJN…ZOYQ` | `GCZ2Z5HU…UVBZ` | `GDFAL3KN…OHYT` |
| Creation, signed only by that trade's creation account (also the escrow's admin) | `GCITNS4V…5BH5`: [`86ff390a…385f`](https://stellar.expert/explorer/testnet/tx/86ff390a60fbaade36e9704638542e1a263aa1be508d39d8fbd35bc18e45385f) ([archive](scripts/evidence/archive/86ff390a60fbaade36e9704638542e1a263aa1be508d39d8fbd35bc18e45385f.json)) | `GDVA7ZVY…UZZV`: [`0532761c…5415`](https://stellar.expert/explorer/testnet/tx/0532761c8527acdeba051c2374b2fd8ae694dea0593b6d8f0df39ae945005415) ([archive](scripts/evidence/archive/0532761c8527acdeba051c2374b2fd8ae694dea0593b6d8f0df39ae945005415.json)) | `GDSEUECI…HJ6K`: [`84dd564c…3124`](https://stellar.expert/explorer/testnet/tx/84dd564c26d1e77ddd409c4a178996583fe83ce7c1109fc1028351e96d933124) ([archive](scripts/evidence/archive/84dd564c26d1e77ddd409c4a178996583fe83ce7c1109fc1028351e96d933124.json)) |
| Fund: 5 USDC from the seller into the escrow | [`46461cc7…09b1`](https://stellar.expert/explorer/testnet/tx/46461cc7229e8d86779bb4bc62af47091a078931489157253a5904515d5409b1) ([archive](scripts/evidence/archive/46461cc7229e8d86779bb4bc62af47091a078931489157253a5904515d5409b1.json)) | [`042c9fbe…d3fe`](https://stellar.expert/explorer/testnet/tx/042c9fbe16981e254df17f9ce075536faac8f23d91c2304d43345f3f274bd3fe) ([archive](scripts/evidence/archive/042c9fbe16981e254df17f9ce075536faac8f23d91c2304d43345f3f274bd3fe.json)) | [`142dfc7c…22de`](https://stellar.expert/explorer/testnet/tx/142dfc7c4f1145bef58b860169fc27ddba0828c1909e1c499691b6b35eee22de) ([archive](scripts/evidence/archive/142dfc7c4f1145bef58b860169fc27ddba0828c1909e1c499691b6b35eee22de.json)) |
| Dispute | None | By the buyer: [`cd6251a5…0b85`](https://stellar.expert/explorer/testnet/tx/cd6251a524b9d3030a6ce2185b004de5052b417ebaf0834bcb528fb93dd10b85) ([archive](scripts/evidence/archive/cd6251a524b9d3030a6ce2185b004de5052b417ebaf0834bcb528fb93dd10b85.json)) | By the seller: [`3263df17…6986`](https://stellar.expert/explorer/testnet/tx/3263df17cc12646e4c564936c5263381e5d6570b316deba93ab578aad6586986) ([archive](scripts/evidence/archive/3263df17cc12646e4c564936c5263381e5d6570b316deba93ab578aad6586986.json)) |
| Exit | Release, signed by the seller alone: [`e1f99bd5…7bf6`](https://stellar.expert/explorer/testnet/tx/e1f99bd51a4cd6c490386233944605c3412f20a78f59d87c655a4b20b06a7bf6) ([archive](scripts/evidence/archive/e1f99bd51a4cd6c490386233944605c3412f20a78f59d87c655a4b20b06a7bf6.json)) | Resolve, signed by both arbiter keys: [`ce561da5…588b`](https://stellar.expert/explorer/testnet/tx/ce561da57cec08f3b2b249e175b357a991ce7c9604eccb119a6a303bbd52588b) ([archive](scripts/evidence/archive/ce561da57cec08f3b2b249e175b357a991ce7c9604eccb119a6a303bbd52588b.json)) | Resolve, signed by both arbiter keys: [`9f63a1a8…43b8`](https://stellar.expert/explorer/testnet/tx/9f63a1a8005a81a2a4c8aec550afc4635a2673dd02e9712b2bfb64a8f9bc43b8) ([archive](scripts/evidence/archive/9f63a1a8005a81a2a4c8aec550afc4635a2673dd02e9712b2bfb64a8f9bc43b8.json)) |
| Who received how much | Buyer 4.985 USDC; `GDDL743M…RCYF` 0.015; platform 0 | Buyer 4.985 USDC; `GDDL743M…RCYF` 0.015; platform 0 | Seller 4.985 USDC; `GDDL743M…RCYF` 0.015; platform 0 |
| Dispute to exit | No dispute | 30 min 50 s | 1 h 4 min 50 s |
| Run record | [escrow-release-real.json](scripts/evidence/out/escrow-release-real.json) | [escrow-dispute-buyer-real.json](scripts/evidence/out/escrow-dispute-buyer-real.json) | [escrow-dispute-seller-real.json](scripts/evidence/out/escrow-dispute-seller-real.json) |

The roles in each escrow, as read back from the chain after the creation:
- the seller is approver, service provider and release signer;
- the buyer is the receiver;
- the platform account is the platform, at fee 0;
- the arbiter account is the only dispute resolver;
- the creation account is the admin;
- there are no observers.

Dated screenshots of the three exits' stellar.expert pages are archived too: [release](scripts/evidence/archive/2026-11-24-tx-e1f99bd51a4cd6c490386233944605c3412f20a78f59d87c655a4b20b06a7bf6.png), [to the buyer](scripts/evidence/archive/2026-11-24-tx-ce561da57cec08f3b2b249e175b357a991ce7c9604eccb119a6a303bbd52588b.png), [to the seller](scripts/evidence/archive/2026-11-24-tx-9f63a1a8005a81a2a4c8aec550afc4635a2673dd02e9712b2bfb64a8f9bc43b8.png).

- **The fee address.** `GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF` is the address Trustless Work filled in for the first scripted release: [`a7e180f3…88ef`](https://stellar.expert/explorer/testnet/tx/a7e180f33e9f43cc3f956bd3f5eab05969bbfff73acf976a4cf077c9fcc688ef) ([archive](scripts/evidence/archive/a7e180f33e9f43cc3f956bd3f5eab05969bbfff73acf976a4cf077c9fcc688ef.json)) (2026-11-23, 0.03 USDC of 10, on a spike escrow). It is pinned as `TW_FEE_ADDRESS` in [`lib/escrow/config.ts`](lib/escrow/config.ts). All three exits paid that same address. Pairy refuses to sign or to record a release or a resolve that names any other fee address.
- **The creation accounts.** Each was made by Friendbot for that one creation and has made no other transaction. Its key was made in memory by `makeCreationKey()`, the module the browser uses, and then dropped. The drop is not visible on chain.
- **Signing in Stellar Lab.** The two builders signed each resolve in Stellar Lab with Varial (formerly Freighter). Lab re-simulates an unsigned Soroban transaction, which changes its fee and its hash. So the copy handed to them carried one extra signature, from a throwaway key that is not a signer, which makes Lab skip that step. That signature was removed before the two arbiter signatures were merged, and each landed resolve carries only those two.
- **The seller exit's second attempt.** Pairy re-times each prepared resolve to stay valid for 60 minutes. In the seller exit, the first prepared resolve expired 13 seconds before the second signature arrived. The script prepared it again, and nothing was stranded.

#### Answers and the 72-hour promise

`docs/arbitration.md` promises that the arbiter applies the outcome within 72 hours of the dispute transaction, and that a missed promise is reported here.

**The two resolved exits have no answers.** They were run by the repo's script, not by two traders in the app, so nobody answered "Was the cash handed over in full?". The script resolved each one to the side its exit names. Answers come with the in-app exits on pairy.org (R2, after the release). `scripts/ops/protected-report.ts` prints them with each trade's timeline for this file: not done yet.

Every dispute so far on an escrow that names the real arbiter:

| Escrow | Dispute (ledger time, UTC) | Answers | The rule gives | 72 hours end (UTC) | At 22:19 UTC on 2026-11-24 |
|---|---|---|---|---|---|
| [`CCYX2DAO…G6M2`](https://viewer.trustlesswork.com/testnet/v2/CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2) (exit to the buyer) | 2026-11-24 09:56:07, by the buyer | None: scripted | Not applied: no answers | 2026-11-27 09:56:07 | Kept: resolved to the buyer after 30 min 50 s |
| [`CBHHSX7Z…NHNR`](https://viewer.trustlesswork.com/testnet/v2/CBHHSX7ZAVL4IXJZBEYVZVDWLZNZYCN46Y54THMJDWIGUSMABFYCNHNR) (exit to the seller) | 2026-11-24 10:28:02, by the seller | None: scripted | Not applied: no answers | 2026-11-27 10:28:02 | Kept: resolved to the seller after 1 h 4 min 50 s |
| [`CDPCKAUF…E3UW`](https://viewer.trustlesswork.com/testnet/v2/CDPCKAUFKLQS6GITK2XCBHGGZM6EGZ7YQXI3JGDHXXFPLX5V6YDQE3UW) (2 USDC) | 2026-11-24 13:16:32, by the buyer: [`341932d0…b5b0`](https://stellar.expert/explorer/testnet/tx/341932d059c3ef2360ca4db2668e2bee14af4d2680657635c15448bb16f3b5b0) ([archive](scripts/evidence/archive/341932d059c3ef2360ca4db2668e2bee14af4d2680657635c15448bb16f3b5b0.json)) | Seller no, buyer yes | All back to the seller (rule 3) | 2026-11-27 13:16:32 | Open |
| [`CBR6V62I…I5OC`](https://viewer.trustlesswork.com/testnet/v2/CBR6V62IHRTKHE2ZMRBFXPAYJ47IYAEFZO2WS5SPGDRACXBIGNBFI5OC) (1 USDC) | 2026-11-24 16:37:17, by the buyer: [`f91e1d7d…4fb6`](https://stellar.expert/explorer/testnet/tx/f91e1d7de889042aed9655f24a31c3bf1843437d3f1fb4ef3e64ebc21ffa4fb6) (to be archived on 2026-12-15) | Buyer yes, seller no | All back to the seller (rule 3) | 2026-11-27 16:37:17 | Open |
| [`CDU6BFSM…SEXL`](https://viewer.trustlesswork.com/testnet/v2/CDU6BFSMRYN3G6JFFZIAXUD7LNVQN46ACP6GQ5MALKNNHSMFTOMPSEXL) (1 USDC) | 2026-11-24 17:05:27, by the buyer, signed through Privy: [`fd5bb2ca…54c4`](https://stellar.expert/explorer/testnet/tx/fd5bb2ca6f0b99d72da15a2baf030da5b806e85197d40ae3506f5678b67f54c4) (to be archived on 2026-12-15) | None given | All back to the seller (rule 3), once the 24-hour window closed | 2026-11-27 17:05:27 | Open |
| [`CD7VRCAJ…K6LU`](https://viewer.trustlesswork.com/testnet/v2/CD7VRCAJIOPGX7LIV5YRTH7VCWOZD4GEE7N3QHONU6HY23SYAZWXK6LU) (1 USDC) | 2026-11-24 20:01:47, by the buyer: [`c2f6eb29…dfc3`](https://stellar.expert/explorer/testnet/tx/c2f6eb295ce5a1e507ce8a1e7b37b2109c53f0d59508ec2b48730435f9dcdfc3) (to be archived on 2026-12-15) | Seller yes, buyer yes | All to the buyer (rule 1) | 2026-11-27 20:01:47 | Open |

The last four rows are test trades:
- **What they are.** The team opened them in the app on localhost, against testnet, to check the dispute and answer screens. Each escrow holds test USDC and names the real arbiter as its only resolver.
- **The answers.** They were given in the local trade room and are not on chain.
- **The arbiter's part so far.** The arbiter has signed nothing for them: its only transactions are the two resolves above.
- **If 72 hours pass.** A dispute still unresolved when its 72 hours end is listed here as a missed promise, with the reason. The 2026-12-16 reset deletes any that are left, and that is stated too.

#### When the arbitration rule was published

- **First commit.** `docs/arbitration.md` was first committed on 2026-11-23 at 18:42:21 UTC (commit `2818a08`), with the rule and the acceptance text.
- **Later commits.** Two commits that evening only filled in the platform and arbiter account lines (`0056fa7`, `3002314`). The rule and the acceptance text have not changed since.
- **The first escrow.** The first escrow any Pairy script deployed came 25 minutes after the first commit: [`e7c74f4c…06e3`](https://stellar.expert/explorer/testnet/tx/e7c74f4cc3575e787e128268eccf306d7c90a90e42ee69fa76dfc673cb1f06e3) ([archive](scripts/evidence/archive/e7c74f4cc3575e787e128268eccf306d7c90a90e42ee69fa76dfc673cb1f06e3.json)) (2026-11-23 19:07:52 UTC, a spike escrow with throwaway roles).

**Not on GitHub yet.** The commit date is not the publication date. The file reaches GitHub in the release push, so the scripted test exits of 2026-11-23 and 2026-11-24 came before the rule was public. No protected trade is offered to anyone on pairy.org before that push. The push date goes here: not done yet.

#### Remaining amount and the concurrency test (Deliverable 3)

**"40 of 100 USDC left", on localhost (2026-11-24).**
- A fresh listing, "Selling 10 to 100 USDC", showed "100 of 100 USDC left".
- After a trade of 60 opened, it showed "40 of 100 USDC left" on the listing page, in My listings and on the map card. An open of 50 was then refused with "Only 40 USDC left on this listing. Enter 10 to 40."
- After that trade was cancelled, it showed "100 of 100 USDC left" again.

This was a local run, so its screenshots are not in the repository. The screenshots from pairy.org are taken with R4 after the release: not done yet.

**In the built app, on localhost (2026-11-24).**
- A listing of 1 to 2.5 USDC showed "2.5 of 2.5 USDC left".
- After a protected trade of 1, it showed "1.5 of 2.5 USDC left".
- After a second trade, it showed "0.5 of 2.5 USDC left · Not taking new trades until an open trade on it is cancelled." My listings said "Hidden from the map: less than the minimum is left." ([local runs](#local-runs-of-the-app))

**The concurrency test.** Two tests check it:
- [`tests/ci/listing-reservation-concurrency.test.ts`](tests/ci/listing-reservation-concurrency.test.ts), on the in-process Postgres used by the unit tests;
- [`tests/pg/listing-reservation.pg.test.ts`](tests/pg/listing-reservation.pg.test.ts), on a real Postgres 16 with ten buyers at once.

Each opens trades of 60 XLM on a listing of 100 XLM at the same moment and requires exactly one to succeed.
- **Red on the old code.** The old code is `72800bb`, kept with the tests on the throwaway branch `red/listing-reservation` (commit `d43041b`). There both tests fail: "2 fulfilled, expected 1", and "10 fulfilled, expected 1". In the real-Postgres test all ten trades were accepted: 600 XLM of trades on a 100 XLM listing.
- **Green.** Both pass since `38b5357`, which keeps the remaining amount under the listing's row lock.
- **GitHub runs.** The red and green runs come with the release push: not done yet.

#### EURC (Deliverable 3)

**The asset.** EURC is the third asset: Circle's testnet EURC, issuer `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` ([`GB3Q6QDZ…ZTVO`](https://stellar.expert/explorer/testnet/account/GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO), home domain circle.com, read 2026-11-24).

**The source.** Circle's faucet paid 20 EURC to the team treasury `GBNSEA54…LZBB` on 2026-11-23: [`cb8bdc9b…7163`](https://stellar.expert/explorer/testnet/tx/cb8bdc9b2a9ecadc38e7b71202671e52a6f4fb30bdf7711609cbb8c42cc27163) ([archive](scripts/evidence/archive/cb8bdc9b2a9ecadc38e7b71202671e52a6f4fb30bdf7711609cbb8c42cc27163.json)). So the fallback test euro (`TEUR`) was not issued.

**The issuer on every step.** Every step below names that issuer, and stellar.expert shows it with the asset.

| Step (2026-11-24, UTC) | Transaction | What it shows |
|---|---|---|
| The treasury pays the seller 2 EURC (10:35:47) | [`c14f538f…2784`](https://stellar.expert/explorer/testnet/tx/c14f538faef40184749efe9287c7e0e165d9b8f9f8cf811113a14a86aeb32784) ([archive](scripts/evidence/archive/c14f538faef40184749efe9287c7e0e165d9b8f9f8cf811113a14a86aeb32784.json)) | Payment of 2 EURC |
| Lock with the 72-hour window (10:35:52) | [`885679e7…e40f`](https://stellar.expert/explorer/testnet/tx/885679e77e230c758a75367e1451176147a7ac42fcdaf8c629d6d5d283f0e40f) ([archive](scripts/evidence/archive/885679e77e230c758a75367e1451176147a7ac42fcdaf8c629d6d5d283f0e40f.json)) | 1 EURC, claimable by the buyer for the first 259,200 seconds and by the seller after |
| Claim by the buyer (10:35:57) | [`3b3125b2…8805`](https://stellar.expert/explorer/testnet/tx/3b3125b283af4ca77920c9ff25d92c28c040478baed9a88fb1ba26b53d198805) ([archive](scripts/evidence/archive/3b3125b283af4ca77920c9ff25d92c28c040478baed9a88fb1ba26b53d198805.json)) | The buyer claims that balance |
| Lock with a 60-second test window (10:36:02) | [`33132747…20b9`](https://stellar.expert/explorer/testnet/tx/3313274709b86496c586d2d9fda13fcc11dac4e2adfb4fa168911f2d256420b9) ([archive](scripts/evidence/archive/3313274709b86496c586d2d9fda13fcc11dac4e2adfb4fa168911f2d256420b9.json)) | 1 EURC |
| The seller's reclaim 5 seconds later (10:36:07) | [`a2413a4c…1e50`](https://stellar.expert/explorer/testnet/tx/a2413a4c24f9b86a7c5aa68dc3e81a82063224f0c04531ab3c0d803503921e50) ([archive](scripts/evidence/archive/a2413a4c24f9b86a7c5aa68dc3e81a82063224f0c04531ab3c0d803503921e50.json)) | Rejected on chain with `op_cannot_claim`, as it should be |
| The seller's reclaim after the 60 seconds (10:37:07) | [`2bdb9587…5513`](https://stellar.expert/explorer/testnet/tx/2bdb958763cad008f216963c22fb9d5e9985d8768c7eb9acda79e1aebe955513) ([archive](scripts/evidence/archive/2bdb958763cad008f216963c22fb9d5e9985d8768c7eb9acda79e1aebe955513.json)) | The seller takes it back |
| The treasury pays another seller 1 EURC (10:37:52) | [`eb5b486e…e890`](https://stellar.expert/explorer/testnet/tx/eb5b486eab2e9ef03c2c5f39e5accefeae66b5efacca6a16cbb18dbe6961e890) ([archive](scripts/evidence/archive/eb5b486eab2e9ef03c2c5f39e5accefeae66b5efacca6a16cbb18dbe6961e890.json)) | Payment of 1 EURC |
| A real 72-hour lock, left alone (10:37:57) | [`34f45a50…acfa`](https://stellar.expert/explorer/testnet/tx/34f45a50f8f562eab11f1f730b3e5f34fde6de76ea98d196102799330566acfa) ([archive](scripts/evidence/archive/34f45a50f8f562eab11f1f730b3e5f34fde6de76ea98d196102799330566acfa.json)) | 1 EURC, balance `000000007d6d…7f14`. The buyer's key was never saved, so nobody claims it. It matures on 2026-11-27 at 10:37:57 UTC (still open at 22:19 UTC on 2026-11-24) |
| The seller's reclaim of that lock after it matures | Not done yet | Done after 2026-11-27 10:37:57 UTC, before the reset, and linked here |

The run records are [`settlement-eurc.json`](scripts/evidence/out/settlement-eurc.json) and [`abandon-72h-eurc.json`](scripts/evidence/out/abandon-72h-eurc.json).

#### A resolve held for 24 hours (S-19)

A spike asked whether a prepared resolve can wait a long time for two signers. It used a test 2-of-2 resolver and a spike escrow, not the real arbiter.
- **The test.** A Trustless Work resolve, re-timed to stay valid for 24 hours and signed by both test keys, was submitted at the end of its window, on 2026-11-24 at 19:51 UTC.
- **Refused.** It was refused in a ledger with `tx_failed`, `insufficient_refundable_fee`: [`096947f5…e0a3`](https://stellar.expert/explorer/testnet/tx/096947f5b3059131060a5bd51b42c066b7c579a3d8d3a8969f27e9263015e0a3) (to be archived on 2026-12-15) (fee charged: 12,752 stroops).
- **Why.** Trustless Work had declared a resource fee of 19,916 stroops. The network's simulation asked for 19,919 for about 23.5 hours, and for 25,729 at the time of the submit.
- **The control.** The same resolve with its fee cap raised by 1,000,000 stroops landed: [`b7bb9794…3d88`](https://stellar.expert/explorer/testnet/tx/b7bb9794ab0477912822af1351776fd60e5d9cf19346ab59aa8b29c162803d88) (to be archived on 2026-12-15). It paid as prepared: 4.985 USDC to the recipient and 0.015 to Trustless Work's fee address.

So a prepared resolve has almost no fee headroom, and it can fail if it is held long. Pairy keeps each prepared resolve valid for 60 minutes only and never raises its fee cap. When the network refuses one, the arbiter page says "This prepared transaction was not accepted by the network; prepare again." The run's record is kept on the unmerged spike branch.

#### Local runs of the app

These are not on chain beyond the transactions linked here, and their logs are not in the repository.

- **Migration rehearsal (2026-11-24).**
  - **Setup.** A Postgres 16 database was built with `72800bb`'s migrations and seeded with Phase 1 rows. One `pnpm db:migrate` then took it to the month-2 schema.
  - **Result.** Every existing row was unchanged, every remaining amount was right, and the old build kept serving everything but new listings.
  - **Details.** The WP-27 row of [`docs/phase2-gates.md`](docs/phase2-gates.md), and [`docs/remaining-amount-rehearsal-2026-11-24.md`](docs/remaining-amount-rehearsal-2026-11-24.md) for the steps the release runs.
- **Protected trades end to end on localhost (2026-11-24).** This is the WP-38 row of [`docs/phase2-gates.md`](docs/phase2-gates.md).
  - **Setup.** The built app (`pnpm build`, `pnpm start`), with protected mode on, the real arbiter account, Trustless Work's development key and the migrated database.
  - **Trades A (device-key seller) and P (Privy seller).** Each was opened, accepted, escrowed with a one-time key made in the browser, funded and released.
  - **Trade D.** It was disputed and both sides answered. Pairy's arbiter code listed it as ready under rule 1 and prepared the resolve, but nobody signed it.

| Trade | Escrow | Creation | Fund | Release or dispute |
|---|---|---|---|---|
| A, 1 USDC | [`CCMAA6ZH…SJWH`](https://viewer.trustlesswork.com/testnet/v2/CCMAA6ZHRWCCYFFKB5WIYRKJXPB2ONI2F3AYYEOAIEUTFK7U2GQ5SJWH) | [`85b8003b…f2ef`](https://stellar.expert/explorer/testnet/tx/85b8003b06b17f28e2bd57fee96c6668b2d6b60118c827c00b0de5b0c5a8f2ef) (to be archived on 2026-12-15) | [`a69ad83c…b3ff`](https://stellar.expert/explorer/testnet/tx/a69ad83c39949a4e12e56cb69d48c12015068e41c549ba1c4712aab3b83cb3ff) (to be archived on 2026-12-15) | Release [`d2847994…32db`](https://stellar.expert/explorer/testnet/tx/d284799496e8dbd1879d6b35c5de797e972de627eb639fb312efc20ad6a332db) (to be archived on 2026-12-15) |
| P, 1 USDC | [`CCKPK7HY…7DSM`](https://viewer.trustlesswork.com/testnet/v2/CCKPK7HYKE6BHAS2HVFDJHF7ZTU27LO5F5REK7EBAYTDHS772CFW7DSM) | [`990b06fd…580c`](https://stellar.expert/explorer/testnet/tx/990b06fd4600a9ff71989351ce6363eee13acb6a460f9f9ea21aba6ac710580c) (to be archived on 2026-12-15) | [`76174344…f6ca`](https://stellar.expert/explorer/testnet/tx/7617434443eced479df86b6dd7e7f04076801dcdcd397a01b0b40d782a9cf6ca) (to be archived on 2026-12-15) | Release [`03444981…6635`](https://stellar.expert/explorer/testnet/tx/034449819e2812186b8129c020f057876408cbecc37e5abc63d0891af51c6635) (to be archived on 2026-12-15) |
| D, 1 USDC | [`CD7VRCAJ…K6LU`](https://viewer.trustlesswork.com/testnet/v2/CD7VRCAJIOPGX7LIV5YRTH7VCWOZD4GEE7N3QHONU6HY23SYAZWXK6LU) | [`f68ba9c2…0976`](https://stellar.expert/explorer/testnet/tx/f68ba9c26cdd5821b981590ce8f3da0c30666242fb4b12aac719e6dbbc3d0976) (to be archived on 2026-12-15) | [`89da642e…44d1`](https://stellar.expert/explorer/testnet/tx/89da642e54c20505e97bdebce8a488c691a0a0ef607a07f9a0d9e93773fa44d1) (to be archived on 2026-12-15) | Dispute [`c2f6eb29…dfc3`](https://stellar.expert/explorer/testnet/tx/c2f6eb295ce5a1e507ce8a1e7b37b2109c53f0d59508ec2b48730435f9dcdfc3) (to be archived on 2026-12-15) |

### CI checks: green and deliberate red runs

SOW 6.1 asks, for every new CI check, for a green run and for a run on a throwaway branch where the check was made to fail on purpose.

**Not done yet on GitHub.** Nothing from month 2 is pushed yet, so there are no GitHub run links. Three things go out together in the release push, after the owner approves it:
- `main`;
- the branch `red/listing-reservation`;
- the six `fail/*` branches.

Their run links go into this table then, and the branches are rebuilt on the final commit before that push.

**Done locally on 2026-11-24.** Until the push, the table shows a local run of every step of `.github/workflows/ci.yml`. Each step ran with the workflow's own command and a clean environment, on the release candidate (commit `1ca9a00`) and on each throwaway branch built on it. In that candidate's CI file, each check still runs after an earlier one fails, so a red run shows its own step red instead of skipped.

| CI step | New in month 2 | Green run on GitHub | Made to fail on purpose | Local result |
|---|---|---|---|---|
| `no-secret-fields` | Extended: no Stellar key may be made outside the wallet and creation-key modules | Not done yet | `fail/no-secret-fields`: `Keypair.random()` added to the escrow router | Green on the candidate. On the branch, only this step is red (1 test) |
| `coordination-purge-on-terminal` | Extended: the protected exits, and dispute notes | Not done yet | `fail/purge`: the dispute-note purge commented out | This step is red (2 tests). Also red, because they test the same purge: `unit tests` (5 tests) and the Postgres step (1 test) |
| `tw-endpoint-allowlist` | New | Not done yet | `fail/tw-endpoint-allowlist`: an `updateEscrow` call added to the Trustless Work client | Only this step is red (2 tests) |
| `listing-reservation-concurrency` | New | Not done yet | `red/listing-reservation`: the tests on the old code `72800bb` | This step is red: "2 fulfilled, expected 1" |
| `no-privy-signers` | New | Not done yet | `fail/no-privy-signers`: Privy's `useSigners` imported, and a Privy server package added | Only this step is red (4 tests) |
| `listing-reservation-concurrency (postgres)`, in the new `pg-concurrency` job | New. It also runs the answer-lock test | Not done yet | `fail/pg-concurrency`: the listing row lock removed. `fail/dispute-answer-purge`: saving an answer no longer locks the trade row | On each branch only this step is red (1 test each; the first fails with "10 fulfilled, expected 1") |
| `settlement on testnet` (`testnet.yml`) | Extended to EURC | Not done yet | None: it runs only on `main` and by hand, against the real testnet | Not run |

### Recordings

Each recording is uncut and is linked here once it exists.

| Recording | What it shows | Status |
|---|---|---|
| R1 (Deliverable 1) | Email sign-up, a lock and claim signed through Privy, the same email signing again in a second browser, the exported key imported into Varial (formerly Freighter) | Not done yet: recorded on pairy.org after the release |
| R2 (Deliverable 2) | Two traders accept the acceptance screen; the seller creates and funds the escrow; a dispute from the flag dialog; both answers; the arbiter page shows the rule's outcome; both builders sign; the resolution in the trade room; the chat gone; a non-signer refused at pairy.org/arbiter | Not done yet: recorded on pairy.org after the release, before 2026-12-16 17:00 UTC |
| R3 (Deliverable 2) | A protected trade released by the seller | Not done yet: recorded on pairy.org after the release, before 2026-12-16 17:00 UTC |
| R4 (Deliverable 3) | A listing's "left" amount before and after a trade and after a cancel, and an EURC trade | Not done yet: recorded on pairy.org after the release |
| R5 | The full walkthrough of the hosted app | Not done yet: recorded on pairy.org after the release |

### What cannot be shown on chain

- **Each arbiter signature was made on a builder's own computer**, in Varial (formerly Freighter): Ömer Alpi's with `GDRJ7JMJ…LD5Q`, Ensar Mert Günay's with `GDH2MGKJ…N6J7`.
  - On chain, each resolve shows two signatures, one from each of those keys.
  - Where the keys are kept, and that each signature was made on its holder's own computer, is the builders' statement. Nothing on chain can show it.
  - On the day-12 gate, each signed the same transaction hash in Stellar Lab, on their own computer.
- **The arbiter signer keys are used only to sign as the arbiter.** On chain, neither key has an account of its own, so neither has made a transaction.
- **Each escrow creation key was dropped after the creation.** On chain, each creation account has made no transaction since the creation. That is consistent with the drop, but it is not proof of it.
- **The platform setup key and the arbiter's own key existed only in memory, for one run of their setup scripts.** This does not matter on chain: both are at weight 0, so they can sign nothing, whether or not a copy exists.
- **Pairy's server holds no Stellar signing key.** This is a property of the code, checked by the CI step `no-secret-fields` (above), not something a ledger shows.
- **How Privy holds a wallet key.** The key shares and the enclave are Privy's design, stated in Privy's documentation. On chain, a Privy wallet is an ordinary account with one key.

### The testnet reset of 2026-12-16

SDF has scheduled a reset of Stellar testnet for 2026-12-16 at 17:00 UTC ([developers.stellar.org/docs/networks](https://developers.stellar.org/docs/networks), read 2026-11-24).
- **What it deletes.** Every account, contract, escrow and transaction, and stellar.expert stops showing them. Every pre-reset link in this file, Phase 1's included, stops opening then.
- **The archive.** The last run of `scripts/evidence/archive.ts`, on 2026-12-15, saves into [`scripts/evidence/archive/`](scripts/evidence/archive/):
  - each transaction's signed envelope, result and operations, as Horizon returns them;
  - each escrow's terms;
  - each pinned account's signers.

  So every hash and signature can still be checked offline.
- **The accounts.** After the reset, the arbiter and platform accounts are created again, the arbiter with the same two signer keys. Both the old and the new addresses are listed here and in `docs/arbitration.md`.
- **The 72-hour EURC lock.** The lock of 2026-11-24 is wiped with everything else, and a new one is opened and reclaimed after the reset.

This paragraph is updated with what actually happened.

### Reviewer checklist, month 2 (SOW 6.2)

| Deliverable | Evidence present | Evidence partial | Evidence missing | Comments |
|---|---|---|---|---|
| Deliverable 1 | ☐ | ☐ | ☐ | |
| Deliverable 2 | ☐ | ☐ | ☐ | |
| Deliverable 3 | ☐ | ☐ | ☐ | |
