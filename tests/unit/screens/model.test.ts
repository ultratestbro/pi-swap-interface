import {describe, expect, it} from "vitest";
import type {SwapToken} from "../../../src/contracts/domain";
import type {RouteRejection, RouteSnapshot, RoutesRequest, RoutesState, WebRoute} from "../../../src/contracts/routes";
import {DEMO_EVM_ADDRESS, demoSnapshot, demoSwapTokens} from "../../../src/mocks";
import {
  buildPreview,
  buildRequest,
  coverageLine,
  ctaState,
  deferredCopy,
  foldShownList,
  heldAs,
  heldRoutes,
  idleHint,
  listKey,
  qrRefusal,
  routeListModel,
  routesStatus,
  stillQuoting,
  tonWalletRefusal,
  venuesUnreachable,
  type FormFields,
  type ShownList,
} from "../../../src/screens/form/model";
import {agoLabel, plainUnits} from "../../../src/screens/labels";
import {sceneFrom, scenePreset} from "../../../src/screens/scenes";
import {addCustomRpc, connectionStatusText, removeCustomRpc, standardOnlyNote, urlLines} from "../../../src/screens/settings/store";
import {routeName, routesKey, providerName as venueName} from "../../../src/swap";
import {parseSlippage, slippageText} from "../../../src/screens/form/FormParts";
import {depositUri} from "../../../src/screens/review/DepositPanel";

const evmOnly = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
const none = demoSwapTokens({});
const tok = (list: readonly SwapToken[], key: string) => list.find((t) => t.key === key)!;
const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BTC = "bitcoin:native";
const BTC_REFUND = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const fields = (over: Partial<FormFields>): FormFields => ({
  from: tok(evmOnly, ARB_USDC),
  to: tok(evmOnly, BASE_USDC),
  amountIn: 250_000_000n,
  slippageBps: 30,
  loadingTokens: false,
  recipientOn: false,
  toOther: false,
  recipient: null,
  refund: null,
  ...over,
});

const providerName = (p: string) => ({cctp: "Circle CCTP", near_intents: "NEAR Intents", relay: "Relay", lifi: "LI.FI"})[p] ?? p;

describe("buildRequest (D7: no request without both explicit addresses)", () => {
  it("wallet payer + own receive wallet: both addresses are the connected one", () => {
    const {req, missing} = buildRequest(fields({}));
    expect(missing).toBeNull();
    expect(req?.refundAddress).toBe(DEMO_EVM_ADDRESS);
    expect(req?.recipient).toBe(DEMO_EVM_ADDRESS);
  });

  it("no wallet on the pay family → connect", () => {
    const {req, missing} = buildRequest(fields({from: tok(none, ARB_USDC), to: tok(none, BASE_USDC)}));
    expect(req).toBeNull();
    expect(missing).toEqual({kind: "connect", family: "evm"});
  });

  it("no amount → amount (after connect)", () => {
    expect(buildRequest(fields({amountIn: null})).missing).toEqual({kind: "amount"});
    expect(buildRequest(fields({amountIn: 0n})).missing).toEqual({kind: "amount"});
  });

  it("deposit payer needs a valid refund address of its family", () => {
    const from = tok(evmOnly, BTC);
    expect(buildRequest(fields({from, refund: {kind: "empty"}})).missing).toEqual({kind: "refund", chainName: "Bitcoin", invalid: false});
    expect(buildRequest(fields({from, refund: {kind: "invalid", reason: "x"}})).missing).toMatchObject({kind: "refund", invalid: true});
    const ok = buildRequest(fields({from, refund: {kind: "address", address: BTC_REFUND}}));
    expect(ok.missing).toBeNull();
    expect(ok.req?.refundAddress).toBe(BTC_REFUND);
  });

  it("receive family without a wallet forces the recipient field", () => {
    const to = tok(evmOnly, BTC);
    const missing = buildRequest(fields({to, recipientOn: true, recipient: {kind: "empty"}})).missing;
    expect(missing).toEqual({kind: "recipient", chainName: "Bitcoin", invalid: false, canConnect: false});
    const solTo = tok(evmOnly, "solana:native");
    expect(buildRequest(fields({to: solTo, recipientOn: true, recipient: {kind: "empty"}})).missing).toMatchObject({canConnect: true});
    const ok = buildRequest(fields({to, recipientOn: true, recipient: {kind: "ok", address: BTC_REFUND}}));
    expect(ok.req?.recipient).toBe(BTC_REFUND);
  });

  it("another address replaces the own one only when valid", () => {
    expect(buildRequest(fields({recipientOn: true, recipient: {kind: "invalid", reason: "x"}})).missing).toMatchObject({kind: "recipient", invalid: true});
  });
});

describe("buildPreview (D7: prices before an address exists, never a placeholder in the request)", () => {
  const preview = (over: Partial<FormFields>) => {
    const f = fields(over);
    return buildPreview(f, buildRequest(f).missing, true);
  };

  it("no wallet + amount: a preview with no address at all (the engine fills per venue)", () => {
    const p = preview({from: tok(none, ARB_USDC), to: tok(none, BASE_USDC), recipientOn: true, recipient: {kind: "empty"}});
    expect(p).toEqual({preview: true, from: tok(none, ARB_USDC), to: tok(none, BASE_USDC), amountIn: 250_000_000n, slippageBps: 30, toOther: false});
    expect(p).not.toHaveProperty("recipient");
    expect(p).not.toHaveProperty("refundAddress");
  });

  it("carries the real addresses it has: the connected payer, a valid typed recipient or refund", () => {
    const to = tok(evmOnly, BTC);
    expect(preview({to, recipientOn: true, recipient: {kind: "empty"}})).toMatchObject({refundAddress: DEMO_EVM_ADDRESS});
    expect(preview({to, recipientOn: true, recipient: {kind: "empty"}})).not.toHaveProperty("recipient");
    const qr = preview({from: tok(evmOnly, BTC), refund: {kind: "empty"}});
    expect(qr).toMatchObject({recipient: DEMO_EVM_ADDRESS});
    expect(qr).not.toHaveProperty("refundAddress");
    const typed = preview({from: tok(none, ARB_USDC), to: tok(none, BASE_USDC), recipientOn: true, toOther: true, recipient: {kind: "ok", address: DEMO_EVM_ADDRESS}});
    expect(typed).toMatchObject({recipient: DEMO_EVM_ADDRESS, toOther: true});
  });

  it("none without an amount, while live, when previews are off, or for a family without a sample (NEAR)", () => {
    const noWallet = {from: tok(none, ARB_USDC), to: tok(none, BASE_USDC)};
    expect(preview({...noWallet, amountIn: null})).toBeNull();
    expect(preview({})).toBeNull();
    const f = fields(noWallet);
    expect(buildPreview(f, buildRequest(f).missing, false)).toBeNull();
    const near: SwapToken = {...tok(evmOnly, BTC), key: "near:native", chain: "near", chainName: "NEAR", family: "near", symbol: "NEAR", owner: null};
    expect(preview({to: near, recipientOn: true, recipient: {kind: "empty"}})).toBeNull();
  });
});

