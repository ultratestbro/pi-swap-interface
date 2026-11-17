/**
 * The hosted build's Standard mode (D30), against a fake cp0x API: this build was made with
 * VITE_CP0X_API=https://cp0x-api.e2e.test (playwright.config.ts), and every request to that origin is answered here
 * the way cp0x's swap-web proxy answers (CORS, `x-swap-web-answer`). Real ports, no wallet: an amount alone asks
 * the venues for preview prices (D7). Prices are stubbed, THORChain's quote node (Liquify) answers a fake quote,
 * everything else is aborted and recorded.
 * - Health is read once; the keyed venue (Relay) and the listed RPC network (Base) go through the proxy, the
 *   anonymous venue (NEAR Intents) goes straight to the venue, an unlisted network never reaches the proxy, and
 *   THORChain's vault check asks the proxy's THORNode (its height and inbound addresses, protocol-swap2-thorchain 0.4.0)
 *   while its quote comes from Liquify directly.
 * - A health check that fails leaves the page Public; a venue whose proxy call fails falls back to the venue.
 * - Symbiosis (keyed): its limits, quote and status calls go through the proxy (a status call the proxy wouldn't take
 *   goes straight to Symbiosis); a failure at the proxy sends it to Symbiosis directly, once, and Settings says so.
 * - LI.FI in a preview (D7): asked through the proxy while health keys it (never li.quest); while it doesn't, it is
 *   "Quoted after you connect" and sent nothing anywhere; after a failure at the proxy, the one direct retry, then
 *   later previews leave it for the live quote again.
 * - Fynd goes only through cp0x: a same-network preview asks its SDK through the proxy at the hosted API's path (the
 *   EVM sample as recipient and sender), and so does a call shaped like its SDK's while health keys it; nothing at
 *   all is sent — to cp0x or to Fynd — while it doesn't.
 * - 0x and Across (D38) go only through cp0x too: while health keys them, a preview round asks 0x's price endpoint
 *   (`/swap/permit2/price`) and Across' V5 (`POST /v1/quotes`) at their proxy slots, the modules' placeholder key
 *   (`0x-api-key`, `Authorization: Bearer`) sent to the proxy only; Across' keyless relayer fee goes straight to
 *   app.across.to with no key; api.0x.org and api.across.to are never contacted; without a key at cp0x, and in Public,
 *   neither is asked at all.
 * - Public chosen in Settings never contacts cp0x, not even for health, and leaves LI.FI for the live quote.
 * - The swap counter (D36): a swap the wallet broadcasts (a TronLink payer through NEAR Intents, fakeTron.ts) posts
 *   exactly one `/sent` with venue and networks only, never again after a reload; in Public no swap posts anything.
 * Settings names what goes through cp0x each time.
 *
 * CORS: while routing is on, Playwright answers every preflight itself and echoes back whatever headers were asked
 * for, so the headers this fake sends never decide a preflight. Instead every proxy-bound request's own headers are
 * checked against the proxy's preflight allow list (cp0x-api `src/lib/swapWeb/cors.ts` ALLOW_HEADERS): one it would
 * refuse is answered like the browser would see it — a network error — and fails the test (`net.unallowed`).
 */
import {expect, test, type Page, type Request, type Route} from "@playwright/test";
import {answerTronSwap, injectTronLink, newTronSeen, RECIPIENT, USDC_BASE, USDT_TRON, type TronSeen} from "./fakeTron";
import {E2E_CP0X_API, expectNoHorizontalScroll, isCp0xHost, watchPage} from "./helpers";

