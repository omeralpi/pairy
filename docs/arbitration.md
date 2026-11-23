# Arbitration in protected trades

This is the rule the arbiter follows when a trader opens a dispute in a protected trade. It is fixed and published before any protected trade, and it ends with the acceptance screen both traders must accept before an escrow is created. Every change to this file is public in its history on GitHub.

Everything here runs on the Stellar testnet with test money only.

## Where this applies

A protected trade is opt-in: it starts only when both traders accept the screen at the end of this file. It is offered for USDC only. The seller's USDC goes into a Trustless Work escrow (V2, single release) instead of the usual claimable-balance lock; Pairy writes and deploys no contract of its own. The seller funds the escrow and is its approver and release signer. The buyer is the receiver. The only dispute resolver on the escrow is the arbiter account named below.

The default trade does not change. In a claimable-balance trade, "Flag a problem" still moves no money, and no arbiter sees that trade.

## Opening a dispute

Only the buyer or the seller can open a dispute, from "Flag a problem", by signing the escrow's dispute call in their own wallet. The reason written on chain is a fixed sentence with no personal data, because anything written there is public. Pairy marks the trade disputed only after reading the dispute back from the chain.

The arbiter cannot open a dispute: the escrow refuses one opened by its resolver. Nobody can open one as the platform either, because the platform account's own key is switched off.

An open dispute shows in the trade room and on the trades list. There are no email or push notifications.

## The question

Once a dispute is open, each trader answers one question in the trade room:

> Was the cash handed over in full?

The answer is yes or no. Each trader may add up to 500 characters of free text.

- **24 hours to answer.** The window starts when Pairy records the dispute and shows it in the trade room, not at the time of the dispute transaction on the ledger. A dispute opened outside Pairy's app counts from the moment Pairy finds it on the chain and shows it, so a dispute nobody could see cannot use up a trader's 24 hours.
- **One answer each, final.** Each side answers once. Before the answer is saved, Pairy asks: "Are you sure? Your answer cannot be changed." Once saved, it cannot be edited, withdrawn or sent again.
- **No answer.** A trader who has not answered when the 24 hours end has sent no answer. Answers are not accepted after that.

## The rule

The outcome follows from the answers alone:

1. If the seller answers yes, the buyer is paid.
2. Otherwise, if the seller sent no answer and the buyer answers yes, the buyer is paid.
3. In every other case the seller gets the USDC back. This includes the contested case: the buyer says the cash was handed over and the seller says it was not, with nothing else to go on.

| Seller answers | Buyer answers | Outcome | Rule |
|---|---|---|---|
| yes | anything, or nothing | all to the buyer | 1 |
| nothing | yes | all to the buyer | 2 |
| nothing | no, or nothing | all back to the seller | 3 |
| no | anything, or nothing | all back to the seller | 3 |

**Why the contested case goes to the seller.** The arbiter cannot see the cash, and "cash paid" is something the buyer sets alone, so the rule must pick a side in advance. Returning the USDC to the account that put it in requires believing nobody, and it keeps the protection protected mode exists for, against a buyer who takes the USDC without paying. The cost falls on the buyer, said plainly: in a protected trade, a seller who takes the cash and then answers no gets the USDC back. That is why the acceptance screen tells the buyer to let go of the cash only when the release shows on screen.

The free text is shown to the arbiter and to both traders and cannot change the outcome. There is no discretion and no case left to judgement.

## When the arbiter acts

The arbiter applies the rule once both traders have answered, or once the 24-hour window has closed, whichever comes first, and never before. Pairy promises to apply the outcome within 72 hours of the dispute, counted from the dispute transaction on the ledger. If Pairy records a dispute late, the delay comes out of the arbiter's 72 hours, not out of the traders' 24. A missed 72-hour promise is reported in [EVIDENCE.md](../EVIDENCE.md).

There are only two outcomes: **all to the buyer**, or **all back to the seller**. Never a split, never another address, never a judgement call. The arbiter page offers only the outcome the rule gives. That is a rule of Pairy's code, not of the escrow contract: the arbiter's keys could sign something else outside the page. That is why every resolution is public on stellar.expert, listed in EVIDENCE.md, and checkable by both traders against the two answers they both see. The resolver's power to sweep leftovers later sent to a finished escrow is not offered at all.

