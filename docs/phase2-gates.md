# Phase 2 gates

A dated log of the Phase 2 gates: what each one needs, when it is due, what happens if it is missed, and what actually happened. Each row is filled in on the day the gate is decided, with a link to its proof (a stellar.expert transaction, a CI run or a commit).

Sprint day 1 is 2026-11-24 and day 30 is 2026-12-23. A gate that falls on a weekend and needs people (a push, or both arbiter signers) may move to the next Monday; the Date column records the real date.

## Gates

| Day | Due | Gate | If it is missed | Result | Date | Proof |
|---|---|---|---|---|---|---|
| 4 | 2026-11-27 | **D1**: a Privy-signed testnet payment on stellar.expert, and a SEP-53 sign-in through Privy accepted by the unchanged check | Retry until day 10; then Deliverable 1 is not claimed as done, and each tested step's result, failing call and error go into EVIDENCE.md | pending | | |
| 5 | 2026-11-28 | [`docs/arbitration.md`](arbitration.md) on GitHub, with the rule and the acceptance text | No fallback in the SOW; EVIDENCE.md quotes the first-commit date. | pending | | |
| 5 | 2026-11-28 | **D2**: one USDC escrow created with a fresh creation key, funded and released on testnet by the repo's script, with Pairy's role mapping | Retry until day 12; then Deliverable 2 is reported not delivered | pending | | |
| 10 | 2026-12-03 | **EURC source**: test EURC in a team account | The third asset is a test euro token (`TEUR`, "Test EUR") from a new testnet issuer, disclosed in EVIDENCE.md | pending | | |
| 12 | 2026-12-05 | **Dispute exits**: resolved to the buyer and resolved to the seller, scripted with the two-signature arbiter | User-facing protected mode is not delivered; only the scripted exits ship | pending | | |
| 14 | 2026-12-07 | Arbiter account (signers and thresholds) and locked platform account on stellar.expert | No protected trade is offered until both exist | pending | | |
| 14 | 2026-12-07 | Deliverable 1's sign-in, lock and claim live on pairy.org | Reported in EVIDENCE.md with the reason | pending | | |
| 19 | 2026-12-12 | A real 72-hour EURC (or `TEUR`) lock opened on testnet | Reported in EVIDENCE.md with the reason | pending | | |
| 21 | 2026-12-14 | Export and social login working | The flow ships with email login; EVIDENCE.md marks export or social login not done, with the reason | pending | | |
| 24 | 2026-12-17 | In-app protected mode live on pairy.org | The script's three exits are the evidence; EVIDENCE.md marks in-app protected mode not done | pending | | |
| 24 | 2026-12-17 | The third asset live on pairy.org | The remaining amount ships; EVIDENCE.md marks the asset item not done | pending | | |

## Spike results

Results of the spikes the gates depend on, each with its date.

| Date | Spike | Result | Proof |
|---|---|---|---|
