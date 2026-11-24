import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { mergeSignatures } from "@/lib/escrow/multisig";
import { rebuildMaxTime } from "@/lib/escrow/xdr";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import type { Signer, SubmitOptions } from "@/lib/trade/sign-and-submit";
import type { Wallet } from "@/lib/wallet/use-wallet";

import {
  chainProblems,
  checkResolution,
  dropsHeld,
  failureSentence,
  handoffSentence,
  heldResolution,
  signResolution,
  signerProblem,
  validity,
} from "./resolve-flow";

// HD-3's real buyer exit: Trustless Work's resolve as returned, and the same
// resolve re-timed to Horizon time + 60 min, which Ömer and Ensar signed.
const EXIT = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/exits-real-resolve-buyer.json"), "utf8")) as {
  response: { body: { unsignedXdr: string; txHash: string } };
  escrow: { contractId: string; seller: string; buyer: string };
  sacBalanceStroops: number;
  rebuilt: { horizonTime: number; maxTime: number; unsignedXdr: string; txHash: string };
};
const horizonTime = EXIT.rebuilt.horizonTime;
const at = (seconds: number) => new Date(seconds * 1000);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const abbr = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/** The dispute as arbiter.byId shows it, with the escrow read fresh from Soroban RPC. */
const dispute = {
  contractId: EXIT.escrow.contractId,
  seller: EXIT.escrow.seller,
  buyer: EXIT.escrow.buyer,
  answers: { seller: true as boolean | null, buyer: true as boolean | null },
  ready: true,
  escrow: { status: { disputed: true, released: false, resolved: false, balanceStroops: BigInt(EXIT.sacBalanceStroops) } } as {
    status: { disputed: boolean; released: boolean; resolved: boolean; balanceStroops: bigint };
  } | null,
};
const prepared = { unsignedXdr: EXIT.rebuilt.unsignedXdr, txHash: EXIT.rebuilt.txHash };

describe("checkResolution: the browser's own check of the re-timed resolve (DECISIONS 7, O-17)", () => {
  it("passes the resolve the real signers signed, inside its window, and describes what is signed", () => {
    expect(checkResolution(prepared, dispute, at(horizonTime + 60))).toEqual({
      problems: [],
      summary: `Pay this trade's escrow to ${EXIT.escrow.buyer.slice(0, 4)}…${EXIT.escrow.buyer.slice(-4)}: 4.985 USDC after Trustless Work's 0.3% fee`,
    });
    // The browser signs nothing in the last ten minutes of the window (O-17's floor): the last signer must still send.
    expect(checkResolution(prepared, dispute, at(EXIT.rebuilt.maxTime - 11 * 60)).problems).toEqual([]);
    expect(checkResolution(prepared, dispute, at(EXIT.rebuilt.maxTime - 60)).problems).toEqual([expect.stringMatching(/in less than 10 minutes/)]);
  });

  it("refuses a window outside the O-17 policy: longer than 24 hours, shorter than 10 minutes, or Trustless Work's own 5 minutes", () => {
    const now = at(horizonTime + 60);
    const tooLong = rebuildMaxTime(EXIT.response.body.unsignedXdr, horizonTime + 25 * 3600);
    expect(checkResolution(tooLong, dispute, now).problems).toEqual([expect.stringMatching(/more than 24 hours ahead/)]);
    const tooShort = rebuildMaxTime(EXIT.response.body.unsignedXdr, horizonTime + 5 * 60);
    expect(checkResolution(tooShort, dispute, now).problems).toEqual([expect.stringMatching(/in less than 10 minutes/)]);
    // Trustless Work's original was never re-timed: 300 s is under the floor.
    expect(checkResolution(EXIT.response.body, dispute, now).problems).toEqual([expect.stringMatching(/in less than 10 minutes/)]);
  });

  it("refuses an expired resolve", () => {
    expect(checkResolution(prepared, dispute, at(EXIT.rebuilt.maxTime + 1)).problems).toEqual([expect.stringMatching(/^It expired at .* Prepare it again\.$/)]);
  });

  it("refuses a payout the rule does not give: the browser applies the rule to the answers itself", () => {
    // Seller no, buyer yes: rule 3, all to the seller. The transaction pays the buyer.
    const contested = { ...dispute, answers: { seller: false, buyer: true } };
    expect(checkResolution(prepared, contested, at(horizonTime + 60)).problems).toEqual([
      `It pays out 5 USDC to ${EXIT.escrow.buyer}, not 5 USDC to ${EXIT.escrow.seller}.`,
    ]);
  });

  it("refuses an amount other than the escrow's balance on chain (FIXES X-07)", () => {
    const short = { ...dispute, escrow: { status: { ...dispute.escrow!.status, balanceStroops: 49_000_000n } } };
    expect(checkResolution(prepared, short, at(horizonTime + 60)).problems).toEqual([
      `It pays out 5 USDC to ${EXIT.escrow.buyer}, not 4.9 USDC to ${EXIT.escrow.buyer}.`,
    ]);
  });

  it("refuses a transaction whose hash is not the one the server named, and one that is not a transaction", () => {
    const other = { ...prepared, txHash: EXIT.response.body.txHash };
    expect(checkResolution(other, dispute, at(horizonTime + 60)).problems).toContain("It was prepared for another network, not Stellar testnet.");
    expect(checkResolution({ unsignedXdr: "not xdr", txHash: "00" }, dispute, at(horizonTime + 60)).problems).toEqual([
      expect.stringMatching(/^It could not be read as a transaction/),
    ]);
  });

  it("signs nothing while the answers are not final or the escrow cannot be read", () => {
    expect(checkResolution(prepared, { ...dispute, ready: false }, at(horizonTime + 60)).problems).toEqual([
      "The traders' answers are not final yet, so there is no outcome to sign.",
    ]);
    expect(checkResolution(prepared, { ...dispute, escrow: null }, at(horizonTime + 60)).problems).toEqual([
      "The escrow could not be read from Stellar testnet, so the payout cannot be checked. Try again.",
    ]);
  });
});