/** The proxy's path prefix under the fake origin. */
const SWAP_WEB = "/api/v2/swap-web";
/** ETH on Base → ETH on Ethereum: Relay, NEAR Intents, Symbiosis and THORChain all serve it; the gas price reads Base. */
const PAIR = "./#/?pay=base:native&receive=ethereum:native&amount=0.1";
/** ETH → USDC on Base, no amount yet: a same-network pair Fynd serves. */
const SAME_NETWORK = "./#/?pay=base:native&receive=base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const HEALTH = {
  venues: {lifi: "keyed", relay: "keyed", near_intents: "anonymous", jupiter: "anonymous", symbiosis: "keyed", fynd: "keyed"},
  rpc: {configured: true, chains: ["8453", "solana"]},
  thornode: true,
};
/** Symbiosis' public base (the built-in default), where its calls go when they don't go through the proxy. */
const SYMBIOSIS = "https://api.symbiosis.finance/crosschain";
/** The EVM preview sample (src/swap/preview.ts PREVIEW_PLACEHOLDER), also LI.FI's own EVM placeholder for a dry quote. */
const SAMPLE_EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/** A Symbiosis status call as its SDK makes one after a swap (`/v2/tx/<chain>/<hash>`), a shape the proxy forwards. */
const SYMBIOSIS_TX = `/v2/tx/8453/0x${"ab".repeat(32)}`;
/** THORChain's pinned router on Base (protocol-swap2-thorchain THORCHAIN_ROUTERS) and a vault both nodes report. */
const ROUTER = "0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4";
const VAULT = "0x1111111111111111111111111111111111111111";
const INBOUND = [
  {chain: "BASE", address: VAULT, router: ROUTER, halted: false, global_trading_paused: false, chain_trading_paused: false, dust_threshold: "0"},
  {chain: "ETH", address: "0x2222222222222222222222222222222222222222", router: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146", halted: false, dust_threshold: "0"},
];
/**
 * `/thorchain/lastblock`, the same height on both nodes: since protocol-swap2-thorchain 0.4.0 the quoting node must
 * answer it and a confirming node more than 50 blocks behind is skipped. The vault both report is the quoted one, so
 * neither is asked for `vaults/asgard` or `mimir`. This fake proxy forwards it as cp0x-api must (its THORNode
 * pass-through allowed only `inbound_addresses` on 2026-11-13; providers.md §4.3).
 */
const LASTBLOCK = [
  {chain: "BASE", last_observed_in: 38000000, last_signed_out: 38000000, thorchain: 28652739},
  {chain: "ETH", last_observed_in: 23800000, last_signed_out: 23800000, thorchain: 28652739},
];

/** The modules' placeholder key (src/swap/providers.ts PROXY_KEY_PLACEHOLDER): what the proxy replaces with cp0x's. */
const PLACEHOLDER_KEY = "cp0x-swap-web-proxy-adds-the-key";
/** ETH on Base → ETH on Arbitrum: Across serves it (plain SpokePool deposit, priced on Base's relayer fee). */
const ACROSS_PAIR = "./#/?pay=base:native&receive=arbitrum:native&amount=0.1";
/** Base and Arbitrum WETH, and their pinned SpokePools (protocol-swap2-across ACROSS_CHAINS). */
const ACROSS_WETH: Record<number, string> = {8453: "0x4200000000000000000000000000000000000006", 42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"};
const ACROSS_SPOKE: Record<number, string> = {8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", 42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A"};

/** 0x's price answer for the request's own tokens and amount (the shape protocol-swap2-0x reads): 3000 units per 1e18. */
function zeroExPrice(url: URL) {
  const sellAmount = url.searchParams.get("sellAmount") ?? "0";
  const bps = BigInt(url.searchParams.get("slippageBps") ?? "50");
  const buyToken = (url.searchParams.get("buyToken") ?? "").toLowerCase();
  const buyAmount = (BigInt(sellAmount) * 3_000n * 1_000_000n) / 10n ** 18n;
  return {
    allowanceTarget: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    buyAmount: buyAmount.toString(),
    buyToken,
    fees: {integratorFee: null, integratorFees: null, zeroExFee: {amount: "1000", token: buyToken, type: "volume"}, gasFee: null},
    issues: {allowance: null, balance: null, simulationIncomplete: false, invalidSourcesPassed: []},
    liquidityAvailable: true,
    minBuyAmount: (buyAmount - (buyAmount * bps) / 10_000n).toString(),
    mode: "exact-in",
    route: {fills: [{from: ACROSS_WETH[8453], to: buyToken, source: "Uniswap_V3", proportionBps: "10000"}], tokens: []},
    sellAmount,
    sellToken: (url.searchParams.get("sellToken") ?? "").toLowerCase(),
    tokenMetadata: {buyToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}, sellToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}},
    totalNetworkFee: "7000000000000",
    gas: "250000",
    gasPrice: "28000000",
  };
}

/** Across' V5 answer for the request it was sent (6 bps fee): what protocol-swap2-across reads, nothing it doesn't. */
function acrossV5(body: {origin: {token: {chainId: number; address: string}; amount: string}; destination: {token: {chainId: number; address: string}}}) {
  const amount = BigInt(body.origin.amount);
  const fee = (amount * 6n) / 10_000n;
  const token = (t: {chainId: number; address: string}) => ({chainId: t.chainId, address: t.address, decimals: 18, priceUsd: 3000});
  return {
    expectedFillTimeMs: 3000,
    origin: {token: token(body.origin.token), amount: amount.toString(), amountUsd: "300.00"},
    destination: {token: token(body.destination.token), amount: (amount - fee).toString()},
    fee: {totalFee: {amount: fee.toString(), token: token(body.destination.token)}, appFee: {amount: "0"}},
    gasEstimates: [],
  };
}

/** Across' keyless relayer fee (app.across.to/api/suggested-fees, 5 bps) for the deposit the query names. */
function acrossFees(url: URL) {
  const q = url.searchParams;
  const amount = BigInt(q.get("amount") ?? "0");
  const total = (amount * 5n) / 10_000n;
  const origin = Number(q.get("originChainId"));
  const dest = Number(q.get("destinationChainId"));
  return {
    inputToken: {address: q.get("inputToken"), chainId: origin},
    outputToken: {address: q.get("outputToken"), chainId: dest},
    spokePoolAddress: ACROSS_SPOKE[origin],
    destinationSpokePoolAddress: ACROSS_SPOKE[dest],
    totalRelayFee: {pct: "500000000000000", total: total.toString()},
    outputAmount: (amount - total).toString(),
    isAmountTooLow: false,
    timestamp: String(Math.floor(Date.now() / 1000) - 200),
    estimatedFillTimeSec: 2,
  };
}

type ProxyAnswer = (path: string, req: Request) => {status: number; body: unknown; who?: "proxy" | "upstream"} | "abort";

