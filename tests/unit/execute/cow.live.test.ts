// @vitest-environment node
/**
 * Live CoW execution up to the wallet (opt-in: SWAP_LIVE=1, D48). The page's CoW provider (its gap and cool-down
 * wrappers, which must carry `applyPermit`) quotes a real order on Base for an account that holds the token; the
 * engine builds the plan, checkPlanBrowser and planWrites arm the in-page gate, and the wallet — a fake that REJECTS
 * every request (EIP-1193 4001) — records what the gate let through. Nothing is signed, sent or placed. COW_OWNER: an
 * EOA holding at least 5 USDC on Base (reads only).
 */
import {describe, expect, it} from "vitest";
import {CrossChainRouter, RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router";
import {WalletAccountReadOnlyEvm} from "@anywalletkit/wallet-evm";
import {GPV2_VAULT_RELAYER} from "@anywalletkit/protocol-swap2-core";
import {cowProvider} from "@anywalletkit/protocol-swap2-cow/provider";
import {COW_ETH_FLOW} from "@anywalletkit/protocol-swap2-cow";
import type {ReviewedSwap} from "../../../src/contracts/execution";
import {coolDownOnRateLimit, withQuoteGap} from "../../../src/swap/providerWrappers";
import {checkPlanBrowser, createSwapGate, planWrites, SwapReviewMismatch} from "../../../src/execute/gate";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {engineConfig} from "../../../src/execute/execute";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";

const LIVE = process.env.SWAP_LIVE === "1";
const DEFAULT_OWNER = process.env.COW_OWNER ?? "0x0f0067cd819cB8F20BDa62046dAFF7a2b5c88280";
const RPC = process.env.BASE_RPC ?? "https://base-rpc.publicnode.com";
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

/** `signer`: a throwaway key that signs the permit (it holds nothing, so the permit moves nothing); the order is still rejected. */
async function run(fromContract: string | null, destToken: string, amountIn: bigint, minOut: bigint, signer?: ReturnType<typeof privateKeyToAccount>) {
  const OWNER = signer?.address ?? DEFAULT_OWNER;
  const provider = coolDownOnRateLimit(withQuoteGap(cowProvider({enabled: true, rpcUrls: {8453: [RPC]}, appCode: "cp0x Swap"}), 1100));
  const router = new CrossChainRouter([provider], {});
  const reads = new WalletAccountReadOnlyEvm(OWNER, {provider: [RPC], chainId: 8453});
  const asked: {method: string; what: string}[] = [];
  const reject = (method: string, what: string): never => {
    asked.push({method, what});
    throw Object.assign(new Error("User rejected the request (live test)"), {code: 4001});
  };
  const raw = {
    getAddress: async () => OWNER,
    getChainId: async () => 8453,
    getBalance: () => reads.getBalance(),
    getAllowance: (t: string, s: string) => reads.getAllowance(t, s),
    getTokenInfo: (t: string) => reads.getTokenInfo(t),
    quoteSendTransaction: async () => ({fee: 1_000_000_000_000n}),
    sendTransaction: async (tx: {to: string; data?: string}) => reject("sendTransaction", `${tx.to} ${String(tx.data).slice(0, 10)}`),
    waitForTransaction: async () => {},
    signTypedData: async (td: {domain: unknown; types: unknown; primaryType?: string; message: unknown}) => {
      if (signer && td.primaryType === "Permit") {
        asked.push({method: "signTypedData", what: "Permit (signed by the throwaway key)"});
        return signer.signTypedData({domain: td.domain, types: td.types, primaryType: "Permit", message: td.message} as Parameters<typeof signer.signTypedData>[0]);
      }
      return reject("signTypedData", String(td.primaryType));
    },
  };
  const signs: string[] = [];
  const gate = createSwapGate(BASE, (k) => signs.push(k));
  const reviewed: ReviewedSwap = {
    provider: "cow",
    fromChain: BASE,
    fromContract,
    amountIn,
    destChain: BASE,
    destToken,
    recipient: OWNER,
    refundAddress: OWNER,
    minOut,
    slippageBps: 50,
    approvalSpender: fromContract ? GPV2_VAULT_RELAYER : null,
    nativeFee: 0n,
  };
  let plan: {approvals: number; permits: number; source: string} | undefined;
  const protocol = new RouterSwap2Protocol(
    gateAccount(raw as never, gate) as never,
    engineConfig({
      fromChain: BASE,
      router: router.only("cow"),
      reviewExecution: (p) => {
        plan = {approvals: p.approvals.length, permits: p.permits?.length ?? 0, source: p.source.kind};
        const why = checkPlanBrowser(p, reviewed, {kind: "gpv2"});
        if (why) throw new SwapReviewMismatch(why);
        gate.arm(planWrites(p, undefined, reviewed).writes);
      },
    }),
  );
  const error = await protocol
    .swap2({fromToken: fromContract ?? "ETH", toToken: destToken, fromTokenAmount: amountIn, recipient: OWNER, refundAddress: OWNER, minAmountOut: minOut, slippage: 0.005})
    .then(() => null, (e: unknown) => e as Error);
  return {error, asked, signs, plan};
}

describe.skipIf(!LIVE)("live: a CoW order reaches the wallet only through the gate", () => {
  it("USDC → WETH on Base: the permit (USDC has one) or the approval, then nothing past a rejection", async () => {
    const r = await run(USDC, WETH, 5_000_000n, 1n);
    console.log(JSON.stringify({plan: r.plan, asked: r.asked, signs: r.signs, error: r.error?.message.slice(0, 160)}));
    expect(r.plan?.source).toBe("typed-order");
    // The first wallet request is the permit (gas-free) or the exact approval to the vault relayer — let through by the gate.
    expect(r.asked.length).toBe(1);
    expect(r.asked[0]!.method === "signTypedData" ? r.asked[0]!.what === "Permit" : r.asked[0]!.what.startsWith(USDC)).toBe(true);
    expect(r.error?.message).toMatch(/reject/i);
  }, 90_000);

  it("a signed permit, then the order carrying it (another appData) — rejected at the wallet", async () => {
    const r = await run(USDC, WETH, 5_000_000n, 1n, privateKeyToAccount(generatePrivateKey()));
    console.log(JSON.stringify({plan: r.plan, asked: r.asked, signs: r.signs, error: r.error?.message.slice(0, 160)}));
    if (r.plan?.permits !== 1) return; // the orderbook didn't offer this empty account a permit: nothing to prove here
    expect(r.signs).toEqual(["gpv2Permit", "gpv2Order"]);
    expect(r.asked.map((a) => a.what)).toEqual(["Permit (signed by the throwaway key)", "Order"]);
    expect(r.error?.message).toMatch(/reject/i);
  }, 90_000);

  it("ETH → USDC on Base: one eth-flow createOrder", async () => {
    const r = await run(null, USDC, 1_000_000_000_000_000n, 1n);
    console.log(JSON.stringify({plan: r.plan, asked: r.asked, error: r.error?.message.slice(0, 160)}));
    expect(r.plan?.source).toBe("call");
    expect(r.asked).toEqual([{method: "sendTransaction", what: `${COW_ETH_FLOW} 0x322bba21`}]);
  }, 90_000);
});