describe("signerProblem (D2 §7.4, SOW acceptance item 2, O-30)", () => {
  const me = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
  const wallet = (kind: Wallet["kind"], publicKey = me): Wallet => ({ kind, publicKey, signTransaction: async () => "" });

  it("asks for the extension by its current name when the wallet is not Freighter", () => {
    const sentence = "Sign with Varial (formerly Freighter) on your own computer.";
    expect(signerProblem(null, true, me)).toBe(sentence);
    expect(signerProblem(wallet("device"), true, me)).toBe(sentence);
    expect(signerProblem(wallet("privy"), true, me)).toBe(sentence);
  });

  it("names the account mismatch when Freighter holds another key than the one signed in", () => {
    expect(signerProblem(wallet("freighter", "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7"), true, me)).toBe(
      "Varial (formerly Freighter) is on GDH2…N6J7, but you signed in as GDRJ…LD5Q. Switch it to that account.",
    );
  });

  it("is null for the signed-in signer's own Freighter, and waits while the wallet loads", () => {
    expect(signerProblem(wallet("freighter"), true, me)).toBeNull();
    expect(signerProblem(null, false, me)).toBe("Loading your wallet…");
  });
});

describe("validity: 'valid until hh:mm', when signing closes, and what is left (O-17)", () => {
  const expires = new Date("2026-12-11T14:05:00Z");
  const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const until = hhmm(expires);
  const signUntil = hhmm(new Date("2026-12-11T13:55:00Z"));

  it("shows the time, the signing cut-off ten minutes before it, and the minutes left to sign", () => {
    expect(validity(expires, Date.parse("2026-12-11T13:06:30Z"))).toEqual({ until, signUntil, left: "about 48 minutes left", closing: false, expired: false });
    expect(validity(expires, Date.parse("2026-12-11T13:54:10Z"))).toEqual({ until, signUntil, left: "less than a minute left", closing: false, expired: false });
  });

  it("closes signing ten minutes before maxTime, and is expired from maxTime on", () => {
    expect(validity(expires, Date.parse("2026-12-11T13:55:00Z"))).toEqual({ until, signUntil, left: "signing closed", closing: true, expired: false });
    expect(validity(expires, expires.getTime())).toEqual({ until, signUntil, left: "expired", closing: true, expired: true });
    expect(validity(expires, expires.getTime() + 60_000).expired).toBe(true);
  });
});