/** What the fake proxy answers by default: health, RPC on the listed networks, THORNode, and venues' upstream refusals. */
const defaultProxy: ProxyAnswer = (path, req) => {
  if (path === "/health") return {status: 200, body: HEALTH};
  // The swap counter (D36): counted, nothing to read.
  if (path === "/sent") return {status: 204, body: null, who: "proxy"};
  if (path === "/venue/thornode/thorchain/inbound_addresses") return {status: 200, body: INBOUND};
  if (path === "/venue/thornode/thorchain/lastblock") return {status: 200, body: LASTBLOCK};
  const rpc = /^\/rpc\/(\d+|solana)$/.exec(path);
  if (rpc) {
    const calls = [req.postDataJSON()].flat() as {id: number; method: string}[];
    const result = (m: string) => ({eth_chainId: "0x2105", eth_gasPrice: "0x3b9aca00", eth_blockNumber: "0x1", eth_getBalance: "0x0"})[m];
    const out = calls.map((c) => (result(c.method) ? {jsonrpc: "2.0", id: c.id, result: result(c.method)} : {jsonrpc: "2.0", id: c.id, error: {code: -32601, message: "fake"}}));
    return {status: 200, body: Array.isArray(req.postDataJSON()) ? out : out[0]};
  }
  // Fynd's own "no route" (422), passed through.
  if (/^\/venue\/fynd\/[a-z]+\/quote$/.test(path)) return {status: 422, body: {error: "no route"}, who: "upstream"};
  // Symbiosis' limits (none binding here), so its SDK goes on to ask for the quote; its status of a transaction it
  // hasn't seen yet.
  if (path === "/venue/symbiosis/v1/swap-limits") return {status: 200, body: [{chainId: 8453, address: "0x0000000000000000000000000000000000000000", min: "0", max: "0"}]};
  if (path.startsWith("/venue/symbiosis/v2/tx/")) return {status: 404, body: {code: 404, message: "Transaction not found"}, who: "upstream"};
  // 0x's price and Across' V5 quote, as their APIs answer through cp0x's slots (D38).
  if (path === "/venue/zeroex/swap/permit2/price") return {status: 200, body: zeroExPrice(new URL(req.url()))};
  if (path === "/venue/across/v1/quotes") return {status: 200, body: acrossV5(req.postDataJSON() as Parameters<typeof acrossV5>[0])};
  // A venue's own refusal, passed through: never retried against the venue.
  if (path.startsWith("/venue/")) return {status: 400, body: {message: "No routes found"}, who: "upstream"};
  return {status: 404, body: {error: "path not allowed"}, who: "proxy"};
};

interface Net {
  /** Every request to the fake cp0x API, as "METHOD /path". */
  proxy: string[];
  /** Every other off-origin request (prices and Liquify included). */
  direct: string[];
  /** Proxy-bound requests carrying a header the real proxy's preflight would refuse, as "METHOD /path: header". */
  unallowed: string[];
}

/**
 * cp0x-api's preflight allow list (`ALLOW_HEADERS`, src/lib/swapWeb/cors.ts), with the headers 0x's and Across'
 * modules send to their slots (D38: `0x-api-key` and `0x-version`, Across' `authorization`), which the proxy must allow
 * in a preflight and then drops (the key) for cp0x's own.
 */
const PROXY_ALLOWED_HEADERS = new Set(["content-type", "accept", "solana-client", "x-cp0x-swap-web", "x-client-id", "0x-api-key", "0x-version", "authorization"]);
/** CORS-safelisted request headers: never asked for in a preflight (Fetch spec). */
const SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type", "range"]);
/** Headers the browser itself sets (forbidden to page scripts, so never in Access-Control-Request-Headers). */
const BROWSER_SET = /^(?:sec-|proxy-)|^(?:user-agent|referer|origin|host|connection|content-length|cookie|accept-encoding|accept-charset|dnt|priority|keep-alive|te|trailer|transfer-encoding|upgrade|via|date|expect)$/;

/** The headers a page script set on `req` that the proxy's preflight would refuse. */
async function unallowedHeaders(req: Request): Promise<string[]> {
  const names = Object.keys(await req.allHeaders()).map((h) => h.toLowerCase());
  return names.filter((h) => !BROWSER_SET.test(h) && !SAFELISTED.has(h) && !PROXY_ALLOWED_HEADERS.has(h));
}

/** The fake proxy, prices, Liquify's THORChain quote; anything else off-origin aborted. */
async function stubNetwork(page: Page, origin: string, answer: ProxyAnswer = defaultProxy): Promise<Net> {
  const net: Net = {proxy: [], direct: [], unallowed: []};
  await page.route(
    (url) => url.origin !== origin,
    async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === E2E_CP0X_API) {
        const path = url.pathname.slice(SWAP_WEB.length);
        net.proxy.push(`${req.method()} ${url.pathname}`);
        // The real preflight would fail: the browser sees a network error and the request never reaches the proxy.
        const unallowed = await unallowedHeaders(req);
        if (unallowed.length) {
          net.unallowed.push(...unallowed.map((h) => `${req.method()} ${url.pathname}: ${h}`));
          return route.abort("failed");
        }
        const a = answer(path, req);
        if (a === "abort") return route.abort("connectionrefused");
        return route.fulfill({
          status: a.status,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": origin,
            "access-control-expose-headers": "retry-after, x-swap-web-answer",
            "x-swap-web-answer": a.who ?? "upstream",
            vary: "Origin",
          },
          body: a.status === 204 ? "" : JSON.stringify(a.body),
        });
      }
      net.direct.push(`${req.method()} ${url.href}`);
      if (url.hostname === "coins.llama.fi") return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({coins: {}})});
      if (url.hostname === "api.coingecko.com") return route.fulfill({status: 200, contentType: "application/json", body: "{}"});
      if (url.hostname === "app.across.to" && url.pathname === "/api/suggested-fees")
        return route.fulfill({status: 200, contentType: "application/json", headers: {"access-control-allow-origin": "*"}, body: JSON.stringify(acrossFees(url))});
      if (url.hostname === "gateway.liquify.com" && url.pathname.endsWith("/thorchain/inbound_addresses"))
        return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(INBOUND)});
      if (url.hostname === "gateway.liquify.com" && url.pathname.endsWith("/thorchain/lastblock"))
        return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(LASTBLOCK)});
      if (url.hostname === "gateway.liquify.com" && url.pathname.endsWith("/thorchain/quote/swap")) {
        const destination = url.searchParams.get("destination") ?? "";
        const quote = {
          expected_amount_out: "9900000",
          inbound_address: VAULT,
          router: ROUTER,
          memo: `=:ETH.ETH:${destination}:9890000`, // within the 0.5 % auto slippage of the expected output
          expiry: Math.floor(Date.now() / 1000) + 600,
          fees: {total_bps: 50},
          recommended_min_amount_in: "100000",
          total_swap_seconds: 60,
        };
        return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(quote)});
      }
      return route.abort("blockedbyclient");
    },
  );
  return net;
}

