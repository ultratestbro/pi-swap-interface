/** Test fixtures for the swap module: request tokens and in-process venues (no network). */
import type {Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapToken} from "../../../src/contracts/domain";
import type {QuoteRequest} from "../../../src/contracts/routes";

/** Anvil's well-known test account #1: never holds real funds. */
export const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export function token(over: Partial<SwapToken> & Pick<SwapToken, "caip2" | "chain" | "chainName" | "symbol">): SwapToken {
  return {
    key: `${over.chain}:${over.contract ? over.contract.toLowerCase() : "native"}`,
    family: "evm",
    catalogSymbol: over.symbol,
    decimals: 18,
    contract: null,
    gasToken: over.contract == null,
    amount: "0",
    balance: "loaded",
    usd: 0,
    owner: ME,
    payMode: "wallet",
    ...over,
  };
}

export const USDC_ARB = token({chain: "arbitrum", caip2: "eip155:42161", chainName: "Arbitrum", symbol: "USDC", decimals: 6, contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"});
export const USDC_BASE = token({chain: "base", caip2: "eip155:8453", chainName: "Base", symbol: "USDC", decimals: 6, contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"});
export const USDT_ETH = token({chain: "ethereum", caip2: "eip155:1", chainName: "Ethereum", symbol: "USDT", decimals: 6, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7"});
export const USDC_ETH = token({chain: "ethereum", caip2: "eip155:1", chainName: "Ethereum", symbol: "USDC", decimals: 6, contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"});

export const request = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: USDC_ARB,
  to: USDC_BASE,
  amountIn: 5_000_000n,
  slippageBps: 30,
  recipient: ME,
  refundAddress: ME,
  ...over,
});

export interface VenueOptions {
  /** Guaranteed (and expected) output; omit to refuse or throw. */
  min?: string;
  eta?: number;
  delayMs?: number;
  refuse?: string;
  /** The classification `refuse` is given with (onRefusal's second argument, swap2-core 0.12.0). */
  refuseReason?: Swap2RefusalReason;
  error?: string;
  /** Never settles and ignores its signal. */
  hang?: boolean;
  sameChain?: boolean;
  supports?: boolean;
  enabled?: boolean;
  gasLimit?: string;
  spender?: string;
  depositMemo?: string;
  noTx?: boolean;
}

export type FakeVenue = CrossChainProvider & {signals: (AbortSignal | undefined)[]; quotes: number; close: () => void; closed: number};

/** An in-process venue answering after `delayMs` (real timers), honouring its abort signal. */
export function venue(name: string, o: VenueOptions = {}): FakeVenue {
  const v: FakeVenue = {
    name,
    signals: [],
    quotes: 0,
    closed: 0,
    close: () => void v.closed++,
    ...(o.sameChain !== undefined ? {supportsSameChain: o.sameChain} : {}),
    enabled: () => o.enabled ?? true,
    supportsRoute: () => o.supports ?? true,
    getQuote: (params: QuoteParams, signal?: AbortSignal) => {
      v.quotes++;
      v.signals.push(signal);
      if (o.hang) return new Promise<Quote | null>(() => {});
      return new Promise<Quote | null>((resolve, reject) => {
        const t = setTimeout(() => {
          if (o.error) return reject(new Error(o.error));
          if (o.refuse || !o.min) {
            if (o.refuse) params.onRefusal?.(o.refuse, o.refuseReason ? {reason: o.refuseReason} : undefined);
            return resolve(null);
          }
          resolve({
            provider: name,
            intentId: `dry:${name}`,
            depositAddress: "",
            depositMemo: o.depositMemo ?? null,
            ...(o.noTx
              ? {}
              : {txRequest: {to: "0x00000000000000000000000000000000000000aa", data: "0x", value: "0", ...(o.gasLimit ? {gasLimit: o.gasLimit} : {}), ...(o.spender ? {approvalAddress: o.spender} : {})}}),
            sourceAmount: params.amountIn,
            destAmount: o.min,
            minDestAmount: o.min,
            feeUsd: 0,
            etaSeconds: o.eta ?? 30,
            reliability: 0.9,
            validUntilMs: Date.now() + 60_000,
          });
        }, o.delayMs ?? 0);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    },
    buildDeposit: async () => {
      throw new Error("not built in tests");
    },
    trackIntent: async () => ({state: "pending"}),
  };
  return v;
}