describe("failureSentence", () => {
  const expires = new Date("2026-12-11T14:05:00Z");
  const hhmm = expires.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  it("passes the server's and the wallet's sentences through", () => {
    expect(failureSentence(new Error("The arbiter account moved on; prepare again."), expires)).toBe("The arbiter account moved on; prepare again.");
    expect(failureSentence({ message: "Freighter signed with a different account. Switch Freighter to the connected account." }, expires)).toBe(
      "Freighter signed with a different account. Switch Freighter to the connected account.",
    );
    expect(failureSentence("x")).toBe("Something went wrong.");
  });

  it("explains a signer removed while the resolution was being signed (WP-29 N3)", () => {
    expect(failureSentence({ message: "A signature on this transaction is not from one of the arbiter's signers." }, expires)).toBe(
      `A signature on this transaction is not from one of the arbiter's signers. A signer was removed from the arbiter account while this resolution was being signed; prepare again after it expires at ${hhmm}.`,
    );
  });
});

describe("chainProblems: the escrow as this browser reads it from Soroban RPC, against the dispute the server described", () => {
  const terms = { receiver: EXIT.escrow.buyer, releaseSigners: [EXIT.escrow.seller], disputeResolvers: [ARBITER_ACCOUNT] };
  const status = { disputed: true, released: false, resolved: false, balanceStroops: 50_000_000n };
  const parties = { seller: EXIT.escrow.seller, buyer: EXIT.escrow.buyer };

  it("passes the escrow whose own buyer, seller and resolver are the dispute's, still in dispute", () => {
    expect(chainProblems({ terms, status }, parties)).toEqual([]);
  });

  it("refuses a buyer or seller the escrow does not name: the payee must be one of the escrow's own parties", () => {
    const stranger = Keypair.random().publicKey();
    expect(chainProblems({ terms, status }, { ...parties, buyer: stranger })).toEqual([
      `The escrow on chain names ${abbr(EXIT.escrow.buyer)} as its buyer, not ${abbr(stranger)}.`,
    ]);
    expect(chainProblems({ terms, status }, { ...parties, seller: stranger })).toEqual([
      `The escrow on chain names ${abbr(EXIT.escrow.seller)} as its seller, not ${abbr(stranger)}.`,
    ]);
  });

  it("refuses an escrow another resolver decides, and one that is settled or no longer in dispute", () => {
    expect(chainProblems({ terms: { ...terms, disputeResolvers: [EXIT.escrow.seller] }, status }, parties)).toEqual([
      "The escrow on chain does not name the arbiter account as its dispute resolver.",
    ]);
    expect(chainProblems({ terms, status: { ...status, resolved: true } }, parties)).toEqual(["The escrow on chain is already settled; refresh the page."]);
    expect(chainProblems({ terms, status: { ...status, released: true } }, parties)).toEqual(["The escrow on chain is already settled; refresh the page."]);
    expect(chainProblems({ terms, status: { ...status, disputed: false } }, parties)).toEqual(["The escrow on chain is not in dispute."]);
  });
});

describe("heldResolution: the prepared resolution this page holds, as far along as the server or this page knows", () => {
  const ME = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
  const OTHER = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
  const held = { resolutionId: "r1", unsignedXdr: "AAAA", txHash: "aa", summary: "", expiresAt: new Date(0), threshold: 2, signers: [] as string[] };

  it("keeps this page's signers when the server's copy has not caught up yet (the first signer's own signature)", () => {
    expect(heldResolution({ ...held, signers: [ME] }, { id: "r1", signers: [] })?.signers).toEqual([ME]);
  });

  it("takes the server's signers once another signer signed", () => {
    expect(heldResolution(held, { id: "r1", signers: [OTHER] })?.signers).toEqual([OTHER]);
  });

  it("drops it once the server shows another resolution, and keeps it while the server shows none yet", () => {
    expect(heldResolution(held, { id: "r2", signers: [] })).toBeNull();
    expect(heldResolution(held, null)).toEqual(held);
    expect(heldResolution(null, { id: "r1", signers: [] })).toBeNull();
  });
});

