// Port of mobile lib/swap/runner.test.ts: the record's life around a stand-in engine (fake IndexedDB underneath).
import "fake-indexeddb/auto";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SwapToken} from "../../../src/contracts/domain";
import type {EvmSourceSigner, StartSwapInput} from "../../../src/contracts/execution";

type Phase = (p: string, d?: {total?: number; hash?: string}) => void;
const exec = vi.hoisted(() => ({run: undefined as undefined | ((onPhase: Phase) => Promise<unknown>)}));
vi.mock("../../../src/execute/execute", () => ({
  executeSwap: (input: {onPhase: Phase}) => exec.run!(input.onPhase),
}));

import {Swap2MaybeSentError} from "@anywalletkit/protocol-swap2-core/errors";
import {getSwaps, INTERRUPTED_SENT_TEXT, INTERRUPTED_TEXT, loadSwaps, markInterrupted, swapSteps} from "../../../src/activity";
import {startSwap, watchSourceTx, watchTronTx} from "../../../src/execute/runner";
import {SwapReviewMismatch} from "../../../src/execute/gate";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

const token = (over: Partial<SwapToken>): SwapToken => ({
  key: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
  chain: "ethereum",
  caip2: "eip155:1",
  chainName: "Ethereum",
  family: "evm",
  symbol: "USDT",
  catalogSymbol: "USDT",
  decimals: 6,
  contract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  gasToken: false,
  amount: "12130000",
  balance: "loaded",
  usd: 12.13,
  owner: ME,
  payMode: "wallet",
  ...over,
});

const signer = {family: "evm", owner: ME} as unknown as EvmSourceSigner;

