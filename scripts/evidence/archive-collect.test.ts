import { describe, expect, it } from "vitest";

import { collectEscrowIds, collectHashes, docLinks } from "./archive-collect";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const F = "f".repeat(64);
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const ESCROW_2 = "CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2";
const FACTORY = "CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ACCOUNT = "GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH";

const sorted = (xs: string[]) => [...xs].sort();

describe("collectHashes", () => {
  it("finds hash fields at any depth: setup, steps, Trustless Work's txHash and the landed resolve", () => {
    // The shape of out/escrow-dispute-*-real.json, trimmed.
    const record = {
      exit: "dispute-seller",
      runs: [
        {
          setup: [{ step: "seller trustline", hash: A }],
          steps: [
            { step: "deploy", hash: B, tw: { response: { body: { txHash: B } } } },
            { step: "resolve", hash: C, tw: { response: { body: { txHash: D } } }, resolve: { rebuilt: { txHash: C }, landed: { hash: C } } },
          ],
        },
      ],
    };
    expect(sorted(collectHashes(record))).toEqual(sorted([A, B, C, D]));
  });

  it("reads both shapes of the one-signature attempts, once each (N3)", () => {
    const record = {
      runs: [
        { steps: [{ resolve: { singleSignature: { hash: E, codes: ["tx_bad_auth"] } } }] },
        { steps: [{ resolve: { singleSignatures: [{ hash: F }, { hash: F }] } }] },
      ],
    };
    expect(sorted(collectHashes(record))).toEqual(sorted([E, F]));
  });

  it("reads the Phase 1 shapes: a top-level array, and an applied run's tx", () => {
    expect(collectHashes([{ balanceId: `00000000${B}`, lock: { hash: A } }])).toEqual([A]);
    expect(collectHashes({ runs: [{ tx: { hash: C } }] })).toEqual([C]);
  });

  it("ignores 64-hex strings under every other key: balance ids, wasm hashes, signatures, attempts", () => {
    const record = {
      balanceId: F,
      lockHash: F,
      trustlessWork: { wasmHash: F },
      signature: F,
      acceptanceVersion: F,
      attempts: [{ twTxHash: F, rebuiltTxHash: F }],
      note: `see ${F}`,
      steps: [{ hash: A }, { hash: "not a hash" }, { hash: A.toUpperCase() }, { hash: 64 }],
    };
    expect(collectHashes(record)).toEqual([A]);
  });

  it("returns nothing for a record without hashes", () => {
    expect(collectHashes({ attempts: [{ treasury: null }] })).toEqual([]);
    expect(collectHashes(null)).toEqual([]);
  });
});

describe("collectEscrowIds", () => {
  it("finds each run's escrow, not the factory or the token the deploy names under trustline", () => {
    const record = {
      runs: [
        {
          contractId: ESCROW,
          trustlessWork: { factory: FACTORY },
          escrowAfterDeploy: { token: USDC },
          steps: [
            {
              contract: FACTORY,
              tw: { request: { body: { trustline: { contractId: USDC } } }, response: { body: { contractId: ESCROW } } },
            },
          ],
        },
        { contractId: ESCROW_2, steps: [{ resolve: { escrow: { contractId: ESCROW_2 } } }] },
      ],
    };
    expect(sorted(collectEscrowIds(record))).toEqual(sorted([ESCROW, ESCROW_2]));
  });
});

describe("docLinks", () => {
  it("takes stellar.expert tx and account links and Trustless Work viewer links, once each", () => {
    const markdown = [
      `| [payment 53a00e96…](https://stellar.expert/explorer/testnet/tx/${A}); [again](https://stellar.expert/explorer/testnet/tx/${A}) |`,
      `| [account](https://stellar.expert/explorer/testnet/account/${ACCOUNT}), [setup](https://stellar.expert/explorer/testnet/tx/${B}) |`,
      `| [factory](https://stellar.expert/explorer/testnet/contract/${FACTORY}), [viewer](https://viewer.trustlesswork.com/testnet/v2/${ESCROW}) |`,
      `Not links: \`${C}\`, escrow \`${ESCROW_2}\`, https://stellar.expert/explorer/public/tx/${D}`,
    ].join("\n");
    expect(docLinks(markdown)).toEqual({ txs: [A, B], escrows: [ESCROW], accounts: [ACCOUNT] });
  });
});