Trustless Work keeps 0.3% of every exit, refunds included: of 100 USDC, 99.7 is paid out, to the buyer or back to the seller.

## What the arbiter sees

The arbiter page lists disputed protected trades only. For each, it shows the escrow's terms, both addresses, every on-chain step, both answers, the outcome the rule gives and both traders' free text.

The arbiter does not read the chat, and the arbiter page does not show it. Photos, files and documents are not used as evidence.

Both yes-or-no answers stay in the trade's timeline, which both traders see. The free text is deleted with the chat when the trade ends. Don't put names, phone numbers or other personal details in it.

## When a trade stalls

The escrow has no deadline. If a funded protected trade is neither released nor disputed within 72 hours, the trade room tells the seller that a dispute is the way to a refund. The seller then gets the USDC back only through a dispute and the rule above.

## The arbiter

The arbiter is one Stellar account whose signer list can change. This month its signers are Ömer Alpi and Ensar Mert Günay, the two Pairy builders. Each signer key is made in Freighter on that builder's own computer and is never on Pairy's server. The account's own key is switched off and every threshold is 2, so both must sign and one key alone can sign nothing. A signer key is used only to sign as the arbiter and cannot be a party to a protected trade.

Next, independent signers are added on testnet (3-of-5, then a 10-person council). Escrows keep pointing at the same address, so existing escrows keep working, and every change to the signer list is public on stellar.expert.

If either signer key is lost, a disputed trade cannot be settled and its USDC stays locked in the escrow. There is deliberately no one-person recovery key.

- **Arbiter account:** not created yet. Its address and its stellar.expert link (signers and thresholds) are added here when it is created, before any protected trade. <!-- TODO(WP-05): arbiter account G-address + https://stellar.expert/explorer/testnet/account/<G...> -->
- **Platform account:** [`GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW`](https://stellar.expert/explorer/testnet/account/GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW). Every escrow names it as the platform, with a fee of 0. Nothing can sign for it: its own key was set to weight 0 in the same transaction that added its USDC trustline, and it has no other signer ([setup transaction](https://stellar.expert/explorer/testnet/tx/c8dcfad48bcb13679990b72228111697410b5511ed6970f4c1a187e7310ea9f8), 2026-11-23).

## The acceptance screen, word for word

Both traders see this text and must each accept it before the escrow is created:

> Protected trade: read before you accept.
> 1. The USDC goes into a Trustless Work escrow instead of the usual lock. The buyer is paid only when the seller releases it, or when the arbiter settles a dispute.
> 2. The arbiter is the Pairy team, Ömer Alpi and Ensar Mert Günay, and both must sign. Its account and signer list are linked below. Pairy also runs this app, and the escrow cannot tell these apart.
> 3. If either of you opens a dispute, the arbiter can send the whole amount anywhere. Pairy's rules allow only all to the buyer or all back to the seller. The arbiter cannot open a dispute and cannot touch this trade's USDC if nobody does.
> 4. The arbiter does not judge and cannot see the cash. Each of you answers "Was the cash handed over in full?" within 24 hours. If the seller says yes, the buyer is paid. If the seller does not answer and the buyer says yes, the buyer is paid. In every other case, including when you disagree, the seller gets the USDC back. Buyer: let go of the cash only when the release shows on your screen. Seller: after you fund, check the trade room daily; a dispute you do not answer within 24 hours pays the buyer if the buyer says yes.
> 5. The escrow has no deadline. If the trade stalls, the seller gets the money back only through a dispute, and only when the arbiter acts (promised within 72 hours). If either arbiter key is lost, a disputed trade cannot be settled and its USDC stays locked.
> 6. Trustless Work keeps 0.3% of every exit, refunds included: of 100 USDC, 99.7 is paid out.
> 7. Test money on Stellar testnet only.

The links item 2 refers to are the arbiter account and its signer list, in [The arbiter](#the-arbiter) above.