/** The Settings sheet's Connection section, its info panel (the status line and what goes where) opened. */
async function settingsStatus(page: Page) {
  await page.getByTestId("swap-settings-open").click();
  const section = page.getByTestId("settings-connection");
  await expect(section).toBeVisible();
  await section.getByTestId("settings-connection-info").click();
  await expect(section.getByTestId("settings-connection-about")).toBeVisible();
  return section;
}

const proxied = (net: Net, path: string) => net.proxy.some((p) => p.endsWith(path));
/** A request shaped like Fynd's SDK makes it under the per-chain endpoint the app gives it (src/swap/providers.ts). */
const fyndCall = (page: Page) =>
  page.evaluate(
    (url) =>
      fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: '{"orders":[]}'}).then(
        (r) => r.status,
        (e: unknown) => (e instanceof TypeError ? "network error" : "other error"),
      ),
    `${E2E_CP0X_API}${SWAP_WEB}/venue/fynd/ethereum/v1/quote`,
  );
/** A request shaped like the Symbiosis SDK's status call (`rest` under its base), at the slot the app gives it (src/config/connection.ts). */
const symbiosisStatusCall = (page: Page, rest = SYMBIOSIS_TX) =>
  page.evaluate(
    (url) =>
      fetch(url, {headers: {accept: "application/json"}}).then(
        (r) => r.status,
        (e: unknown) => (e instanceof TypeError ? "network error" : "other error"),
      ),
    `${E2E_CP0X_API}${SWAP_WEB}/venue/symbiosis${rest}`,
  );
const directTo = (net: Net, host: string) => net.direct.filter((d) => new URL(d.split(" ")[1]!).hostname === host);
/** Only the one fake cp0x origin, never another cp0x host. */
const otherCp0x = (requests: readonly string[]) => requests.filter((u) => isCp0xHost(u) && !u.startsWith(E2E_CP0X_API));

test("health read once; keyed venues and listed RPC networks go through cp0x; THORChain confirms there, quotes direct", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);
  await page.goto(PAIR);
  await expect(page.getByTestId("swap-amount")).toHaveValue("0.1");

  await expect.poll(() => proxied(net, "/venue/relay/quote/v2"), {timeout: 15_000}).toBe(true);
  await expect.poll(() => proxied(net, "/rpc/8453"), {timeout: 15_000}).toBe(true);
  await expect.poll(() => proxied(net, "/venue/thornode/thorchain/inbound_addresses"), {timeout: 15_000}).toBe(true);
  await expect.poll(() => proxied(net, "/venue/thornode/thorchain/lastblock"), {timeout: 15_000}).toBe(true);
  await expect.poll(() => directTo(net, "1click.chaindefuser.com").length, {timeout: 15_000}).toBeGreaterThan(0);
  expect(net.proxy.filter((p) => p.endsWith("/health"))).toEqual([`GET ${SWAP_WEB}/health`]);
  // Relay is keyed: its upstream refusal came back through the proxy and was not retried against Relay.
  expect(directTo(net, "api.relay.link")).toEqual([]);
  // NEAR Intents is anonymous: straight to 1Click, never through the proxy.
  expect(net.proxy.some((p) => p.includes("/venue/near_intents"))).toBe(false);
  // Only listed networks reach the proxy; an unused slot sends nothing.
  expect(net.proxy.filter((p) => p.includes("/rpc/") && !/\/rpc\/(8453|solana)$/.test(p))).toEqual([]);
  // THORChain: the quote (and its inbound snapshot) from Liquify, directly; the vault confirmed by the proxy's THORNode.
  expect(directTo(net, "gateway.liquify.com").some((d) => d.includes("/thorchain/quote/swap"))).toBe(true);
  expect(net.proxy.some((p) => p.includes("/thorchain/quote"))).toBe(false);
  await expect(page.getByTestId("swap-route-thorchain")).toBeVisible({timeout: 15_000});

  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-mode-standard")).toBeChecked();
  await expect(section.getByTestId("settings-connection-status")).toHaveText(
    "LI.FI, Relay, Symbiosis and Fynd through cp0x with its keys · RPC for 2 networks through cp0x · THORChain's vault check through cp0x",
  );
  await expect(page.getByTestId("settings-venue-fynd-note")).toHaveText("Standard mode only — asked through cp0x's server");
  await expect(section.getByTestId("settings-connection-privacy")).toContainText("Public and Custom never contact cp0x.");
  await expectNoHorizontalScroll(page);

  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(otherCp0x(watch.requests), "requests to another cp0x host").toEqual([]);
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
});

test("a failed health check leaves the page Public, and Settings says so", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin, (path, req) => (path === "/health" ? "abort" : defaultProxy(path, req)));
  await page.goto(PAIR);
  await expect.poll(() => directTo(net, "api.relay.link").length, {timeout: 15_000}).toBeGreaterThan(0);
  await expect.poll(() => directTo(net, "base-rpc.publicnode.com").length, {timeout: 15_000}).toBeGreaterThan(0);
  await expect.poll(() => directTo(net, "gateway.liquify.com").some((d) => d.includes("/thorchain/quote/swap")), {timeout: 15_000}).toBe(true);
  // LI.FI is left for the live quote (no cp0x key in use): sent nothing, to cp0x or to li.quest.
  await expect(page.getByTestId("swap-deferred-toggle")).toHaveText("Quoted after you connect (1)", {timeout: 15_000});
  expect(directTo(net, "li.quest")).toEqual([]);
  // Nothing but the health check reached the proxy.
  expect(net.proxy).toEqual([`GET ${SWAP_WEB}/health`]);

  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-connection-status")).toHaveText("cp0x API unreachable — using public endpoints.");
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(otherCp0x(watch.requests)).toEqual([]);
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
});

