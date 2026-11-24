// Reads a protected trade's escrow straight from Soroban RPC, in the browser
// and on the server alike (S-17). Never through Pairy's server or Trustless
// Work: Trustless Work's read model kept a resolved escrow "active" (WP-03).
//
// The terms and the state are the escrow's ["Escrow"] entry, the entry
// Trustless Work's viewer shows. The escrow's USDC is its balance in the USDC
// contract, never the stored amount: the contract pays out exactly that
// balance (FIXES X-07).
//
// Archived storage is still read: Soroban RPC returns an archived entry with
// liveUntilLedgerSeq 0, and the next escrow call restores it (WP-14's TTL
// decision, docs/phase2-gates.md).
//
// This is the only module that builds a contract call, and only to simulate a
// read: from NULL_ACCOUNT, never signed and never sent (FIXES F-19;
// tests/ci/tw-endpoint-allowlist #7).

import { Account, Address, BASE_FEE, Contract, TimeoutInfinite, TransactionBuilder, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { soroban } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";

import { USDC_SAC } from "./config";
import { termsOfEscrow, type EscrowStatus, type EscrowTerms } from "./terms";

/** No contract at this address: never deployed, or gone with a testnet reset. */
export class EscrowNotFoundError extends Error {
  constructor(readonly contractId: string) {
    super(`There is no contract at ${contractId} on Stellar testnet.`);
    this.name = "EscrowNotFoundError";
  }
}

/**
 * Ledger numbers for the escrow's storage rent (O-17). A liveUntil below
 * latestLedger (Soroban RPC sends 0) means archived. escrowLiveUntil is null
 * when the escrow was read by simulation instead.
 */
export type EscrowTtl = { latestLedger: number; instanceLiveUntil: number; escrowLiveUntil: number | null };

const persistent = (contractId: string, key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract: Address.fromString(contractId).toScAddress(), key, durability: xdr.ContractDataDurability.persistent }),
  );
const instanceKey = (contractId: string) => persistent(contractId, xdr.ScVal.scvLedgerKeyContractInstance());
/** The contract's DataKey::Escrow, confirmed on the Gate D2 escrow (WP-11). */
const escrowKey = (contractId: string) => persistent(contractId, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Escrow")]));
/** The escrow's USDC: its balance entry in the USDC contract. */
const balanceKey = (contractId: string) =>
  persistent(USDC_SAC, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(contractId).toScVal()]));

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

type Entry = rpc.Api.LedgerEntryResult;
function find(entries: Entry[], key: xdr.LedgerKey): Entry | undefined {
  const k = key.toXDR("base64");
  return entries.find((e) => e.key.toXDR("base64") === k);
}
function value(e: Entry): xdr.ScVal {
  if (e.val.type !== "contractData") throw new Error(`Soroban RPC answered with a ${e.val.type} entry.`);
  return e.val.contractData.val;
}

/** The escrow struct through its own getter, when it is not under the expected key. */
async function simulateGetEscrow(contractId: string): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(contract.NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call("get_escrow"))
    .setTimeout(TimeoutInfinite)
    .build();
  const sim = await soroban.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`${contractId} is not a Trustless Work escrow: its get_escrow could not be read.`);
  }
  return scValToNative(sim.result.retval);
}

/** The escrow's terms, state and USDC, as the chain has them now. Throws EscrowNotFoundError when there is no contract. */
export async function readEscrow(contractId: string): Promise<{ terms: EscrowTerms; status: EscrowStatus; ttl: EscrowTtl }> {
  const keys = [instanceKey(contractId), escrowKey(contractId), balanceKey(contractId)];
  const { entries, latestLedger } = await soroban.getLedgerEntries(...keys);
  const [instance, escrow, balance] = keys.map((k) => find(entries, k));
  if (!instance) throw new EscrowNotFoundError(contractId);

  // The contract's struct, decoded: snake_case fields, amounts as bigints.
  const s: any = escrow ? scValToNative(value(escrow)) : await simulateGetEscrow(contractId);
  const balanceStroops = balance ? (scValToNative(value(balance)) as { amount: bigint }).amount : 0n;
  return {
    terms: termsOfEscrow(s),
    status: {
      disputed: s?.dispute?.is_disputed === true,
      released: s?.released === true,
      resolved: s?.dispute?.resolved === true,
      balanceStroops,
    },
    ttl: {
      latestLedger,
      instanceLiveUntil: instance.liveUntilLedgerSeq ?? 0,
      escrowLiveUntil: escrow ? (escrow.liveUntilLedgerSeq ?? 0) : null,
    },
  };
}

/** The hash (hex) of the code the contract runs, from its instance entry. Throws EscrowNotFoundError when there is no contract. */
export async function readWasmHash(contractId: string): Promise<string> {
  const key = instanceKey(contractId);
  const instance = find((await soroban.getLedgerEntries(key)).entries, key);
  if (!instance) throw new EscrowNotFoundError(contractId);
  // scValToNative leaves an instance's executable as XDR (WP-11), so read the hash from the XDR itself.
  const v = value(instance);
  if (v.type !== "scvContractInstance" || v.instance.executable.type !== "contractExecutableWasm") {
    throw new Error(`${contractId} runs no contract code of its own.`);
  }
  return hex(v.instance.executable.wasmHash.value);
}