describe("dropsHeld: the sentences after which the held resolution is no longer the one to sign", () => {
  it("drops it for an expired, moved-on, failed, sent or settled resolution (FIXES F-03)", () => {
    for (const sentence of [
      "This prepared transaction expired at 2026-12-11T14:05:00.000Z. Prepare again.",
      "The arbiter account moved on; prepare again.",
      "This prepared transaction was not accepted by the network; prepare again.",
      "This resolution was already sent.",
      "No such resolution.",
      "This resolution is on Stellar testnet already; refresh the trade to record it.",
      "This dispute is already settled.",
    ]) {
      expect(dropsHeld(sentence), sentence).toBe(true);
    }
  });

  it("keeps it for a refusal the signer can fix and sign again", () => {
    expect(dropsHeld("Freighter signed with a different account. Switch Freighter to the connected account.")).toBe(false);
    expect(dropsHeld("This copy carries no signature by your key. Sign it with the signer key you signed in with.")).toBe(false);
  });
});

describe("signResolution: re-check, sign in the wallet, merge on the server, and send only as the last signer", () => {
  const now = at(horizonTime + 60);
  const resolutionId = "33333333-3333-4333-8333-333333333333";
  const unsigned = TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction;
  // Signatures by throwaway keys: the server's merge is stubbed, so they stand in for the signers'.
  const sigBy = (k: Keypair) => ({ signer: k.publicKey(), signature: Buffer.from(k.sign(unsigned.hash())).toString("base64") });
  const me = Keypair.random();
  const other = Keypair.random();
  const wallet: Wallet = {
    kind: "freighter",
    publicKey: me.publicKey(),
    signTransaction: vi.fn(async (xdr: string) => mergeSignatures(xdr, [sigBy(me)])),
  };
  /** The escrow as Soroban RPC shows it to this browser: HD-3's buyer exit, disputed, holding 5 USDC. */
  const onChain = (status: Partial<{ disputed: boolean; released: boolean; resolved: boolean; balanceStroops: bigint }> = {}, receiver = EXIT.escrow.buyer) => ({
    terms: { receiver, releaseSigners: [EXIT.escrow.seller], disputeResolvers: [ARBITER_ACCOUNT] },
    status: { disputed: true, released: false, resolved: false, balanceStroops: BigInt(EXIT.sacBalanceStroops), ...status },
  });

  /** What useChainStep.run would do: build, have the signer sign, check, and "send". */
  function runner() {
    const sent: string[] = [];
    const run = async (signer: Signer, build: () => Promise<Transaction>, opts: Pick<SubmitOptions, "summary" | "beforeSubmit"> = {}) => {
      const xdr = await signer.signTransaction((await build()).toXDR(), { summary: opts.summary });
      await opts.beforeSubmit?.(hex((TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction).hash()));
      sent.push(xdr);
    };
    return { run, sent };
  }
  const base = () => ({ prepared: { ...prepared, resolutionId }, dispute, wallet, readEscrow: vi.fn(async () => onChain()), onSend: vi.fn(), now });

  it("hands off after the first signature: the wallet signed, the server merged, nothing was sent", async () => {
    const { run, sent } = runner();
    const addSignature = vi.fn(async (_input: { resolutionId: string; signedXdr: string }) => ({
      signedXdr: mergeSignatures(prepared.unsignedXdr, [sigBy(me)]),
      signerCount: 1,
      threshold: 2,
      signers: [me.publicKey()],
    }));
    const p = base();
    const out = await signResolution({ ...p, addSignature, run });

    expect(out).toMatchObject({ signerCount: 1, threshold: 2, signers: [me.publicKey()] });
    // The escrow was read by this browser, not taken from the server.
    expect(p.readEscrow).toHaveBeenCalledWith(EXIT.escrow.contractId);
    expect(wallet.signTransaction).toHaveBeenCalledWith(prepared.unsignedXdr, { summary: expect.stringMatching(/^Pay this trade's escrow to/) });
    const posted = addSignature.mock.calls[0][0];
    expect(posted.resolutionId).toBe(resolutionId);
    // The copy posted is the wallet's: this signer's one signature on the prepared transaction.
    const copy = TransactionBuilder.fromXDR(posted.signedXdr, NETWORK_PASSPHRASE) as Transaction;
    expect(hex(copy.hash())).toBe(prepared.txHash);
    expect(copy.signatures).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("as the last signer, sends the envelope the server merged, not the wallet's copy, and says it is sending", async () => {
    const { run, sent } = runner();
    const merged = mergeSignatures(prepared.unsignedXdr, [sigBy(other), sigBy(me)]);
    const addSignature = vi.fn(async () => ({ signedXdr: merged, signerCount: 2, threshold: 2, signers: [other.publicKey(), me.publicKey()] }));
    const p = base();
    const out = await signResolution({ ...p, addSignature, run });

    expect(out).toMatchObject({ signerCount: 2, threshold: 2, signers: [other.publicKey(), me.publicKey()] });
    expect(sent).toEqual([merged]);
    expect((TransactionBuilder.fromXDR(sent[0], NETWORK_PASSPHRASE) as Transaction).signatures).toHaveLength(2);
    expect(p.onSend).toHaveBeenCalledOnce();
  });

  it("never sends a merged envelope that is not the transaction this page checked", async () => {
    const { run, sent } = runner();
    const another = TransactionBuilder.fromXDR(EXIT.response.body.unsignedXdr, NETWORK_PASSPHRASE) as Transaction;
    another.sign(me);
    const addSignature = vi.fn(async () => ({ signedXdr: another.toXDR(), signerCount: 2, threshold: 2, signers: [other.publicKey(), me.publicKey()] }));
    const p = base();
    await expect(signResolution({ ...p, addSignature, run })).rejects.toThrow("The merged resolution is not the transaction this page checked. Nothing was sent.");
    expect(sent).toEqual([]);
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("re-checks the policy right before signing and refuses a tampered resolve without opening the wallet", async () => {
    const { run, sent } = runner();
    const sign = vi.fn(async (xdr: string) => xdr);
    const addSignature = vi.fn();
    const tooLong = rebuildMaxTime(EXIT.response.body.unsignedXdr, horizonTime + 25 * 3600);
    await expect(
      signResolution({ ...base(), prepared: { ...tooLong, resolutionId }, wallet: { ...wallet, signTransaction: sign }, addSignature, run }),
    ).rejects.toThrow(/^This browser won't sign it: It stays valid until .*, more than 24 hours ahead\.$/);
    // The same resolve, once its window has run out on this clock.
    await expect(
      signResolution({ ...base(), wallet: { ...wallet, signTransaction: sign }, addSignature, run, now: at(EXIT.rebuilt.maxTime) }),
    ).rejects.toThrow(/^This browser won't sign it: It expired at/);
    expect(sign).not.toHaveBeenCalled();
    expect(addSignature).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("takes the amount from this browser's own read of the escrow, not the server's: a balance that moved is refused", async () => {
    const { run, sent } = runner();
    const sign = vi.fn(async (xdr: string) => xdr);
    const addSignature = vi.fn();
    // The server still says 5 USDC (dispute.escrow); Soroban RPC says 4.9.
    const readEscrow = vi.fn(async () => onChain({ balanceStroops: 49_000_000n }));
    await expect(signResolution({ ...base(), readEscrow, wallet: { ...wallet, signTransaction: sign }, addSignature, run })).rejects.toThrow(
      `This browser won't sign it: It pays out 5 USDC to ${EXIT.escrow.buyer}, not 4.9 USDC to ${EXIT.escrow.buyer}.`,
    );
    expect(sign).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses a payee the escrow on chain does not name, a settled escrow and an unreadable one, without opening the wallet", async () => {
    const { run, sent } = runner();
    const sign = vi.fn(async (xdr: string) => xdr);
    const addSignature = vi.fn();
    const p = { ...base(), wallet: { ...wallet, signTransaction: sign }, addSignature, run };
    // The server names a buyer the escrow does not: the resolve would pay someone who is not this escrow's party.
    const stranger = Keypair.random().publicKey();
    await expect(signResolution({ ...p, readEscrow: vi.fn(async () => onChain({}, stranger)) })).rejects.toThrow(
      `This browser won't sign it: The escrow on chain names ${abbr(stranger)} as its buyer, not ${abbr(EXIT.escrow.buyer)}.`,
    );
    await expect(signResolution({ ...p, readEscrow: vi.fn(async () => onChain({ resolved: true })) })).rejects.toThrow(
      "This browser won't sign it: The escrow on chain is already settled; refresh the page.",
    );
    await expect(
      signResolution({
        ...p,
        readEscrow: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      }),
    ).rejects.toThrow("Couldn't read the escrow from Stellar testnet, so this browser can't check the payout. Try again.");
    expect(sign).not.toHaveBeenCalled();
    expect(addSignature).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