test("a venue whose proxy call fails at the proxy is asked directly, once, and stays direct", async ({page, baseURL}) => {
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin, (path, req) =>
    path.startsWith("/venue/relay") ? {status: 429, body: {error: "daily budget spent"}, who: "proxy"} : defaultProxy(path, req),
  );
  await page.goto(PAIR);
  await expect.poll(() => directTo(net, "api.relay.link").length, {timeout: 15_000}).toBeGreaterThan(0);
  expect(net.proxy.filter((p) => p.includes("/venue/relay"))).toHaveLength(1);
  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-connection-status")).toContainText("Relay asked directly after a cp0x error");
  await expect(section.getByTestId("settings-connection-status")).toContainText("LI.FI, Symbiosis and Fynd through cp0x with its keys");
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
});

test("Symbiosis while keyed: limits, quote and status calls through cp0x; a failure at cp0x sends it to Symbiosis", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);
  await page.goto(PAIR);
  await expect(page.getByTestId("swap-amount")).toHaveValue("0.1");
  // The preview asks Symbiosis (paced: limits, then the quote 1.1 s later), both through the proxy, nothing direct.
  await expect.poll(() => proxied(net, "/venue/symbiosis/v2/quote"), {timeout: 15_000}).toBe(true);
  const symbiosisCalls = net.proxy.filter((p) => p.includes("/venue/symbiosis"));
  expect(symbiosisCalls[0]).toBe(`GET ${SWAP_WEB}/venue/symbiosis/v1/swap-limits`);
  expect(symbiosisCalls.filter((p) => p !== `POST ${SWAP_WEB}/venue/symbiosis/v2/quote`)).toEqual([`GET ${SWAP_WEB}/venue/symbiosis/v1/swap-limits`]);
  expect(directTo(net, "api.symbiosis.finance")).toEqual([]);
  // A status call (made after a swap): through cp0x, Symbiosis' own 404 back untouched, nothing direct.
  expect(await symbiosisStatusCall(page)).toBe(404);
  expect(net.proxy.filter((p) => p.includes("/v2/tx/"))).toEqual([`GET ${SWAP_WEB}/venue/symbiosis${SYMBIOSIS_TX}`]);
  expect(directTo(net, "api.symbiosis.finance")).toEqual([]);
  // A shape the proxy wouldn't take (a query): straight to Symbiosis (aborted here), and Symbiosis stays on cp0x.
  expect(await symbiosisStatusCall(page, `${SYMBIOSIS_TX}?x=1`)).toBe("network error");
  expect(directTo(net, "api.symbiosis.finance")).toEqual([`GET ${SYMBIOSIS}${SYMBIOSIS_TX}?x=1`]);
  expect(net.proxy.filter((p) => p.includes("/v2/tx/"))).toHaveLength(1);
  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-connection-status")).toContainText("LI.FI, Relay, Symbiosis and Fynd through cp0x with its keys");
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);

  // The proxy fails (its own 502): the limits call is asked of Symbiosis directly, once, and Symbiosis stays direct.
  const failing = await page.context().newPage();
  const failingNet = await stubNetwork(failing, origin, (path, req) =>
    path.startsWith("/venue/symbiosis") ? {status: 502, body: {error: "upstream unreachable"}, who: "proxy"} : defaultProxy(path, req),
  );
  await failing.goto(PAIR);
  await expect.poll(() => directTo(failingNet, "api.symbiosis.finance").length, {timeout: 15_000}).toBeGreaterThan(0);
  expect(directTo(failingNet, "api.symbiosis.finance")[0]).toBe(`GET ${SYMBIOSIS}/v1/swap-limits`);
  expect(failingNet.proxy.filter((p) => p.includes("/venue/symbiosis"))).toEqual([`GET ${SWAP_WEB}/venue/symbiosis/v1/swap-limits`]);
  const failed = await settingsStatus(failing);
  await expect(failed.getByTestId("settings-connection-status")).toContainText("LI.FI, Relay and Fynd through cp0x with its keys");
  await expect(failed.getByTestId("settings-connection-status")).toContainText("Symbiosis asked directly after a cp0x error");
  expect(failingNet.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
});