describe("idleHint", () => {
  it("names exactly what is missing", () => {
    expect(idleHint({kind: "tokens", loading: true})).toBe("Loading your tokens…");
    expect(idleHint({kind: "connect", family: "evm"})).toBe("Connect a wallet to see routes");
    expect(idleHint({kind: "connect", family: "evm"}, true)).toBe("Enter an amount to see routes from every venue.");
    expect(idleHint({kind: "amount"})).toBe("Enter an amount to see routes from every venue.");
    expect(idleHint({kind: "refund", chainName: "Bitcoin", invalid: false})).toBe("Enter the Bitcoin refund address to see routes");
    expect(idleHint({kind: "recipient", chainName: "Solana", invalid: false, canConnect: true})).toBe("Connect a wallet or paste the Solana address to see routes");
    expect(idleHint({kind: "recipient", chainName: "Bitcoin", invalid: true, canConnect: false})).toBe("Enter a valid Bitcoin address to see routes");
  });
});

describe("ctaState", () => {
  const route = demoSnapshot().routes[0]!;
  const base = {missing: null, from: tok(evmOnly, ARB_USDC), balanceProblem: null, routesLoading: false, chosen: route, providerName};
  it("walks connect → amount → address → balance → routes → review", () => {
    expect(ctaState({...base, missing: {kind: "connect", family: "solana"}})).toMatchObject({label: "Connect Solana wallet to swap", enabled: true, action: "connect", family: "solana"});
    expect(ctaState({...base, missing: {kind: "amount"}})).toMatchObject({label: "Enter an amount", enabled: false});
    expect(ctaState({...base, missing: {kind: "refund", chainName: "Bitcoin", invalid: false}})).toMatchObject({label: "Enter the Bitcoin refund address to swap", enabled: false});
    expect(ctaState({...base, missing: {kind: "recipient", chainName: "Base", invalid: false, canConnect: true}})).toMatchObject({label: "Enter the Base address to swap", enabled: false});
    expect(ctaState({...base, balanceProblem: "Insufficient balance"})).toMatchObject({label: "Insufficient USDC balance", enabled: false, state: "balance"});
    expect(ctaState({...base, chosen: undefined, routesLoading: true})).toMatchObject({label: "Finding routes…", enabled: false});
    expect(ctaState({...base, chosen: undefined})).toMatchObject({label: "No route for this amount", enabled: false});
    expect(ctaState(base)).toMatchObject({label: "Review via Circle CCTP", enabled: true, action: "review"});
    expect(ctaState({...base, from: tok(evmOnly, BTC)})).toMatchObject({label: "Get deposit address", enabled: true, action: "review"});
  });

  it("never 'review' on a preview list, whatever is chosen in it (D7)", () => {
    const missing = [
      {kind: "connect", family: "evm"},
      {kind: "refund", chainName: "Bitcoin", invalid: false},
      {kind: "recipient", chainName: "TON", invalid: false, canConnect: false},
      null,
    ] as const;
    for (const m of missing) for (const from of [tok(evmOnly, ARB_USDC), tok(evmOnly, BTC)]) {
      const cta = ctaState({...base, from, missing: m, preview: true});
      expect(cta.action).not.toBe("review");
      expect(cta.state).not.toBe("review");
    }
    expect(ctaState({...base, preview: true})).toMatchObject({label: "Getting your quote…", enabled: false, state: "finding"});
  });
});

