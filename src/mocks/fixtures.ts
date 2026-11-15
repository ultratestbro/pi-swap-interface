/**
 * Realistic fixtures for demo mode, stubs and tests: a subset of the real
 * catalog (contracts and decimals from @anywalletkit/swap2-assets 0.3.0),
 * balances, prices, a route snapshot with three routes and one refusal, the
 * demo's refusals in the app's words, and an activity list covering every
 * drawer state. Amounts are base units.
 *
 * Addresses: the EVM one is anvil's public test account #1; the Solana one and
 * the BTC deposit address are made up and the deposit address is not even
 * valid, so nothing shown in demo mode can receive real funds.
 */
import type {SwapRecord} from "../contracts/activity";
import type {Balance, Chain, Owners, PriceMap, SwapToken, Token} from "../contracts/domain";
import type {RouteRejection, RouteSnapshot, WebRoute} from "../contracts/routes";
import {chainBySlug} from "../shared/chains";

export const DEMO_EVM_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const DEMO_SOLANA_ADDRESS = "DemoWa11et1111111111111111111111111111111";
/** Not a valid Tron address (no base58check): a demo connection can never be paid to. */
export const DEMO_TRON_ADDRESS = "TDemoWa11et11111111111111111111111";
/** Display only (no valid checksum): the demo TON wallet can never be paid. */
export const DEMO_TON_ADDRESS = "UQDemoWa11etTon0000000000000000000000000000000000";
/** Deliberately invalid: a demo QR must never be payable. */
export const DEMO_DEPOSIT_ADDRESS = "demo-address-do-not-send";

const SLUGS = ["ethereum", "arbitrum", "base", "solana", "bitcoin", "elysium"] as const;

/** Six networks of the real catalog, display order. */
export const DEMO_CHAINS: readonly Chain[] = SLUGS.map((slug) => {
  const c = chainBySlug(slug)!;
  return {...c, catalogKey: slug, memo: false, receiveOnly: false};
});

const t = (slug: string, symbol: string, decimals: number, contract: string | null, catalogSymbol = symbol): Token => {
  const chain = DEMO_CHAINS.find((c) => c.slug === slug)!;
  return {
    key: `${slug}:${contract ? contract.toLowerCase() : "native"}`,
    chain: slug,
    caip2: chain.caip2,
    chainName: chain.name,
    family: chain.family,
    symbol,
    catalogSymbol,
    decimals,
    contract,
    gasToken: contract === null,
  };
};