test("LI.FI in a preview: through cp0x while keyed; otherwise quoted after you connect; after a cp0x failure one direct call, then none", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const lifiUrls: string[] = [];
  const net = await stubNetwork(page, origin, (path, req) => {
    if (path.startsWith("/venue/lifi")) lifiUrls.push(req.url());
    return defaultProxy(path, req);
  });
  await page.goto(PAIR);
  // Keyed at cp0x: the preview asks LI.FI through the proxy (its own "No routes found" passed through), never li.quest.
  await expect.poll(() => lifiUrls.length, {timeout: 15_000}).toBeGreaterThan(0);
  const quote = new URL(lifiUrls[0]!);
  expect(quote.pathname).toBe(`${SWAP_WEB}/venue/lifi/quote`);
  // EVM → EVM keeps LI.FI's own handling of a blank recipient: its EVM placeholder (the EVM sample) on both sides.
  expect([quote.searchParams.get("fromAddress"), quote.searchParams.get("toAddress")]).toEqual([SAMPLE_EVM, SAMPLE_EVM]);
  await expect(page.getByTestId("swap-route-thorchain")).toBeVisible({timeout: 15_000});
  await page.getByTestId("swap-refused-toggle").click();
  await expect(page.getByTestId("swap-route-refused-lifi")).toContainText("No route for this pair or amount");
  await expect(page.getByTestId("swap-deferred-toggle")).toHaveCount(0);
  expect(directTo(net, "li.quest")).toEqual([]);
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);

  // Anonymous at cp0x: LI.FI waits for the live quote in its own quiet group, sent nothing — to cp0x or to li.quest.
  const anon = await page.context().newPage();
  const anonNet = await stubNetwork(anon, origin, (path, req) =>
    path === "/health" ? {status: 200, body: {...HEALTH, venues: {...HEALTH.venues, lifi: "anonymous"}}} : defaultProxy(path, req),
  );
  await anon.goto(PAIR);
  const deferred = anon.getByTestId("swap-deferred-toggle");
  await expect(deferred).toHaveText("Quoted after you connect (1)", {timeout: 15_000});
  await deferred.click();
  await expect(anon.getByRole("list", {name: "Quoted after you connect"}).getByTestId("swap-route-refused-lifi")).toContainText("Connect a wallet to get this quote");
  await expect(anon.getByTestId("swap-route-thorchain")).toBeVisible({timeout: 15_000});
  expect(anonNet.proxy.filter((p) => p.includes("/venue/lifi"))).toEqual([]);
  expect(directTo(anonNet, "li.quest")).toEqual([]);

  // A failure at cp0x (the proxy's own 502): the preview's call is retried at li.quest once (aborted here) and LI.FI is
  // stopped; the next preview round leaves it for the live quote and sends nothing anywhere.
  const failing = await page.context().newPage();
  const failingNet = await stubNetwork(failing, origin, (path, req) =>
    path.startsWith("/venue/lifi") ? {status: 502, body: {error: "upstream unreachable"}, who: "proxy"} : defaultProxy(path, req),
  );
  await failing.goto(PAIR);
  await expect.poll(() => directTo(failingNet, "li.quest").length, {timeout: 15_000}).toBe(1);
  await expect(failing.getByTestId("swap-route-thorchain")).toBeVisible({timeout: 15_000});
  expect(failingNet.proxy.filter((p) => p.includes("/venue/lifi"))).toEqual([`GET ${SWAP_WEB}/venue/lifi/quote`]);
  await failing.getByTestId("swap-amount").fill("0.2");
  await expect(failing.getByTestId("swap-deferred-toggle")).toHaveText("Quoted after you connect (1)", {timeout: 15_000});
  await expect(failing.getByTestId("swap-route-thorchain")).toBeVisible({timeout: 15_000});
  expect(failingNet.proxy.filter((p) => p.includes("/venue/lifi"))).toHaveLength(1);
  expect(directTo(failingNet, "li.quest")).toHaveLength(1);
  const section = await settingsStatus(failing);
  await expect(section.getByTestId("settings-connection-status")).toContainText("LI.FI asked directly after a cp0x error");
});

test("Fynd goes only through cp0x: at the hosted API's path while keyed; with no key at cp0x nothing is sent anywhere", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const orders: unknown[] = [];
  const net = await stubNetwork(page, origin, (path, req) => {
    if (path === "/venue/fynd/base/quote") orders.push(...(req.postDataJSON() as {orders: unknown[]}).orders);
    return defaultProxy(path, req);
  });
  await page.goto(SAME_NETWORK);
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  // The preview round counts Fynd (keyed, same-network Base) and asks its SDK through cp0x (D7): the SDK's `/v1/quote`
  // becomes the hosted API's `<chain>/quote`, Fynd's own 422 "no route" comes back as the row, nothing goes to Fynd.
  await page.getByTestId("swap-amount").fill("0.1");
  await expect(page.getByTestId("swap-route-refused-fynd")).toContainText("No route for this pair or amount", {timeout: 15_000});
  expect(net.proxy.filter((p) => p.includes("/venue/fynd"))).toEqual([`POST ${SWAP_WEB}/venue/fynd/base/quote`]);
  expect(directTo(net, "fynd-api.propellerheads.xyz")).toEqual([]);
  // Its SDK refuses a blank recipient, so the preview gave it the EVM sample — its sender too, with no wallet. The
  // sample never shows: the row reads in the classifier's words.
  expect(orders).toEqual([expect.objectContaining({token_in: "0x0000000000000000000000000000000000000000", side: "sell", sender: SAMPLE_EVM, receiver: SAMPLE_EVM})]);
  await expect(page.getByTestId("swap-routes")).not.toContainText(/0xd8da/i);
  // A call shaped like its SDK's, for another chain: through the proxy the same way.
  expect(await fyndCall(page)).toBe(422);
  expect(net.proxy.filter((p) => p.includes("/venue/fynd"))).toEqual([`POST ${SWAP_WEB}/venue/fynd/base/quote`, `POST ${SWAP_WEB}/venue/fynd/ethereum/quote`]);
  expect(directTo(net, "fynd-api.propellerheads.xyz")).toEqual([]);
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);

  // cp0x holds no Fynd key: the call fails in the page WITHOUT a request (no direct Fynd: its API has no CORS).
  const anon = await page.context().newPage();
  const anonNet = await stubNetwork(anon, origin, (path, req) =>
    path === "/health" ? {status: 200, body: {...HEALTH, venues: {...HEALTH.venues, fynd: "anonymous"}}} : defaultProxy(path, req),
  );
  await anon.goto("./#/");
  await expect(anon.getByTestId("swap-amount")).toBeVisible();
  await expect.poll(() => anonNet.proxy.filter((p) => p.endsWith("/health")).length, {timeout: 15_000}).toBe(1);
  expect(await fyndCall(anon)).toBe("network error");
  expect(anonNet.proxy.filter((p) => p.includes("/venue/fynd"))).toEqual([]);
  expect(directTo(anonNet, "fynd-api.propellerheads.xyz")).toEqual([]);
  const section = await settingsStatus(anon);
  await expect(section.getByTestId("settings-connection-status")).toHaveText(
    "LI.FI, Relay and Symbiosis through cp0x with its keys · RPC for 2 networks through cp0x · THORChain's vault check through cp0x",
  );
  await expect(anon.getByTestId("settings-venue-fynd-note")).toHaveText("Standard mode only — cp0x holds no key for it yet");
});