describe("routeListModel / qrRefusal (D20)", () => {
  const snap: RouteSnapshot = {
    ...demoSnapshot(),
    routes: [
      ...demoSnapshot().routes,
      {...demoSnapshot().routes[1]!, provider: "thorchain", hasMemo: true, trust: "own-node"} as WebRoute,
    ],
  };
  it("a wallet payer sees every route", () => {
    const m = routeListModel(snap, tok(evmOnly, ARB_USDC));
    expect(m.routes.map((r) => r.provider)).toEqual(["cctp", "near_intents", "relay", "thorchain"]);
    expect(m.refused).toEqual(snap.rejections);
  });
  it("a QR payer gets only deposit routes without a memo; the rest are refused as 'a change on your side'", () => {
    const m = routeListModel(snap, tok(evmOnly, BTC));
    expect(m.routes.map((r) => r.provider)).toEqual(["near_intents"]);
    expect(m.refused.map((x) => x.provider)).toEqual(["cctp", "relay", "thorchain", "lifi", "symbiosis", "omniston"]);
    expect(m.refused[0]).toMatchObject({reason: "Needs a wallet that signs on Bitcoin", category: "setup"});
    expect(m.refused[2]).toMatchObject({reason: "Needs a memo — not for QR payments", category: "setup"});
    expect(m.refused[2]!.detail).toMatch(/memo many wallets can't add/);
    expect(m.refused.every((x) => x.reason.length <= 45 && x.raw.length > 0)).toBe(true);
    expect(qrRefusal(snap.routes[1]!, "Bitcoin")).toBeNull();
  });
  it("a TON wallet payer takes deposit routes, memo ones included; a contract-call route is refused", () => {
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", chainName: "TON", family: "ton", symbol: "TON", owner: "UQx", payMode: "wallet"};
    const m = routeListModel(snap, ton);
    expect(m.routes.map((r) => r.provider)).toEqual(["near_intents", "thorchain"]);
    expect(m.refused.map((x) => x.provider)).toEqual(["cctp", "relay", "lifi", "symbiosis", "omniston"]);
    expect(m.refused[0]).toMatchObject({reason: "TON contract calls aren't signed here yet", category: "setup"});
    expect(m.refused.every((x) => x.reason.length <= 45)).toBe(true);
    // Without a TON wallet it is a QR payer like any other.
    expect(routeListModel(snap, {...ton, owner: null, payMode: "deposit"}).routes.map((r) => r.provider)).toEqual(["near_intents"]);
  });
  it("a TON wallet paying USDT also takes Symbiosis' and Omniston's contract calls (checked byte for byte, D35); every other call stays refused", () => {
    const call = (provider: string) => ({...demoSnapshot().routes[0]!, provider, execution: "calldata"}) as WebRoute;
    const calls: RouteSnapshot = {...snap, routes: [...snap.routes, call("symbiosis"), call("omniston")], rejections: []};
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", chainName: "TON", family: "ton", symbol: "TON", owner: "UQx", payMode: "wallet"};
    const usdt: SwapToken = {...ton, key: "ton:usdt", symbol: "USDT", contract: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"};
    const arbUsdc = tok(evmOnly, ARB_USDC);
    const m = routeListModel(calls, usdt, arbUsdc);
    expect(m.routes.map((r) => r.provider)).toEqual(["near_intents", "thorchain", "symbiosis", "omniston"]);
    expect(m.refused.map((x) => x.provider)).toEqual(["cctp", "relay"]);
    expect(m.refused.at(-1)).toMatchObject({reason: "TON contract calls aren't signed here yet", category: "setup"});
    // Native TON, or a jetton without pinned wallet code: both venues' calls are refused too.
    expect(routeListModel(calls, ton, arbUsdc).refused.map((x) => x.provider)).toEqual(["cctp", "relay", "symbiosis", "omniston"]);
    const usde = {...usdt, contract: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f"};
    expect(routeListModel(calls, usde, arbUsdc).refused.map((x) => x.provider)).toEqual(["cctp", "relay", "symbiosis", "omniston"]);
    expect(tonWalletRefusal(call("symbiosis"), usdt, arbUsdc)).toBeNull();
    expect(tonWalletRefusal(call("symbiosis"), ton, arbUsdc)).not.toBeNull();
    expect(tonWalletRefusal(call("omniston"), usdt, arbUsdc)).toBeNull();
    expect(tonWalletRefusal(call("omniston"), ton, arbUsdc)).not.toBeNull();
  });
  it("Omniston from a TON wallet cross-chain is offered only as its escrow to a token on an EVM network: never a native coin or Tron", () => {
    const call = (provider: string) => ({...demoSnapshot().routes[0]!, provider, execution: "calldata"}) as WebRoute;
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", chainName: "TON", family: "ton", symbol: "TON", owner: "UQx", payMode: "wallet"};
    const usdt: SwapToken = {...ton, key: "ton:usdt", symbol: "USDT", contract: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"};
    const arbUsdc = tok(evmOnly, ARB_USDC);
    // A TON → TON swap whose quote names no route steps (no pinned DEX to check it against): refused (part C below).
    expect(tonWalletRefusal(call("omniston"), usdt, {caip2: "ton:-239", contract: null})).toMatchObject({reason: "Routed through a DEX that isn't pinned here"});
    expect(tonWalletRefusal(call("omniston"), usdt, {caip2: "ton:-239", contract: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f"})).not.toBeNull();
    // A native coin on arrival (Omniston's orders move tokens only), Tron, or no token yet.
    expect(tonWalletRefusal(call("omniston"), usdt, {...arbUsdc, contract: null})).not.toBeNull();
    expect(tonWalletRefusal(call("omniston"), usdt, {caip2: "tron:728126428", contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"})).not.toBeNull();
    expect(tonWalletRefusal(call("omniston"), usdt, undefined)).not.toBeNull();
  });
  it("Omniston's swap on TON is offered only between TON and USDT, one step through a pinned DEX by its quote's own route (D35 part C)", () => {
    const swap = (steps?: string[]) => ({...demoSnapshot().routes[0]!, provider: "omniston", execution: "calldata", ...(steps ? {tonSwapSteps: steps} : {})}) as WebRoute;
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", caip2: "ton:-239", chainName: "TON", family: "ton", symbol: "TON", contract: null, owner: "UQx", payMode: "wallet"};
    const usdt: SwapToken = {...ton, key: "ton:usdt", symbol: "USDT", contract: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"};
    const usde: SwapToken = {...ton, key: "ton:usde", symbol: "USDe", contract: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f"};
    // STON.fi v1, STON.fi v2, DeDust v1 — both ways.
    for (const dex of ["StonFiV1", "StonFiV2", "DeDust"]) {
      expect(tonWalletRefusal(swap([dex]), ton, usdt), dex).toBeNull();
      expect(tonWalletRefusal(swap([dex]), usdt, ton), dex).toBeNull();
    }
    // DeDust CPMM v2 (what Omniston quotes TON → USDT through today), TONCO, swap.coffee, two hops, a split, no steps.
    const cpmm = tonWalletRefusal(swap(["DeDustCPMMV2"]), ton, usdt);
    expect(cpmm).toMatchObject({provider: "omniston", reason: "Routed through a DEX that isn't pinned here", category: "setup"});
    expect(cpmm!.detail).toMatch(/through DeDust CPMM v2\. .*STON\.fi v1, STON\.fi v2's TON\/USDT router or DeDust v1/);
    expect(cpmm!.raw).toMatch(/DeDustCPMMV2/);
    expect(tonWalletRefusal(swap(["TonCoV2"]), usdt, ton)!.detail).toMatch(/through TONCO/);
    expect(tonWalletRefusal(swap(["SwapCoffee"]), ton, usdt)!.detail).toMatch(/through swap\.coffee/);
    expect(tonWalletRefusal(swap(["StonFiV2", "StonFiV2"]), usdt, ton)!.detail).toMatch(/in several hops/);
    expect(tonWalletRefusal(swap(["split(StonFiV2|DeDust)"]), usdt, ton)!.detail).toMatch(/a DEX this app doesn't know/);
    expect(tonWalletRefusal(swap([]), usdt, ton)!.detail).toMatch(/a route its quote doesn't name/);
    expect(tonWalletRefusal(swap(), ton, usdt)).toMatchObject({reason: "Routed through a DEX that isn't pinned here"});
    // Another pair: refused whatever the DEX.
    for (const [from, to] of [[usdt, usde], [usde, ton], [ton, usde], [ton, ton]] as const)
      expect(tonWalletRefusal(swap(["StonFiV2"]), from, to), `${from.symbol} → ${to.symbol}`).toMatchObject({reason: "Only TON ↔ USDT swaps are signed here", category: "setup"});
    for (const why of [cpmm!, tonWalletRefusal(swap(["StonFiV1"]), usdt, usde)!]) expect(why.reason.length).toBeLessThanOrEqual(45);
    // In the list: a pinned route is offered, the others refused beside it.
    const snap: RouteSnapshot = {...demoSnapshot(), routes: [swap(["StonFiV1"]), {...swap(["DeDustCPMMV2"]), provider: "omniston"}], rejections: []};
    const m = routeListModel(snap, ton, usdt);
    expect(m.routes).toHaveLength(1);
    expect(m.routes[0]!.tonSwapSteps).toEqual(["StonFiV1"]);
    expect(m.refused.map((x) => x.reason)).toEqual(["Routed through a DEX that isn't pinned here"]);
    expect(m.walletRefusedCount).toBe(1);
  });
  it("Symbiosis from a TON wallet is offered only to a token it releases directly on an EVM network: never to Tron", () => {
    const call = (provider: string) => ({...demoSnapshot().routes[0]!, provider, execution: "calldata"}) as WebRoute;
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", chainName: "TON", family: "ton", symbol: "TON", owner: "UQx", payMode: "wallet"};
    const usdt: SwapToken = {...ton, key: "ton:usdt", symbol: "USDT", contract: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"};
    const tronUsdt: SwapToken = {
      ...tok(evmOnly, ARB_USDC),
      key: "tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t",
      chain: "tron",
      caip2: "tron:728126428",
      chainName: "Tron",
      family: "tron",
      symbol: "USDT",
      contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    };
    // Tron: Symbiosis needs an EVM address of the payer's there, which a TON wallet doesn't have — its dry quote passes on
    // a placeholder, the live one is refused: listed as refused, never offered (and never "Best").
    expect(tonWalletRefusal(call("symbiosis"), usdt, tronUsdt)).toMatchObject({provider: "symbiosis", reason: "TON contract calls aren't signed here yet"});
    // USDC on Base is reached only by a swap after the release; native ETH only by an unwrap.
    expect(tonWalletRefusal(call("symbiosis"), usdt, tok(evmOnly, BASE_USDC))).not.toBeNull();
    expect(tonWalletRefusal(call("symbiosis"), usdt, {...tok(evmOnly, ARB_USDC), contract: null})).not.toBeNull();
    // No token to receive yet: nothing to check the call against, so it isn't offered.
    expect(tonWalletRefusal(call("symbiosis"), usdt, undefined)).not.toBeNull();
    expect(tonWalletRefusal(call("symbiosis"), usdt, tok(evmOnly, ARB_USDC))).toBeNull();
    const calls: RouteSnapshot = {...snap, routes: [...snap.routes, call("symbiosis")], rejections: []};
    expect(routeListModel(calls, usdt, tronUsdt).refused.map((x) => x.provider)).toContain("symbiosis");
    expect(routeListModel(calls, usdt, tronUsdt).routes.map((r) => r.provider)).not.toContain("symbiosis");
  });
});

describe("venues a preview left for the live quote (deferred, D7)", () => {
  const lifi: RouteRejection = {
    provider: "lifi",
    reason: "Connect a wallet to get this quote",
    category: "deferred",
    detail: "Preview prices skip it here to save its request limit for your own quote — it's asked as soon as your wallet is connected or your address is entered.",
    raw: "asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key",
    skipped: true,
  };
  const preview: RouteSnapshot = {...demoSnapshot(), mode: "preview", rejections: [lifi, ...demoSnapshot().rejections.filter((x) => x.provider !== "lifi")]};

  it("never sit among the refusals: their own quiet group, titled for what is missing", () => {
    const m = routeListModel(preview, tok(none, ARB_USDC), tok(none, BASE_USDC), {kind: "connect", family: "evm"});
    expect(m.deferred).toEqual([lifi]);
    expect(m.deferredTitle).toBe("Quoted after you connect");
    expect(m.refused.map((x) => x.provider)).not.toContain("lifi");
    expect(m.refused.every((x) => x.category !== "deferred")).toBe(true);
  });

  it("the row says what gets the quote: a wallet, the address to pay, a refund address — short, never an error", () => {
    expect(deferredCopy({kind: "connect", family: "evm"})).toEqual({title: "Quoted after you connect", reason: "Connect a wallet to get this quote"});
    expect(deferredCopy({kind: "recipient", chainName: "Base", invalid: false, canConnect: true})).toEqual({
      title: "Quoted after you add the address",
      reason: "Paste the address to get this quote",
    });
    expect(deferredCopy({kind: "refund", chainName: "Bitcoin", invalid: false})).toEqual({
      title: "Quoted after you add the address",
      reason: "Enter the refund address to get this quote",
    });
    // A live request still showing preview rows, or no form state: the plain default.
    expect(deferredCopy(null)).toEqual({title: "Quoted after you connect", reason: "Connect a wallet to get this quote"});
    for (const m of [null, {kind: "recipient", chainName: "Tron", invalid: false, canConnect: false}, {kind: "refund", chainName: "Zcash", invalid: false}] as const) {
      const {title, reason} = deferredCopy(m);
      expect(reason.length).toBeLessThanOrEqual(45);
      expect(`${title} ${reason}`).not.toMatch(/change on your side|didn't|can't|couldn't|refus|error/i);
    }
    const m = routeListModel(preview, tok(none, ARB_USDC), tok(none, BASE_USDC), {kind: "recipient", chainName: "Base", invalid: false, canConnect: true});
    expect(m.deferred[0]).toMatchObject({provider: "lifi", reason: "Paste the address to get this quote", category: "deferred", raw: lifi.raw});
    expect(m.deferredTitle).toBe("Quoted after you add the address");
  });

  it("a QR payer: the QR refusals stay refusals, the deferred venue stays apart", () => {
    const m = routeListModel(preview, tok(none, BTC), tok(none, BASE_USDC), {kind: "refund", chainName: "Bitcoin", invalid: false});
    expect(m.deferred.map((x) => [x.provider, x.reason])).toEqual([["lifi", "Enter the refund address to get this quote"]]);
    expect(m.refused.some((x) => x.provider === "lifi")).toBe(false);
    expect(m.refused[0]).toMatchObject({category: "setup"});
  });

  it("a preview where nothing else answered still reads 'Couldn't reach any venue' when the asked ones failed in transport", () => {
    const snap = empty(["near_intents", "lifi"], [unreachableRow, lifi]);
    expect(venuesUnreachable(routeListModel(snap, tok(none, ARB_USDC)), false)).toBe(true);
    expect(venuesUnreachable(routeListModel(empty(["lifi"], [lifi]), tok(none, ARB_USDC)), false)).toBe(false);
  });
});

describe("coverage: venues this pair isn't for", () => {
  const usdcArb = tok(evmOnly, ARB_USDC);
  const usdcBase = tok(evmOnly, BASE_USDC);
  it("lists the enabled venues the round didn't ask, each with its scope, in ask order", () => {
    const m = routeListModel(demoSnapshot(), usdcArb, usdcBase);
    expect(m.notForPair).toEqual([
      {provider: "uniswap", scope: "Same-network swaps only"},
      {provider: "curve", scope: "Same-network swaps only"},
      {provider: "balancer", scope: "Same-network swaps only"},
      {provider: "wrap", scope: "Wraps only, like ETH ⇄ WETH"},
      {provider: "usdt0", scope: "Moves USDT only"},
      {provider: "thorchain", scope: "Doesn't cover this pair"},
      {provider: "chainflip", scope: "Doesn't cover this pair"},
      {provider: "jupiter", scope: "Swaps within Solana only"},
    ]);
    // Symbiosis and Omniston (on by default) serve USDC Arbitrum → Base: asked, not listed here.
    expect(m.coverage).toBe("6 of 14 venues serve this pair");
  });
  it("needs both tokens and a snapshot", () => {
    expect(routeListModel(demoSnapshot(), usdcArb).notForPair).toEqual([]);
    expect(routeListModel(null, usdcArb, usdcBase)).toMatchObject({notForPair: [], coverage: null});
  });
  it("coverage line: one venue, all of them, none known", () => {
    expect(coverageLine({asked: ["lifi"], venues: ["lifi", "relay"]})).toBe("1 of 2 venues serves this pair");
    expect(coverageLine({asked: ["lifi", "relay"], venues: ["lifi", "relay"]})).toBe("All 2 venues serve this pair");
    expect(coverageLine({asked: [], venues: []})).toBeNull();
    expect(coverageLine(null)).toBeNull();
  });
});

const empty = (asked: string[] = [], rejections: RouteRejection[] = []): RouteSnapshot => ({mode: "live", routes: [], pending: [], rejections, asked, venues: asked});
const unreachableRow: RouteRejection = {provider: "near_intents", reason: "Couldn't reach it — tap refresh", category: "unreachable", raw: "1Click network error: fetch failed"};

describe("routesStatus", () => {
  const model = routeListModel(demoSnapshot(), tok(evmOnly, ARB_USDC));
  const idle = {loading: false, error: null, updatedAt: 0, limitedUntil: 0, snapshot: demoSnapshot()};
  it("follows the mobile cascade, with freshness", () => {
    expect(routesStatus(false, idle, model, providerName, 0)).toBeNull();
    expect(routesStatus(true, {...idle, loading: true}, {...model, pending: ["lifi", "relay"]}, providerName, 0)?.text).toBe("Asking LI.FI, Relay…");
    expect(routesStatus(true, {...idle, loading: true, snapshot: null}, routeListModel(null, tok(evmOnly, ARB_USDC)), providerName, 0)?.text).toBe("Finding routes…");
    // A list on screen, its new round not started yet (D32): it is being updated, not found.
    expect(routesStatus(true, {...idle, loading: true}, {...model, pending: []}, providerName, 0)?.text).toBe("Updating routes…");
    expect(routesStatus(true, {...idle, error: "Busy right now"}, model, providerName, 0)).toEqual({text: "Couldn't quote: Busy right now", error: true});
    expect(routesStatus(true, {...idle, updatedAt: 1_000}, model, providerName, 13_500)?.text).toBe("3 routes · updated 12 s ago");
    const none = routeListModel(empty(), tok(evmOnly, ARB_USDC));
    expect(routesStatus(true, {...idle, snapshot: empty()}, none, providerName, 0)?.text).toBe("No venue swaps this pair yet.");
    expect(routesStatus(true, {...idle, snapshot: empty(["lifi"])}, none, providerName, 0)?.text).toBe("No route for this pair and amount right now.");
    const qrOnly = routeListModel({...demoSnapshot(), routes: [demoSnapshot().routes[0]!]}, tok(evmOnly, BTC));
    expect(routesStatus(true, idle, qrOnly, providerName, 0)?.text).toBe("No route takes a QR payment for this pair right now.");
    // A TON wallet with only contract-call routes is a wallet payer: no QR wording.
    const ton: SwapToken = {...tok(evmOnly, BTC), key: "ton:native", chain: "ton", chainName: "TON", family: "ton", symbol: "TON", owner: "UQx", payMode: "wallet"};
    const callsOnly = routeListModel({...demoSnapshot(), routes: [demoSnapshot().routes[0]!]}, ton);
    expect(callsOnly).toMatchObject({routes: [], qrRefusedCount: 0, walletRefusedCount: 1});
    expect(routesStatus(true, idle, callsOnly, providerName, 0)?.text).toBe("No route your wallet can sign for this pair yet.");
    expect(venuesUnreachable(callsOnly, false)).toBe(false);
  });

  it("a preview waiting for the tab's next token says so; a list already shown keeps its own line", () => {
    const waiting = {...idle, snapshot: null, limitedUntil: 18_000};
    expect(routesStatus(true, waiting, routeListModel(null, tok(none, ARB_USDC)), providerName, 1_000)?.text).toBe("Preview paused for 17 s — too many price checks.");
    expect(routesStatus(true, {...idle, updatedAt: 1_000, limitedUntil: 18_000}, model, providerName, 13_500)?.text).toBe("3 routes · updated 12 s ago");
    // …unless its rows wait for that round (new terms, D32).
    const held = routeListModel(demoSnapshot(), tok(evmOnly, ARB_USDC), undefined, null, ["cctp"]);
    expect(routesStatus(true, {...idle, updatedAt: 1_000, limitedUntil: 18_000}, held, providerName, 13_500)?.text).toBe("Preview paused for 5 s — too many price checks.");
  });

  it("every venue failing in transport (or the browser offline) reads as a connection problem, not 'no route'", () => {
    const unreachable = empty(["near_intents"], [unreachableRow]);
    const m = routeListModel(unreachable, tok(evmOnly, ARB_USDC));
    expect(venuesUnreachable(m, false)).toBe(true);
    expect(routesStatus(true, {...idle, snapshot: unreachable}, m, providerName, 0)).toEqual({text: "Couldn't reach any venue — check your connection and refresh.", error: true});
    expect(ctaState({missing: null, unreachable: true, from: tok(evmOnly, ARB_USDC), balanceProblem: null, routesLoading: false, chosen: undefined, providerName})).toMatchObject({
      label: "Can't reach the venues",
      state: "unreachable",
      enabled: false,
    });
    // One real refusal among them: that is an answer about the pair.
    const pair: RouteRejection = {provider: "lifi", reason: "Doesn't support this pair", category: "pair", raw: "does not serve"};
    expect(venuesUnreachable(routeListModel(empty(["near_intents", "lifi"], [unreachableRow, pair]), tok(evmOnly, ARB_USDC)), false)).toBe(false);
    // A rate limit is the venue answering, not the connection failing.
    const busy: RouteRejection = {provider: "lifi", reason: "Busy right now — try again soon", category: "busy", raw: "HTTP 429"};
    expect(venuesUnreachable(routeListModel(empty(["lifi"], [busy]), tok(evmOnly, ARB_USDC)), false)).toBe(false);
    // Decided by category, not wording: a reworded transport line still counts.
    expect(venuesUnreachable(routeListModel(empty(["x"], [{...unreachableRow, reason: "Some new wording"}]), tok(evmOnly, ARB_USDC)), false)).toBe(true);
    // A venue the round sat out itself (LI.FI left for the live quote, a back-off) was sent nothing: it neither proves nor
    // disproves a connection problem, so the venues that were asked decide.
    const liveOnly: RouteRejection = {provider: "lifi", reason: "Connect a wallet to get this quote", category: "deferred", raw: "asked only for your live quote", skipped: true};
    const backingOff: RouteRejection = {provider: "jupiter", reason: "Request limit hit — back in about 2 minutes", category: "busy", raw: "rate limit exceeded, retry in ~2 min", skipped: true};
    expect(venuesUnreachable(routeListModel(empty(["near_intents", "lifi", "jupiter"], [unreachableRow, liveOnly, backingOff]), tok(evmOnly, ARB_USDC)), false)).toBe(true);
    expect(venuesUnreachable(routeListModel(empty(["lifi"], [liveOnly]), tok(evmOnly, ARB_USDC)), false)).toBe(false);
    // Offline says so even before any venue answered.
    expect(venuesUnreachable(routeListModel(empty(["lifi"]), tok(evmOnly, ARB_USDC)), false, false)).toBe(true);
    expect(venuesUnreachable(m, true)).toBe(false);
  });
});

describe("the list as shown while it is re-quoted (D32)", () => {
  const from = tok(evmOnly, ARB_USDC);
  const to = tok(evmOnly, BASE_USDC);
  const live = (slippageBps: number, over: {amountIn?: bigint; recipient?: string} = {}): RoutesRequest => ({
    mode: "live",
    req: {from, to, amountIn: over.amountIn ?? 250_000_000n, slippageBps, recipient: over.recipient ?? DEMO_EVM_ADDRESS, refundAddress: DEMO_EVM_ADDRESS},
  });
  const base = demoSnapshot(0);
  const [cctp, , relay] = base.routes as [WebRoute, WebRoute, WebRoute];
  /** The port's state: a finished round, or one still running (`loading`). */
  const port = (snapshot: RouteSnapshot | null, loading = false, over: Partial<RoutesState> = {}): RoutesState => ({
    snapshot,
    loading,
    error: null,
    updatedAt: loading ? 0 : 5_000,
    limitedUntil: 0,
    ...over,
  });
  /** A round of the port: who answered with which route, who is still asked, who refused. */
  const round = (routes: WebRoute[], pending: string[], rejections: RouteRejection[] = []): RouteSnapshot => ({...base, routes, pending, rejections});
  const at = (r: WebRoute, minDestAmount: bigint, tags: WebRoute["tags"] = []): WebRoute => ({...r, minDestAmount, tags});
  const names = (x: ShownList) => x.snapshot!.routes.map((r) => r.provider);

  it("new terms keep every row in place, held, until its venue answers; the finished round re-ranks once", () => {
    const half = live(50);
    const one = live(100);
    let shown = foldShownList(null, half, port(base));
    expect(heldRoutes(shown, routesKey(half))).toEqual([]);

    // Slippage → 1 %: the port has nothing for the new terms yet (its debounce). The rows stay, all held.
    shown = foldShownList(shown, one, port(null, true));
    expect(names(shown)).toEqual(["cctp", "near_intents", "relay"]);
    expect(heldRoutes(shown, routesKey(one))).toEqual(["cctp", "near_intents", "relay"]);
    expect(shown.updatedAt).toBe(5_000);

    // The round asks every venue: no row is repeated as "Quoting…", the refusals stay while their venues are asked.
    shown = foldShownList(shown, one, port(round([], base.asked), true));
    const asking = routeListModel(shown.snapshot, from, to, null, heldRoutes(shown, routesKey(one)));
    expect(names(shown)).toEqual(["cctp", "near_intents", "relay"]);
    expect(asking.refused.map((x) => x.provider)).toEqual(["lifi", "symbiosis", "omniston"]);
    expect(stillQuoting(asking)).toEqual([]);

    // Relay answers first, ranked best by the partial auction: its row takes the new numbers where it is, with its tags.
    const relay1 = at(relay, 980_000_000n, ["best"]);
    shown = foldShownList(shown, one, port(round([relay1], base.asked.filter((p) => p !== "relay")), true));
    expect(names(shown)).toEqual(["cctp", "near_intents", "relay"]);
    expect(shown.snapshot!.routes[2]).toEqual({...relay1, tags: ["fastest"]});
    expect(shown.snapshot!.routes[0]!.tags).toEqual(["best"]);
    expect(heldRoutes(shown, routesKey(one))).toEqual(["cctp", "near_intents"]);

    // NEAR Intents refuses this time: its row goes and its refusal comes after the ones on screen (LI.FI's left: it
    // quotes now); a venue new to the list comes last, untagged.
    const nearNo: RouteRejection = {provider: "near_intents", reason: "No quote right now", category: "other", raw: "no quote"};
    const lifi1 = at({...cctp, provider: "lifi"}, 990_000_000n, ["best"]);
    shown = foldShownList(shown, one, port(round([lifi1, relay1], ["cctp", "symbiosis", "omniston"], [nearNo]), true));
    expect(names(shown)).toEqual(["cctp", "relay", "lifi"]);
    expect(shown.snapshot!.routes[2]!.tags).toEqual([]);
    expect(shown.snapshot!.rejections.map((x) => x.provider)).toEqual(["symbiosis", "omniston", "near_intents"]);
    expect(heldRoutes(shown, routesKey(one))).toEqual(["cctp"]);

    // The round is done: the port's ranking, its tags, nothing held.
    const cctp1 = at(cctp, 999_000_000n, ["best"]);
    const done = round([cctp1, at(lifi1, lifi1.minDestAmount), at(relay1, relay1.minDestAmount, ["fastest"])], [], [nearNo]);
    shown = foldShownList(shown, one, port(done));
    expect(shown.snapshot).toBe(done);
    expect(heldRoutes(shown, routesKey(one))).toEqual([]);
  });

  it("folds the same port state to the same object (no render loop)", () => {
    const state = port(round([], base.asked), true);
    const first = foldShownList(foldShownList(null, live(50), port(base)), live(100), state);
    expect(foldShownList(first, live(100), state)).toBe(first);
  });

  it("an address or slippage set back before the new round lands shows its own finished list, nothing held", () => {
    const half = live(50);
    let shown = foldShownList(null, half, port(base));
    shown = foldShownList(shown, live(100), port(null, true));
    // The port shows the round it had finished for these terms (useRoutes: typed away and back).
    shown = foldShownList(shown, half, port(base));
    expect(heldRoutes(shown, routesKey(half))).toEqual([]);
    // A new recipient re-quotes like a new slippage: held until the venues answer for it.
    const other = live(50, {recipient: "0x2222222222222222222222222222222222222222"});
    shown = foldShownList(shown, other, port(null, true));
    expect(heldRoutes(shown, routesKey(other))).toEqual(["cctp", "near_intents", "relay"]);
  });

  it("a new amount, pair or mode shows the port's own state: a preview list never carries into a live one (D7)", () => {
    const shown = foldShownList(null, live(50), port(base));
    expect(foldShownList(shown, live(50, {amountIn: 1n}), port(null, true)).snapshot).toBeNull();
    const preview: RoutesRequest = {mode: "preview", req: {preview: true, from, to, amountIn: 250_000_000n, slippageBps: 50, toOther: false}};
    const previewList = foldShownList(null, preview, port({...base, mode: "preview"}));
    expect(listKey(preview)).not.toBe(listKey(live(50)));
    expect(foldShownList(previewList, live(50), port(null, true)).snapshot).toBeNull();
  });

  it("the 30 s refresh keeps every row and its place, reviewable (same terms), until each venue answers", () => {
    const half = live(50);
    let shown = foldShownList(null, half, port(base));
    // useRoutes keeps the old list until the first new price, then shows only what answered so far.
    shown = foldShownList(shown, half, port({...base, pending: base.asked}, true, {updatedAt: 5_000}));
    shown = foldShownList(shown, half, port(round([at(relay, relay.minDestAmount, ["best"])], ["cctp", "near_intents"]), true, {updatedAt: 5_000}));
    expect(names(shown)).toEqual(["cctp", "near_intents", "relay"]);
    expect(heldRoutes(shown, routesKey(half))).toEqual([]);
  });

  it("a list's first round streams as the port ranks it", () => {
    const half = live(50);
    let shown = foldShownList(null, half, port(round([relay], ["cctp"]), true));
    shown = foldShownList(shown, half, port(round([cctp, relay], []), true));
    expect(names(shown)).toEqual(["cctp", "relay"]);
  });

  it("a round that fails part-way keeps the rows, and what was held stays held — outdated, no longer updating", () => {
    let shown = foldShownList(null, live(50), port(base));
    shown = foldShownList(shown, live(100), port(round([], base.asked), true));
    expect(heldAs(heldRoutes(shown, routesKey(live(100))), "cctp", true)).toBe("updating");
    shown = foldShownList(shown, live(100), port(round([], base.asked), false, {error: "Couldn't reach it — tap refresh"}));
    expect(names(shown)).toEqual(["cctp", "near_intents", "relay"]);
    const held = heldRoutes(shown, routesKey(live(100)));
    expect(held).toEqual(["cctp", "near_intents", "relay"]);
    // No round runs: nothing says it is updating (no spinner, no aria-busy), and the CTA asks again — never a review.
    expect(heldAs(held, "cctp", false)).toBe("outdated");
    const cta = ctaState({missing: null, from, balanceProblem: null, routesLoading: false, chosen: cctp, held: true, providerName});
    expect(cta).toEqual({label: "Couldn't update quote — try again", enabled: true, action: "refresh", state: "retry"});
    // The same with nothing streamed before the failure (the lazy provider load, a final view that threw).
    const early = foldShownList(foldShownList(foldShownList(null, live(50), port(base)), live(100), port(null, true)), live(100), port(null, false, {error: "boom"}));
    expect(heldRoutes(early, routesKey(live(100)))).toEqual(["cctp", "near_intents", "relay"]);
  });

  it("a venue's several routes (D47: CCTP Fast and Standard) are rows of their own, held and replaced each by its routeKey", () => {
    const fast = {...cctp, routeId: "fast"};
    const standard = {...cctp, routeId: "standard", minDestAmount: 250_000_000n, etaSeconds: 1080, tags: [] as WebRoute["tags"]};
    const two = round([fast, standard, relay], []);
    const keys = (x: ShownList) => x.snapshot!.routes.map((r) => (r.routeId ? `${r.provider}/${r.routeId}` : r.provider));
    let shown = foldShownList(null, live(50), port(two));
    expect(keys(shown)).toEqual(["cctp/fast", "cctp/standard", "relay"]);
    // New terms: every row held until its venue answers.
    shown = foldShownList(shown, live(100), port(round([], two.asked), true));
    expect(heldRoutes(shown, routesKey(live(100)))).toEqual(["cctp/fast", "cctp/standard", "relay"]);
    // CCTP answers with both routes: each replaces its own row in place; Relay's stays held.
    const fast1 = at(fast, 249_900_000n);
    const standard1 = at(standard, 250_000_000n);
    shown = foldShownList(shown, live(100), port(round([standard1, fast1], two.asked.filter((p) => p !== "cctp")), true));
    expect(keys(shown)).toEqual(["cctp/fast", "cctp/standard", "relay"]);
    expect(shown.snapshot!.routes[0]!.minDestAmount).toBe(249_900_000n);
    expect(shown.snapshot!.routes[1]!.minDestAmount).toBe(250_000_000n);
    expect(heldRoutes(shown, routesKey(live(100)))).toEqual(["relay"]);
    expect(heldAs(heldRoutes(shown, routesKey(live(100))), "cctp/fast", true)).toBeUndefined();
    // Next time CCTP answers with Fast alone: the Standard row leaves rather than stand in for it.
    shown = foldShownList(shown, live(50), port(round([], two.asked), true));
    shown = foldShownList(shown, live(50), port(round([at(fast, 249_800_000n)], two.asked.filter((p) => p !== "cctp")), true));
    expect(keys(shown)).toEqual(["cctp/fast", "relay"]);
    // The CTA names the route.
    expect(ctaState({missing: null, from, balanceProblem: null, routesLoading: false, chosen: standard, providerName: routeName})).toMatchObject({label: "Review via Circle CCTP · Standard"});
  });

  it("refusal rows keep their order on screen while the venues answer, whatever the answer order", () => {
    // Nobody quotes at 0.5 %: the no-route state lists the refusals open, in the port's order.
    const [lifiNo, symbiosisNo, omnistonNo] = base.rejections as [RouteRejection, RouteRejection, RouteRejection];
    const nothing = round([], [], [lifiNo, symbiosisNo, omnistonNo]);
    let shown = foldShownList(null, live(50), port(nothing));
    const order = () => shown.snapshot!.rejections.map((x) => x.provider);
    expect(order()).toEqual(["lifi", "symbiosis", "omniston"]);
    // 1 %: Omniston refuses first, with a new reason. It keeps its place; the others, still asked, keep theirs.
    const omniston1: RouteRejection = {...omnistonNo, reason: "Amount too small", category: "amount"};
    shown = foldShownList(shown, live(100), port(round([], ["lifi", "symbiosis"], [omniston1]), true));
    expect(order()).toEqual(["lifi", "symbiosis", "omniston"]);
    expect(shown.snapshot!.rejections[2]).toBe(omniston1);
    // Symbiosis quotes now: its refusal leaves (its route comes last); LI.FI's row stays put.
    const symbiosis1 = at({...cctp, provider: "symbiosis"}, 990_000_000n);
    shown = foldShownList(shown, live(100), port(round([symbiosis1], ["lifi"], [omniston1]), true));
    expect(order()).toEqual(["lifi", "omniston"]);
    expect(names(shown)).toEqual(["symbiosis"]);
    // A venue new to the refusals comes after the ones on screen.
    const nearNo: RouteRejection = {provider: "near_intents", reason: "No quote right now", category: "other", raw: "no quote"};
    shown = foldShownList(shown, live(100), port(round([symbiosis1], ["lifi"], [nearNo, omniston1]), true));
    expect(order()).toEqual(["lifi", "omniston", "near_intents"]);
    // The finished round applies the port's order once.
    const done = round([symbiosis1], [], [nearNo, omniston1, lifiNo]);
    shown = foldShownList(shown, live(100), port(done));
    expect(shown.snapshot).toBe(done);
  });

  it("a held chosen route is never reviewable: 'Updating quote…', then a retry, for a QR payer too", () => {
    const x = {missing: null, from, balanceProblem: null, routesLoading: true, chosen: cctp, held: true, providerName};
    expect(ctaState(x)).toEqual({label: "Updating quote…", enabled: false, action: "none", state: "updating"});
    expect(ctaState({...x, from: tok(evmOnly, BTC)}).action).toBe("none");
    expect(ctaState({...x, routesLoading: false}).action).toBe("refresh");
    expect(ctaState({...x, routesLoading: false, from: tok(evmOnly, BTC)}).action).toBe("refresh");
    expect(heldAs(["cctp"], "relay", true)).toBeUndefined();
    expect(heldAs(["cctp"], undefined, true)).toBeUndefined();
    expect(ctaState({...x, held: false})).toMatchObject({label: "Review via Circle CCTP", enabled: true, action: "review"});
    // A QR payer's model holds only the routes it is offered.
    expect(routeListModel(base, tok(evmOnly, BTC), to, null, ["cctp", "near_intents"]).held).toEqual(["near_intents"]);
  });
});

describe("helpers", () => {
  it("plainUnits refills the amount field exactly", () => {
    expect(plainUnits("250000000", 6)).toBe("250");
    expect(plainUnits("40000000000000000", 18)).toBe("0.04");
    expect(plainUnits("nope", 6)).toBe("");
  });
  it("agoLabel", () => {
    expect(agoLabel(1_000)).toBe("just now");
    expect(agoLabel(42_000)).toBe("42 s ago");
    expect(agoLabel(5 * 60_000)).toBe("5 min ago");
  });
  it("slippage: typed percent within 0.01–50 %, labels", () => {
    expect(parseSlippage("0.8")).toBe(80);
    expect(parseSlippage("0,5")).toBe(50);
    expect(parseSlippage("0")).toBeNull();
    expect(parseSlippage("51")).toBeNull();
    expect(parseSlippage("abc")).toBeNull();
    expect(slippageText(null, 30)).toBe("Auto · 0.3%");
    expect(slippageText(100, 30)).toBe("1% (custom)");
  });
  it("deposit QR payloads: BIP-21 for BTC, zcash: for ZEC, bare address elsewhere", () => {
    expect(depositUri("btc", "bc1qx", "0.015")).toBe("bitcoin:bc1qx?amount=0.015");
    expect(depositUri("zcash", "t1x", "1")).toBe("zcash:t1x?amount=1");
    expect(depositUri("ton", "UQx", "1")).toBe("UQx");
  });
  it("scenes come from the path or the query and preset the form", () => {
    expect(sceneFrom("/demo/deposit", new URLSearchParams())).toBe("deposit");
    expect(sceneFrom("/", new URLSearchParams("scene=activity"))).toBe("activity");
    expect(sceneFrom("/demo/nope", new URLSearchParams())).toBeNull();
    expect(scenePreset("deposit")).toMatchObject({pay: BTC, refund: BTC_REFUND});
    expect(scenePreset("activity")).toBeNull();
  });
  it("settings: URL lines drop blanks", () => {
    expect(urlLines(" https://x \n\n https://y")).toEqual(["https://x", "https://y"]);
  });
  it("settings: Custom RPC rows are checked when added (https, this page's CSP, duplicates, the cap) and removed per network", () => {
    const none = {evmRpc: {}, solanaRpc: []};
    const one = addCustomRpc(none, 42161, " https://arb.example ", "swap.example");
    expect(one).toEqual({custom: {evmRpc: {42161: ["https://arb.example"]}, solanaRpc: []}, error: null});
    expect(addCustomRpc(one.custom, 42161, "https://arb.example", "swap.example").error).toBe("Already in the list.");
    expect(addCustomRpc(none, 1, "http://eth.example", "swap.example").error).toMatch(/https/);
    expect(addCustomRpc(none, 1, "ftp://eth.example", "swap.example").error).toMatch(/https/);
    expect(addCustomRpc(none, 1, "", "swap.example").error).toBe("Enter a URL.");
    // A local node: the hosted CSP blocks plain http, the npx server (loopback) allows it.
    expect(addCustomRpc(none, 1, "http://127.0.0.1:8545", "swap.example").error).toMatch(/only when the app runs on this machine/);
    expect(addCustomRpc(none, 1, "http://127.0.0.1:8545", "127.0.0.1").error).toBeNull();
    let full = none as {evmRpc: Record<number, string[]>; solanaRpc: string[]};
    for (let i = 0; i < 8; i++) full = addCustomRpc(full, "solana", `https://sol${i}.example`, "swap.example").custom as typeof full;
    expect(addCustomRpc(full, "solana", "https://sol9.example", "swap.example").error).toBe("At most 8 per network.");
    expect(removeCustomRpc(one.custom, 42161, "https://arb.example")).toEqual(none);
    expect(removeCustomRpc(full, "solana", "https://sol0.example").solanaRpc).toHaveLength(7);
  });
  it("settings: the live Standard line names keyed venues, RPC networks, THORChain and fallbacks — or that cp0x is unreachable", () => {
    const base = {mode: "standard" as const, keyed: [], viaProxy: [], fellBack: [], rpcNetworks: 0, thornode: false};
    expect(connectionStatusText({...base, health: "off"}, venueName)).toBeNull();
    expect(connectionStatusText({...base, mode: "public", health: "off"}, venueName)).toBeNull();
    expect(connectionStatusText({...base, health: "checking"}, venueName)).toBe("Checking the cp0x API…");
    expect(connectionStatusText({...base, health: "unreachable"}, venueName)).toBe("cp0x API unreachable — using public endpoints.");
    expect(connectionStatusText({...base, health: "ok", viaProxy: ["lifi", "relay"], rpcNetworks: 30, thornode: true}, venueName)).toBe(
      "LI.FI and Relay through cp0x with its keys · RPC for 30 networks through cp0x · THORChain's vault check through cp0x",
    );
    expect(connectionStatusText({...base, health: "ok", viaProxy: ["relay"], fellBack: ["lifi", "near_intents", "jupiter"], rpcNetworks: 1}, venueName)).toBe(
      "Relay through cp0x with its keys · RPC for 1 network through cp0x · LI.FI, NEAR Intents and Jupiter asked directly after a cp0x error",
    );
    expect(connectionStatusText({...base, health: "ok"}, venueName)).toBe("Venues asked directly (cp0x holds no key for them yet) · Public RPCs");
  });
  it("settings: 'no key' only when health keyed no venue — keyed venues that fell back, or that this browser pointed elsewhere, don't get it", () => {
    const base = {mode: "standard" as const, health: "ok" as const, keyed: [], viaProxy: [], fellBack: [], rpcNetworks: 1, thornode: false};
    // Both keyed venues failed at cp0x: the fallback clause says it all.
    expect(connectionStatusText({...base, keyed: ["lifi", "relay"], fellBack: ["lifi", "relay"]}, venueName)).toBe(
      "RPC for 1 network through cp0x · LI.FI and Relay asked directly after a cp0x error",
    );
    // Keyed, but this browser's own bases took them off the proxy: cp0x does hold a key.
    expect(connectionStatusText({...base, keyed: ["lifi", "relay"]}, venueName)).toBe("Venues asked directly · RPC for 1 network through cp0x");
    expect(connectionStatusText(base, venueName)).toBe("Venues asked directly (cp0x holds no key for them yet) · RPC for 1 network through cp0x");
  });
  it("settings: Fynd goes only through cp0x — named with the others there, 'paused' (never 'asked directly') after a cp0x error", () => {
    const base = {mode: "standard" as const, health: "ok" as const, keyed: ["lifi", "fynd"] as const, viaProxy: [], fellBack: [], rpcNetworks: 1, thornode: false};
    expect(connectionStatusText({...base, viaProxy: ["lifi", "fynd"]}, venueName)).toBe("LI.FI and Fynd through cp0x with its keys · RPC for 1 network through cp0x");
    expect(connectionStatusText({...base, viaProxy: ["lifi"], fellBack: ["fynd"]}, venueName)).toBe(
      "LI.FI through cp0x with its keys · RPC for 1 network through cp0x · Fynd paused after a cp0x error",
    );
    expect(connectionStatusText({...base, fellBack: ["lifi", "fynd"]}, venueName)).toBe(
      "RPC for 1 network through cp0x · LI.FI asked directly after a cp0x error · Fynd paused after a cp0x error",
    );
    expect(connectionStatusText({...base, keyed: ["fynd"], fellBack: ["fynd"]}, venueName)).toBe("Venues asked directly · RPC for 1 network through cp0x · Fynd paused after a cp0x error");
  });
  it("settings: Symbiosis is named with the keyed venues through cp0x while health keys it, and 'asked directly' after a cp0x error", () => {
    const base = {mode: "standard" as const, health: "ok" as const, keyed: ["lifi", "relay", "symbiosis"] as const, viaProxy: [], fellBack: [], rpcNetworks: 2, thornode: true};
    expect(connectionStatusText({...base, viaProxy: ["lifi", "relay", "symbiosis"]}, venueName)).toBe(
      "LI.FI, Relay and Symbiosis through cp0x with its keys · RPC for 2 networks through cp0x · THORChain's vault check through cp0x",
    );
    expect(connectionStatusText({...base, viaProxy: ["lifi", "relay"], fellBack: ["symbiosis"]}, venueName)).toBe(
      "LI.FI and Relay through cp0x with its keys · RPC for 2 networks through cp0x · THORChain's vault check through cp0x · Symbiosis asked directly after a cp0x error",
    );
    expect(connectionStatusText({...base, keyed: ["symbiosis"], viaProxy: ["symbiosis"], rpcNetworks: 0, thornode: false}, venueName)).toBe(
      "Symbiosis through cp0x with its keys · Public RPCs",
    );
  });
  it("settings: the Fynd row says where it can be asked, and why this page doesn't ask it now", () => {
    const st = {mode: "standard" as const, health: "ok" as const, keyed: [], viaProxy: [], fellBack: [], rpcNetworks: 0, thornode: false};
    expect(standardOnlyNote("fynd", false, {...st, mode: "public", health: "off"})).toBe("Standard mode only — not in this copy of the app");
    expect(standardOnlyNote("fynd", true, {...st, mode: "public", health: "off"})).toBe("Standard mode only — not asked in this mode");
    expect(standardOnlyNote("fynd", true, {...st, mode: "custom", health: "off"})).toBe("Standard mode only — not asked in this mode");
    expect(standardOnlyNote("fynd", true, {...st, health: "unreachable"})).toBe("Standard mode only — cp0x unreachable, not asked");
    expect(standardOnlyNote("fynd", true, st)).toBe("Standard mode only — cp0x holds no key for it yet");
    expect(standardOnlyNote("fynd", true, {...st, keyed: ["fynd"], fellBack: ["fynd"]})).toBe("Standard mode only — paused after a cp0x error");
    expect(standardOnlyNote("fynd", true, {...st, keyed: ["fynd"], viaProxy: ["fynd"]})).toBe("Standard mode only — asked through cp0x's server");
    expect(standardOnlyNote("fynd", true, {...st, health: "checking"})).toBe("Standard mode only — asked through cp0x's server");
  });
});