const input = (onSettled = vi.fn()): StartSwapInput => ({
  from: token({}),
  to: token({key: "ethereum:0xa0b8", symbol: "USDC", catalogSymbol: "USDC", contract: "0xa0b8"}),
  reviewed: {
    provider: "lifi",
    fromChain: "eip155:1",
    fromContract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    amountIn: 3_000_000n,
    destChain: "eip155:1",
    destToken: "0xa0b8",
    recipient: ME,
    refundAddress: ME,
    minOut: 2_980_000n,
    slippageBps: 50,
    approvalSpender: "0xrouter",
    nativeFee: 0n,
  },
  expectedOut: 2_995_000n,
  signer,
  onSettled,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (id: string) => getSwaps().find((s) => s.id === id || s.localId === id);

describe("startSwap", () => {
  beforeEach(async () => {
    await loadSwaps();
  });

  it("starts the record at the engine's first step, follows it, and hands over to the broadcast swap", async () => {
    let finish!: (v: unknown) => void;
    let phase!: Phase;
    exec.run = (onPhase) => {
      phase = onPhase;
      return new Promise((resolve) => {
        finish = resolve;
        onPhase("approving", {total: 2});
      });
    };
    const settled = vi.fn();
    const id = await startSwap(input(settled));
    expect(id).toMatch(/^local\./);
    expect(find(id)).toMatchObject({
      status: "submitting",
      stage: "approving",
      approvals: 2,
      mode: "wallet",
      accountId: `evm:${ME}`,
      fromKey: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
    });
    expect(find(id)!.heartbeatAt).toBeGreaterThan(0);

    phase("signing");
    expect(find(id)).toMatchObject({stage: "signing", approved: true});

    finish({id: "awk1.lifi.lifi%3A1.0xhash", hash: "0xhash"});
    await flush();
    const done = find(id)!;
    expect(done).toMatchObject({id: "awk1.lifi.lifi%3A1.0xhash", status: "pending", sourceHash: "0xhash", localId: id});
    expect(getSwaps().filter((s) => s.localId === id)).toHaveLength(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("keeps the hash the engine names at broadcast, so a tab that dies before the engine returns leaves a sent record", async () => {
    let phase!: Phase;
    exec.run = (onPhase) => {
      phase = onPhase;
      return new Promise(() => onPhase("signing")); // hangs like a slow notifyDeposit
    };
    const id = await startSwap(input());
    phase("broadcast", {hash: "0xbroadcast"});
    expect(find(id)).toMatchObject({status: "submitting", stage: "broadcast", sourceHash: "0xbroadcast"});
    // The page dies here; the next load sweeps with nothing running.
    const [after] = markInterrupted([find(id)!], new Set(), Date.now() + 31_000);
    expect(after).toMatchObject({status: "pending", maybeSent: true, sourceHash: "0xbroadcast", error: INTERRUPTED_SENT_TEXT});
  });

  it("a failure after the broadcast step is tracked as maybe-sent, never not-sent", async () => {
    exec.run = (onPhase) =>
      new Promise((_, reject) => {
        onPhase("signing");
        onPhase("broadcast", {hash: "0xlate"});
        setTimeout(() => reject(new Error("something after the broadcast broke")), 0);
      });
    const id = await startSwap(input());
    await flush();
    await flush();
    expect(find(id)).toMatchObject({status: "pending", maybeSent: true, sourceHash: "0xlate"});
  });

  it("rejects what fails before the first step — nothing is recorded", async () => {
    exec.run = async () => {
      throw new SwapReviewMismatch("the recipient changed");
    };
    const before = getSwaps().length;
    await expect(startSwap(input())).rejects.toThrow("the recipient changed");
    expect(getSwaps()).toHaveLength(before);
  });

  it("a stop after the first step becomes not-sent with the reason in the user's words", async () => {
    exec.run = (onPhase) =>
      new Promise((_, reject) => {
        onPhase("approving");
        setTimeout(() => reject(Object.assign(new Error("User rejected the request."), {code: 4001})), 0);
      });
    const id = await startSwap(input());
    await flush();
    await flush();
    expect(find(id)).toMatchObject({status: "not-sent", error: "You declined in your wallet — nothing was sent."});
  });

  it("a maybe-sent broadcast is tracked, never offered again", async () => {
    exec.run = (onPhase) =>
      new Promise((_, reject) => {
        onPhase("signing");
        setTimeout(() => reject(new Swap2MaybeSentError("swap2: lost", "0xm", "awk1.near_intents.q.0xm")), 0);
      });
    const id = await startSwap(input());
    await flush();
    await flush();
    expect(find(id)).toMatchObject({id: "awk1.near_intents.q.0xm", status: "pending", maybeSent: true, sourceHash: "0xm"});
  });

  describe("a Permit2 venue's token sale (0x, D38): its first signature is the permit, not the swap", () => {
    const zeroex = (over: Partial<StartSwapInput["reviewed"]> = {}): StartSwapInput => {
      const base = input();
      return {...base, reviewed: {...base.reviewed, provider: "zeroex", approvalSpender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", ...over}};
    };

    it("permit → approve → preflight → the swap's own signing → broadcast, each read as what the wallet is asked", async () => {
      let phase!: Phase;
      let finish!: (v: unknown) => void;
      exec.run = (onPhase) => {
        phase = onPhase;
        return new Promise((resolve) => {
          finish = resolve;
          onPhase("signing");
        });
      };
      const id = await startSwap(zeroex());
      expect(find(id)).toMatchObject({status: "submitting", stage: "permit", permit: true, approvals: 1});
      phase("approving", {total: 1});
      expect(find(id)).toMatchObject({stage: "approving", approved: false});
      phase("preflight");
      phase("signing");
      expect(find(id)).toMatchObject({stage: "signing", approved: true});
      phase("broadcast", {hash: "0xzx"});
      expect(find(id)).toMatchObject({stage: "broadcast", sourceHash: "0xzx"});
      finish({id: "awk1.zeroex.q.0xzx", hash: "0xzx"});
      await flush();
    });

    it("a standing Permit2 allowance (no approval) and a re-quote's new permit", async () => {
      let phase!: Phase;
      exec.run = (onPhase) => {
        phase = onPhase;
        return new Promise(() => onPhase("signing"));
      };
      const id = await startSwap(zeroex());
      phase("preflight");
      phase("signing");
      expect(find(id)).toMatchObject({stage: "signing", approved: false});

      const again = await startSwap(zeroex());
      phase("approving", {total: 1});
      phase("requoting");
      phase("signing");
      expect(find(again)).toMatchObject({stage: "permit", approved: true});
      phase("preflight");
      phase("signing");
      expect(find(again)).toMatchObject({stage: "signing"});
    });

    it("a native sale signs no permit; another venue's first signing stays the swap's", async () => {
      exec.run = (onPhase) => new Promise(() => onPhase("signing"));
      const native = await startSwap(zeroex({fromContract: null, approvalSpender: null}));
      expect(find(native)).toMatchObject({stage: "signing", approvals: 0});
      expect(find(native)!.permit).toBeUndefined();
      const lifi = await startSwap(input());
      expect(find(lifi)).toMatchObject({stage: "signing"});
      expect(find(lifi)!.permit).toBeUndefined();
    });

    it("a tab that closes while the wallet holds the permit swapped nothing: not-sent, never maybe-sent", async () => {
      exec.run = (onPhase) => new Promise(() => onPhase("signing"));
      const id = await startSwap(zeroex());
      const [after] = markInterrupted([find(id)!], new Set(), Date.now() + 31_000);
      expect(after).toMatchObject({status: "not-sent", error: INTERRUPTED_TEXT, approved: false});
      expect(after!.maybeSent).toBeUndefined();
    });

    it("a declined permit is not-sent, the steps failing at the permit and the approval never reached", async () => {
      exec.run = (onPhase) =>
        new Promise((_, reject) => {
          onPhase("signing");
          setTimeout(() => reject(Object.assign(new Error("User rejected the request."), {code: 4001})), 0);
        });
      const id = await startSwap(zeroex());
      await flush();
      await flush();
      const r = find(id)!;
      expect(r).toMatchObject({status: "not-sent", stage: "permit"});
      expect(swapSteps(r, "Ethereum").map((st) => [st.key, st.state])).toEqual([
        ["permit", "failed"],
        ["approve", "todo"],
        ["confirm", "todo"],
        ["swap", "todo"],
        ["deliver", "todo"],
      ]);
    });
  });

  it("a swap with no step (a gasless order) resolves with its id once sent", async () => {
    exec.run = async () => ({id: "awk1.omniston.o1"});
    const id = await startSwap(input());
    expect(id).toBe("awk1.omniston.o1");
    expect(find(id)).toMatchObject({status: "pending"});
  });
});

describe("watchSourceTx", () => {
  const record = async (id: string) => {
    exec.run = async () => ({id, hash: id.split(".")[3]});
    await startSwap(input());
  };

  it("a sped-up source transaction moves the record to the replacement's id", async () => {
    const id = "awk1.lifi.sp.0xold";
    await record(id);
    const pub = {
      waitForTransactionReceipt: async ({onReplaced}: {onReplaced: (r: unknown) => void}) => {
        onReplaced({reason: "repriced", transaction: {hash: "0xnew"}});
        return {status: "success"};
      },
    } as unknown as EvmSourceSigner["pub"];
    await watchSourceTx({pub}, id, "0xold");
    expect(find(id)).toBeUndefined();
    expect(find("awk1.lifi.sp.0xnew")).toMatchObject({sourceHash: "0xnew", status: "pending"});
  });

  it("a cancelled or reverted source transaction swapped nothing", async () => {
    const cancelled = "awk1.lifi.c.0xc";
    await record(cancelled);
    const pubCancel = {
      waitForTransactionReceipt: async ({onReplaced}: {onReplaced: (r: unknown) => void}) => {
        onReplaced({reason: "cancelled", transaction: {hash: "0xz"}});
        return {status: "success"};
      },
    } as unknown as EvmSourceSigner["pub"];
    await watchSourceTx({pub: pubCancel}, cancelled, "0xc");
    expect(find(cancelled)).toMatchObject({status: "not-sent", error: expect.stringMatching(/cancelled in your wallet/)});

    const reverted = "awk1.lifi.r.0xr";
    await record(reverted);
    const pubRevert = {waitForTransactionReceipt: async () => ({status: "reverted"})} as unknown as EvmSourceSigner["pub"];
    await watchSourceTx({pub: pubRevert}, reverted, "0xr");
    expect(find(reverted)).toMatchObject({status: "not-sent", error: expect.stringMatching(/failed on-chain/)});
  });
});

describe("watchTronTx", () => {
  const record = async (id: string) => {
    exec.run = async () => ({id, hash: id.split(".")[3]});
    await startSwap(input());
  };
  /** The Tron API's gettransactioninfobyid, answering `infos` in turn (an Error = the host failed). */
  const tronInfo = (infos: (unknown | Error)[]) => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const a = infos[Math.min(n++, infos.length - 1)];
        if (a instanceof Error) throw a;
        return new Response(JSON.stringify(a), {status: 200});
      }),
    );
  };
  const opts = {pollMs: 0, timeoutMs: 1_000, sleep: async () => {}};

  it("a TRC-20 transfer that ran out of energy swapped nothing; a successful one stays pending", async () => {
    const failed = "awk1.near_intents.t.aa11";
    await record(failed);
    tronInfo([{}, new Error("down"), {id: "aa11", blockNumber: 7, receipt: {result: "OUT_OF_ENERGY"}}]);
    await watchTronTx({apiUrls: ["https://tron.test"]}, failed, "aa11", opts);
    expect(find(failed)).toMatchObject({status: "not-sent", error: expect.stringMatching(/failed on-chain/)});

    const ok = "awk1.near_intents.t.bb22";
    await record(ok);
    tronInfo([{id: "bb22", blockNumber: 8, receipt: {result: "SUCCESS"}}]);
    await watchTronTx({apiUrls: ["https://tron.test"]}, ok, "bb22", opts);
    expect(find(ok)).toMatchObject({status: "pending"});
    vi.unstubAllGlobals();
  });
});