test("0x and Across go only through cp0x (D38): keyed, their price rounds reach the slots with the placeholder key; unkeyed or in Public, nothing", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const keyed = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed", across: "keyed"}};
  const seen: {path: string; method: string; headers: Record<string, string>}[] = [];
  const net = await stubNetwork(page, origin, (path, req) => {
    if (path === "/health") return {status: 200, body: keyed};
    if (path.startsWith("/venue/zeroex") || path.startsWith("/venue/across")) seen.push({path, method: req.method(), headers: req.headers()});
    return defaultProxy(path, req);
  });
  const directHeaders: {url: string; headers: Record<string, string>}[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (/(^|\.)across\.to$|(^|\.)0x\.org$/.test(host)) directHeaders.push({url: r.url(), headers: r.headers()});
  });

  // 0x: a same-network preview on Base (ETH → USDC) asks its price endpoint through the proxy and lists its route.
  await page.goto(SAME_NETWORK);
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  await page.getByTestId("swap-amount").fill("0.1");
  await expect(page.getByTestId("swap-route-zeroex")).toBeVisible({timeout: 15_000});
  const zx = seen.find((x) => x.path.startsWith("/venue/zeroex"))!;
  expect(zx).toMatchObject({path: "/venue/zeroex/swap/permit2/price", method: "GET"});
  expect(zx.headers["0x-api-key"]).toBe(PLACEHOLDER_KEY);
  expect(zx.headers["0x-version"]).toBe("v2");
  expect(net.proxy).toContain(`GET ${SWAP_WEB}/venue/zeroex/swap/permit2/price`);

  // Across: Base ETH → Arbitrum ETH, V5 through the proxy, its keyless relayer fee straight from app.across.to. (A new
  // load: the form reads the hash's pair when the page opens.)
  await page.goto(ACROSS_PAIR);
  await page.reload();
  await expect(page.getByTestId("swap-amount")).toHaveValue("0.1");
  await expect(page.getByTestId("swap-route-across")).toBeVisible({timeout: 15_000});
  const ac = seen.find((x) => x.path.startsWith("/venue/across"))!;
  expect(ac).toMatchObject({path: "/venue/across/v1/quotes", method: "POST"});
  expect(ac.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
  const fees = directTo(net, "app.across.to");
  expect(fees.length).toBeGreaterThan(0);
  expect(fees.every((d) => new URL(d.split(" ")[1]!).pathname === "/api/suggested-fees")).toBe(true);

  // The placeholder only ever goes to the proxy; neither venue's keyed API is contacted from the page.
  expect(directTo(net, "api.0x.org")).toEqual([]);
  expect(directTo(net, "api.across.to")).toEqual([]);
  expect(directHeaders.every((d) => new URL(d.url).hostname === "app.across.to" && !d.headers.authorization && !d.headers["0x-api-key"])).toBe(true);
  expect(watch.requests.filter((u) => /0x\.org|api\.across\.to/.test(u))).toEqual([]);
  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-connection-status")).toContainText("LI.FI, Relay, Symbiosis, Fynd, 0x and Across through cp0x with its keys");
  await expect(page.getByTestId("settings-venue-zeroex-note")).toHaveText("Standard mode only — asked through cp0x's server");
  await expect(page.getByTestId("settings-venue-across-note")).toHaveText("Standard mode only — asked through cp0x's server");
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(otherCp0x(watch.requests), "requests to another cp0x host").toEqual([]);

  // cp0x holds no 0x or Across key (the default health): neither is asked, nothing reaches their slots or hosts.
  const anon = await page.context().newPage();
  const anonNet = await stubNetwork(anon, origin);
  await anon.goto(ACROSS_PAIR);
  await expect.poll(() => proxied(anonNet, "/venue/relay/quote/v2"), {timeout: 15_000}).toBe(true);
  await anon.goto(`${SAME_NETWORK}&amount=0.1`);
  await anon.reload();
  await expect.poll(() => anonNet.proxy.filter((p) => p.endsWith("/health")).length, {timeout: 15_000}).toBe(2);
  await anon.waitForTimeout(1_500);
  expect(anonNet.proxy.filter((p) => p.includes("/venue/zeroex") || p.includes("/venue/across"))).toEqual([]);
  expect(anonNet.direct.filter((d) => /0x\.org|across\.to/.test(d))).toEqual([]);
  await expect(anon.getByTestId("swap-route-zeroex")).toHaveCount(0);
  await expect(anon.getByTestId("swap-route-across")).toHaveCount(0);
  await settingsStatus(anon);
  await expect(anon.getByTestId("settings-venue-zeroex-note")).toHaveText("Standard mode only — cp0x holds no key for it yet");
  await expect(anon.getByTestId("settings-venue-across-note")).toHaveText("Standard mode only — cp0x holds no key for it yet");

  // Public: never built, never asked — not even with cp0x keying both.
  const pub = await page.context().newPage();
  await pub.addInitScript(() => localStorage.setItem("cp0x.swap.connection.v1", JSON.stringify({mode: "public"})));
  const pubNet = await stubNetwork(pub, origin, (path, req) => (path === "/health" ? {status: 200, body: keyed} : defaultProxy(path, req)));
  await pub.goto(ACROSS_PAIR);
  await expect.poll(() => directTo(pubNet, "api.relay.link").length, {timeout: 15_000}).toBeGreaterThan(0);
  await pub.waitForTimeout(1_000);
  expect(pubNet.proxy).toEqual([]);
  expect(pubNet.direct.filter((d) => /0x\.org|across\.to/.test(d))).toEqual([]);
  await expect(pub.getByTestId("swap-route-across")).toHaveCount(0);
  await settingsStatus(pub);
  await expect(pub.getByTestId("settings-venue-zeroex-note")).toHaveText("Standard mode only — not asked in this mode");
});

