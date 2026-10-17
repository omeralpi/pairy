import { Account, BadResponseError, Keypair, TransactionFailedError } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildClaimTransaction } from "@/lib/stellar/settlement";
import type { Wallet } from "@/lib/wallet/use-wallet";

const hex = (tx: { hash(): Uint8Array }) => Buffer.from(tx.hash()).toString("hex");
const submit = vi.fn(async (tx: { hash(): Uint8Array }) => ({ hash: hex(tx) }));
vi.mock("@/lib/stellar/horizon", () => ({ submit: (tx: never) => submit(tx), loadAccount: vi.fn() }));

const { signAndSubmit } = await import("./sign-and-submit");

const key = Keypair.random();
const tx = () => buildClaimTransaction(new Account(key.publicKey(), "1"), `00000000${"ab".repeat(32)}`);

/** A wallet whose signature arrives when the test says so, like a pincode prompt left open. */
function slowWallet() {
  let approve!: () => void;
  const approved = new Promise<void>((r) => (approve = r));
  const wallet: Wallet = {
    kind: "device",
    publicKey: key.publicKey(),
    signTransaction: async (xdr) => {
      await approved;
      return xdr;
    },
  };
  return { wallet, approve };
}

describe("signAndSubmit (Q-3)", () => {
  beforeEach(() => {
    submit.mockClear();
  });

  it("never sends a signature that comes back after the screen was left", async () => {
    const { wallet, approve } = slowWallet();
    const controller = new AbortController();
    const sent = signAndSubmit(wallet, tx(), { signal: controller.signal });
    controller.abort();
    approve();
    await expect(sent).rejects.toThrow(/cancelled/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not send when the pre-submit check refuses", async () => {
    const { wallet, approve } = slowWallet();
    approve();
    await expect(
      signAndSubmit(wallet, tx(), {
        beforeSubmit: () => {
          throw new Error("This trade is no longer agreed");
        },
      }),
    ).rejects.toThrow(/no longer agreed/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not report the hash as sending when the screen is left during the pre-submit check (F6)", async () => {
    const { wallet, approve } = slowWallet();
    approve();
    const controller = new AbortController();
    const sending: string[] = [];
    await expect(
      signAndSubmit(wallet, tx(), {
        signal: controller.signal,
        beforeSubmit: async () => controller.abort(),
        onSending: (h) => void sending.push(h),
      }),
    ).rejects.toThrow(/cancelled/);
    expect(sending).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("hands the signed hash to beforeSubmit, then sends", async () => {
    const { wallet, approve } = slowWallet();
    approve();
    const t = tx();
    const seen: string[] = [];
    const hash = await signAndSubmit(wallet, t, {
      beforeSubmit: (h) => void seen.push(h),
      onSending: (h) => void seen.push(h),
    });
    expect(seen).toEqual([hex(t), hex(t)]);
    expect(hash).toBe(seen[0]);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("signAndSubmit when Horizon does not answer (submit timeout)", () => {
  beforeEach(() => {
    submit.mockReset();
  });

  const signed = async () => {
    const { wallet, approve } = slowWallet();
    approve();
    return signAndSubmit(wallet, tx());
  };

  it("says a lock or claim Horizon timed out on may still land, not that it failed", async () => {
    // Horizon answers 504 when the network has not applied it within its wait; it can still apply.
    submit.mockRejectedValueOnce(
      new BadResponseError("Transaction submission failed. Server responded: 504 Gateway Timeout", {
        status: 504,
        statusText: "Gateway Timeout",
        data: { title: "Timeout" },
      }),
    );
    const err: unknown = await signed().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/may still go through/);
    expect((err as Error).message).not.toMatch(/failed/);
  });

  it("says the same when the connection drops before Horizon answers", async () => {
    submit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(signed()).rejects.toThrow(/may still go through/);
  });

  it("passes a rate limit through: Horizon turned it away before the network saw it", async () => {
    submit.mockRejectedValueOnce(
      new BadResponseError("Transaction submission failed. Server responded: 429 Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
        data: {},
      }),
    );
    await expect(signed()).rejects.toThrow(/429/);
  });

  it("passes a refusal with result codes through: it never applied", async () => {
    const refused = new TransactionFailedError("Transaction submission failed. Server responded: 400 Bad Request", {
      status: 400,
      statusText: "Bad Request",
      data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_does_not_exist"] } } },
    });
    submit.mockRejectedValueOnce(refused);
    await expect(signed()).rejects.toBe(refused);
  });
});