export const DEMO_TOKENS: readonly Token[] = [
  t("ethereum", "ETH", 18, null),
  t("ethereum", "USDC", 6, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  t("ethereum", "USDT", 6, "0xdac17f958d2ee523a2206206994597c13d831ec7"),
  t("arbitrum", "ETH", 18, null),
  t("arbitrum", "USDC", 6, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  t("arbitrum", "USDT0", 6, "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"),
  t("base", "ETH", 18, null),
  t("base", "USDC", 6, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  t("solana", "SOL", 9, null),
  t("solana", "USDC", 6, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  t("bitcoin", "BTC", 8, null),
  t("elysium", "HYPE", 18, null),
  t("elysium", "USDC.e", 6, "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65"),
];

/**
 * What a demo import "reads" (D39), offline: a long-tail token on Base, and a copy on Base named like the listed USDC
 * (the confirmation's look-alike line). Any other address reads as "not found" — demo mode contacts no network.
 */
const imported = (slug: string, symbol: string, name: string, decimals: number, contract: string): Token => ({...t(slug, symbol, decimals, contract, contract), gasToken: false, imported: true, name});

export const DEMO_IMPORTABLE: readonly Token[] = [
  imported("base", "DEGEN", "Degen", 18, "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"),
  imported("base", "USDC", "USD Coin", 6, "0x1111111111111111111111111111111111111111"),
];

export const DEMO_PRICES: PriceMap = {
  ETH: 3120.55,
  WETH: 3120.55,
  USDC: 1,
  "USDC.e": 1,
  USDT: 1,
  USDT0: 1,
  SOL: 168.4,
  BTC: 96950,
  HYPE: 38.2,
};

const keyOf = (slug: string, symbol: string) => DEMO_TOKENS.find((x) => x.chain === slug && x.symbol === symbol)!.key;
const bal = (rows: [slug: string, symbol: string, amount: string][]): Readonly<Record<string, Balance>> =>
  Object.fromEntries(rows.map(([slug, symbol, amount]) => [keyOf(slug, symbol), {amount, state: "loaded"} satisfies Balance]));

/** Balances by token key, per family (what a connected wallet would read). */
export const DEMO_BALANCES: Readonly<Record<"evm" | "solana", Readonly<Record<string, Balance>>>> = {
  evm: bal([
    ["ethereum", "ETH", "12000000000000000"],
    ["ethereum", "USDT", "300000000"],
    ["arbitrum", "ETH", "421300000000000000"],
    ["arbitrum", "USDC", "1250420000"],
    ["base", "ETH", "52500000000000000"],
    ["elysium", "HYPE", "3150000000000000000"],
  ]),
  solana: bal([
    ["solana", "SOL", "3200000000"],
    ["solana", "USDC", "85500000"],
  ]),
};

const SIGNING = new Set(["evm", "solana", "tron", "ton"]);
/** Signing families that pay by QR while no wallet is connected (catalog QR_FALLBACK_FAMILIES). */
const QR_FALLBACK = new Set(["tron", "ton"]);

/** Tokens with the viewer's state, held first — the shape catalog's useSwapTokens returns. */
export function demoSwapTokens(owners: Owners, prices: PriceMap = DEMO_PRICES): SwapToken[] {
  const out = DEMO_TOKENS.map((tok): SwapToken => {
    const owner = owners[tok.family] ?? null;
    const fam = tok.family === "evm" || tok.family === "solana" ? tok.family : null;
    const b = owner && fam ? DEMO_BALANCES[fam][tok.key] : undefined;
    const priceUsd = prices[tok.symbol] ?? prices[tok.catalogSymbol];
    const amount = owner ? (b?.amount ?? "0") : "0";
    const usd = priceUsd !== undefined ? (Number(amount) / 10 ** tok.decimals) * priceUsd : 0;
    return {
      ...tok,
      amount,
      balance: owner ? "loaded" : "none",
      ...(priceUsd !== undefined ? {priceUsd} : {}),
      usd,
      owner,
      payMode: SIGNING.has(tok.family) ? (owner ? "wallet" : QR_FALLBACK.has(tok.family) ? "deposit" : "connect") : "deposit",
    };
  });
  const held = out.filter((x) => x.amount !== "0").sort((a, b) => b.usd - a.usd);
  return [...held, ...out.filter((x) => x.amount === "0")];
}

const route = (r: Partial<WebRoute> & Pick<WebRoute, "provider" | "destAmount" | "minDestAmount" | "etaSeconds">): WebRoute => ({
  sourceAmount: 1_000_000_000n,
  feeUsd: 0,
  fees: [],
  tags: [],
  relativeValue: 1,
  netValueUsd: null,
  approvalSpender: null,
  nativeFee: 0n,
  validUntilMs: 0,
  gasUsd: null,
  execution: "calldata",
  hasMemo: false,
  trust: "provider-api",
  ...r,
});

/** The venues a page builds by default (swap DEFAULT_ON_PROVIDERS, D3): the demo's `venues`. */
export const DEMO_VENUES: readonly string[] = [
  "uniswap",
  "curve",
  "balancer",
  "wrap",
  "usdt0",
  "cctp",
  "thorchain",
  "chainflip",
  "near_intents",
  "lifi",
  "relay",
  "symbiosis",
  "jupiter",
  "omniston",
];

/**
 * Demo refusals, worded exactly as src/swap/refusals.ts words the SDK text in `raw` (tests/unit/swap/refusals.test.ts
 * keeps them equal): a timeout, LI.FI's "pays someone else" safety skip, Chainflip's minimums, and Omniston's two
 * "not this pair" answers.
 */
export const DEMO_REFUSALS = {
  timeout: {
    reason: "Didn't answer in time — tap refresh",
    category: "unreachable",
    detail: "It took longer than the quote round allows, so the list went on without it.",
    raw: "quote timed out after 8000ms",
  },
  paysElsewhere: {
    reason: "Can't confirm it pays you",
    category: "safety",
    detail: "We check every route's transaction before showing it. This one could pay an address we couldn't confirm is yours, so we left it out.",
    raw: `the transaction does not match the quote: pays 0x1111111111111111111111111111111111111111, not ${DEMO_EVM_ADDRESS}`,
  },
  minimumEth: {reason: "Minimum 0.01 ETH", category: "amount", detail: "Below this venue's minimum for the pair.", raw: "below the minimum deposit (10000000000000000 ETH)"},
  minimumUsdc: {reason: "Minimum 20 USDC", category: "amount", detail: "Below this venue's minimum for the pair.", raw: "below the minimum deposit (20000000 USDC)"},
  nativeLeg: {
    reason: "Doesn't move native coins across networks",
    category: "pair",
    detail: "Between networks it carries tokens only, not the native coin.",
    raw: "cross-chain orders are token corridors only (no ETH native leg)",
  },
  noResolver: {
    reason: "No route for this pair or amount",
    category: "pair",
    detail: "It found no way to make this swap right now — another amount may work.",
    raw: "no resolver quoted this route/amount",
  },
  // Preview rounds (D7): LI.FI waits for the live quote (demo has no cp0x proxy to ask it through; the screen words the
  // short line for what is missing); a venue that pays only the signer sits out "another address".
  liveOnly: {
    reason: "Connect a wallet to get this quote",
    category: "deferred",
    detail: "Preview prices skip it here to save its request limit for your own quote — it's asked as soon as your wallet is connected or your address is entered.",
    raw: "asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key",
  },
  signerOnly: {
    reason: "Pays only the wallet that signs",
    category: "setup",
    detail: 'It always pays the wallet that signs — turn off "Send to another address" to use it.',
    raw: "the recipient must be the signing wallet (it pays only the wallet that signs)",
  },
} as const satisfies Readonly<Record<string, Omit<RouteRejection, "provider">>>;

/**
 * 1 000 USDC Arbitrum → Base, scaled from the 2026-11-11 live probe (providers.md §8): CCTP best, NEAR Intents,
 * Relay fastest; LI.FI timed out. Symbiosis and Omniston, on by default since 2026-11-12, serve the pair too: Symbiosis
 * (paced, up to four tries) ran out of the round's time and no Omniston resolver quoted. validUntilMs is stamped
 * from `now`.
 */
export function demoSnapshot(now = Date.now()): RouteSnapshot {
  const until = now + 60_000;
  return {
    mode: "live",
    routes: [
      route({
        provider: "cctp",
        destAmount: 999_846_000n,
        minDestAmount: 999_846_000n,
        etaSeconds: 45,
        tags: ["best"],
        relativeValue: 1,
        netValueUsd: 999.82,
        approvalSpender: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
        validUntilMs: until,
        gasUsd: 0.03,
        trust: "contracts",
      }),
      route({
        provider: "near_intents",
        destAmount: 999_326_000n,
        minDestAmount: 989_332_600n,
        etaSeconds: 27,
        relativeValue: 0.9895,
        netValueUsd: 989.32,
        validUntilMs: until,
        gasUsd: 0.01,
        execution: "deposit",
      }),
      route({
        provider: "relay",
        destAmount: 995_673_000n,
        minDestAmount: 985_716_400n,
        etaSeconds: 2,
        tags: ["fastest"],
        relativeValue: 0.9859,
        netValueUsd: 985.68,
        approvalSpender: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
        validUntilMs: until,
        gasUsd: 0.04,
      }),
    ],
    pending: [],
    rejections: [
      {provider: "lifi", ...DEMO_REFUSALS.timeout},
      {provider: "symbiosis", ...DEMO_REFUSALS.timeout},
      {provider: "omniston", ...DEMO_REFUSALS.noResolver},
    ],
    asked: ["cctp", "near_intents", "relay", "lifi", "symbiosis", "omniston"],
    venues: [...DEMO_VENUES],
  };
}

const hex = (seed: string, len = 64) => `0x${seed.repeat(Math.ceil(len / seed.length)).slice(0, len)}`;

const rec = (r: Partial<SwapRecord> & Pick<SwapRecord, "id" | "provider" | "status" | "createdAt">): SwapRecord => ({
  accountId: `evm:${DEMO_EVM_ADDRESS}`,
  fromChain: "eip155:42161",
  fromSlug: "arbitrum",
  toChain: "eip155:8453",
  toSlug: "base",
  fromSymbol: "USDC",
  fromDecimals: 6,
  toSymbol: "USDC",
  toDecimals: 6,
  amountIn: "250000000",
  expectedOut: "249961500",
  minOut: "248711700",
  recipient: DEMO_EVM_ADDRESS,
  updatedAt: r.createdAt,
  checkedAt: r.createdAt,
  failures: 0,
  ...r,
});

/** One record per drawer state: claim needed, waiting for a QR deposit, in progress, completed, not sent. */
export function demoActivity(now = Date.now()): SwapRecord[] {
  const min = 60_000;
  return [
    rec({
      id: `awk1.cctp.${hex("c7")}.${hex("a1")}`,
      provider: "cctp",
      status: "action-required",
      createdAt: now - 20 * min,
      fromChain: "eip155:1",
      fromSlug: "ethereum",
      amountIn: "500000000",
      expectedOut: "499920000",
      minOut: "499920000",
      sourceHash: hex("a1"),
      fromKey: "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      toKey: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    }),
    rec({
      id: `awk1.near_intents.${hex("b7", 40)}`,
      accountId: "deposit:bc1qdemorefund",
      provider: "near_intents",
      status: "pending",
      mode: "deposit",
      createdAt: now - 2 * min,
      fromChain: "bitcoin:mainnet",
      fromSlug: "bitcoin",
      fromSymbol: "BTC",
      fromDecimals: 8,
      toChain: "eip155:42161",
      toSlug: "arbitrum",
      amountIn: "1500000",
      expectedOut: "1452100000",
      minOut: "1437500000",
      deposit: {address: DEMO_DEPOSIT_ADDRESS, memo: null, amount: "1500000", validUntilMs: now + 18 * min},
    }),
    rec({
      id: `awk1.relay.${hex("e1")}.${hex("5e")}`,
      provider: "relay",
      status: "pending",
      createdAt: now - 1 * min,
      sourceHash: hex("5e"),
      toChain: "solana:mainnet",
      toSlug: "solana",
      toSymbol: "SOL",
      toDecimals: 9,
      expectedOut: "1480000000",
      minOut: "1465000000",
      recipient: DEMO_SOLANA_ADDRESS,
    }),
    rec({
      id: `awk1.lifi.${hex("f0")}.${hex("9d")}`,
      provider: "lifi",
      status: "completed",
      createdAt: now - 25 * min,
      updatedAt: now - 23 * min,
      fromChain: "eip155:8453",
      fromSlug: "base",
      fromSymbol: "ETH",
      fromDecimals: 18,
      toChain: "eip155:42161",
      toSlug: "arbitrum",
      amountIn: "40000000000000000",
      expectedOut: "124700000",
      minOut: "124080000",
      sourceHash: hex("9d"),
      destHash: hex("4a"),
    }),
    rec({
      id: "local.1762870000000",
      localId: "local.1762870000000",
      provider: "uniswap",
      status: "not-sent",
      createdAt: now - 60 * min,
      fromChain: "eip155:8453",
      fromSlug: "base",
      toChain: "eip155:8453",
      toSlug: "base",
      toSymbol: "ETH",
      toDecimals: 18,
      expectedOut: "80100000000000000",
      minOut: "79700000000000000",
      error: "You declined in your wallet — nothing was sent.",
    }),
  ];
}