test("a header the proxy's CORS preflight doesn't allow is caught, and fails the call the way the browser would", async ({page, baseURL}) => {
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);
  await page.goto("./#/");
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  const outcome = await page.evaluate(
    (url) =>
      fetch(url, {method: "POST", headers: {"content-type": "application/json", "x-not-allowed": "1"}, body: "{}"}).then(
        () => "answered",
        () => "network error",
      ),
    `${E2E_CP0X_API}${SWAP_WEB}/rpc/8453`,
  );
  expect(outcome).toBe("network error");
  expect(net.unallowed).toEqual([`POST ${SWAP_WEB}/rpc/8453: x-not-allowed`]);
});

test("Public chosen in Settings never contacts cp0x, not even for health", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(() => localStorage.setItem("cp0x.swap.connection.v1", JSON.stringify({mode: "public"})));
  const net = await stubNetwork(page, origin);
  await page.goto(PAIR);
  await expect.poll(() => directTo(net, "api.relay.link").length, {timeout: 15_000}).toBeGreaterThan(0);
  // LI.FI's keyless quota is the visitor's own: the preview leaves it for the live quote and asks li.quest nothing.
  await expect(page.getByTestId("swap-deferred-toggle")).toHaveText("Quoted after you connect (1)", {timeout: 15_000});
  await page.waitForTimeout(500);
  expect(net.proxy).toEqual([]);
  expect(directTo(net, "li.quest")).toEqual([]);
  const section = await settingsStatus(page);
  await expect(section.getByTestId("settings-mode-public")).toBeChecked();
  await expect(section.getByTestId("settings-connection-status")).toHaveCount(0);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x host").toEqual([]);
});

/** 1Click and the Tron API for a TronLink payer's swap (fakeTron.ts); every other request goes on to stubNetwork's handler. */
async function stubTron(page: Page, origin: string): Promise<TronSeen> {
  const seen = newTronSeen();
  await page.route(
    (url) => url.origin !== origin,
    async (route: Route) => {
      if (!(await answerTronSwap(route, seen))) await route.fallback();
    },
  );
  return seen;
}

/** USDT on Tron → USDC on Base through NEAR Intents, TronLink signing at once; returns once the page broadcast it. */
async function sendTronSwap(page: Page, tron: TronSeen): Promise<void> {
  const {answer} = await injectTronLink(page);
  answer();
  await page.goto(`./#/?pay=${USDT_TRON}&receive=${USDC_BASE}&amount=25`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tron:org.tronlink.www").click();
  await expect(page.getByTestId("swap-wallet-pill-tron")).toBeVisible();
  await page.getByTestId("swap-recipient").fill(RECIPIENT);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via NEAR Intents", {timeout: 20_000});
  await page.getByTestId("swap-review").click();
  const confirm = page.getByTestId("swap-confirm");
  await expect(confirm).toBeEnabled({timeout: 20_000});
  await confirm.click();
  await expect.poll(() => tron.broadcasts.length, {timeout: 20_000}).toBe(1);
  await expect(page.getByTestId("swap-status")).toBeVisible({timeout: 10_000});
}

test("a swap the wallet broadcasts is reported once: one POST /sent, amounts rounded, no address or hash, never again after a reload", async ({page, baseURL}) => {
  test.setTimeout(120_000);
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const counted: {body: unknown; contentType: string | undefined}[] = [];
  const net = await stubNetwork(page, origin, (path, req) => {
    if (path === "/sent") counted.push({body: req.postDataJSON(), contentType: req.headers()["content-type"]});
    return defaultProxy(path, req);
  });
  const tron = await stubTron(page, origin);
  await sendTronSwap(page, tron);

  await expect.poll(() => counted.length, {timeout: 10_000}).toBe(1);
  // The report (D41): the venue, networks, mode, tokens, amounts to 3 significant figures, a random report id — no
  // address or hash. A simple request (no preflight).
  const body = counted[0]!.body as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(
    ["amountIn", "expectedOut", "from", "id", "minOut", "mode", "slippageBps", "to", "tokenIn", "tokenOut", "venue", ...("usdIn" in body ? ["usdIn"] : [])].sort(),
  );
  expect(body).toMatchObject({venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "wallet", tokenIn: "USDT", id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/)});
  for (const k of ["amountIn", "expectedOut", "minOut"]) expect(String(body[k]).replace(/^0\.0*|\./g, "").replace(/0+$/, "").length, k).toBeLessThanOrEqual(3);
  expect(JSON.stringify(body)).not.toContain(RECIPIENT);
  expect(counted[0]!.contentType).toMatch(/^text\/plain/);
  // The engine's handover and the tracker's polls send nothing more.
  await page.waitForTimeout(1_500);
  expect(net.proxy.filter((p) => p.endsWith("/sent"))).toEqual([`POST ${SWAP_WEB}/sent`]);

  // A reload reads the record back, already counted: the tracker follows it, nothing is counted again.
  await page.reload();
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  await expect.poll(() => net.proxy.filter((p) => p.endsWith("/health")).length, {timeout: 15_000}).toBe(2);
  await page.waitForTimeout(2_000);
  expect(counted).toHaveLength(1);

  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(otherCp0x(watch.requests), "requests to another cp0x host").toEqual([]);
  expect(net.unallowed, "headers the proxy's CORS preflight refuses").toEqual([]);
});

test("Public: a swap the wallet broadcasts is not counted — nothing reaches cp0x", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(() => localStorage.setItem("cp0x.swap.connection.v1", JSON.stringify({mode: "public"})));
  const net = await stubNetwork(page, origin);
  const tron = await stubTron(page, origin);
  await sendTronSwap(page, tron);
  await page.waitForTimeout(1_500);
  expect(net.proxy).toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x host").toEqual([]);
});
