/**
 * TON in the real app (D11, D20): a fake Tonkeeper whose in-app browser runs the page (TON Connect's JS bridge,
 * `isWalletBrowser`) — it records every request and returns a signed-looking message, so nothing is ever broadcast.
 * The network is stubbed: prices, 1Click (NEAR Intents) and TonAPI answer; anything else is aborted and recorded.
 * - Before a TON wallet: TON pays by QR (the refund box), which also offers the wallet; nothing TON is contacted.
 * - The wallet the page runs in connects from our menu through its JS bridge, without TON Connect's modal: the swap's
 *   one TON Connect request is exactly the reviewed deposit — the 1Click deposit address, the reviewed amount,
 *   mainnet, from the connected account — and neither TON's remote wallets list, its analytics nor any bridge is
 *   contacted.
 * - "TON Connect" closes our menu and opens TON Connect UI's own modal (owner, 2026-11-13) over the self-hosted
 *   official list: every icon from this origin, nothing from TON's or GitHub's hosts, no CSP violation, nothing left
 *   in sessionStorage. The bridges of the list are contacted only after that pick (the accepted cost of its universal
 *   QR), and no more once the viewer closes it; TON stays disconnected and the menu usable.
 * - A "TON Connect" that can't start — our list unreadable (the SDK would fall back to its own: remote icons, other
 *   bridges), then TON Connect UI's chunk unreachable — opens no modal and reopens our menu with the reason.
 * - A TON contract call (D35): USDT on TON → USDC on Arbitrum (a direct release) through Symbiosis, its API answering
 *   with a dry quote recorded 2026-11-13 (tests/unit/execute/symbiosisTon.fixture.json, for the address it was built
 *   for). The one TON Connect request is the payer's USDT jetton wallet, the TON the venue attached, and the venue's
 *   exact BoC; an answer tampered after the review (the same jetton wallet, non-bounceable: the venue's own check reads
 *   only the raw address) is refused before the wallet is asked.
 * - Omniston's escrow (D35 part B): USDT on TON → USDC on Base, its WebSocket API (JSON-RPC) answering from the live rev2
 *   capture of 2026-11-11 (tests/unit/execute/omnistonEscrowRev2.fixture.json) and building the escrow with the hashlock
 *   the page asked for. The one TON Connect request is the payer's USDT jetton wallet, 0.4 TON and that exact escrow,
 *   whose hashlock is the hash of the one secret IndexedDB holds for the quote; a build that forwards the minter too
 *   little TON, has the minter forward the escrow too little to deploy it, or refunds a failed creation to another
 *   wallet (each of which Omniston's package lets through) is refused before the wallet is asked.
 * - Omniston's swap on TON (D35 part C): 2 TON → USDT, its WebSocket API answering with the SDK's recording of
 *   2026-10-22 through DeDust v1 (tests/unit/execute/omnistonSwaps.fixture.json), TonAPI with what the package's own
 *   build checks read. The route is offered (one step through a pinned DEX), and the one TON Connect request is DeDust's
 *   pinned native vault, the input plus 0.1 TON and the exact recorded body; re-routed after the review through DeDust
 *   CPMM v2 (its package's checks pass it; no pin names the pool), it is refused before the wallet is asked.
 */
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import {Address, Cell, beginCell, storeMessage} from "@ton/core";
import {keccak256} from "viem";
import {expect, test, type Page} from "@playwright/test";
import {isCp0xHost, isPhone, watchPage} from "./helpers";

const RAW = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";
const FRIENDLY = Address.parseRaw(RAW).toString({urlSafe: true, bounceable: false});
const DEPOSIT = Address.parseRaw(`0:${"ab".repeat(32)}`).toString({urlSafe: true, bounceable: false});
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC_BASE = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** What the fake wallet answers to sendTransaction: an external message to the connected wallet (never sent). */
const signedBy = (raw: string) =>
  beginCell()
    .store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(raw), importFee: 0n}, init: null, body: beginCell().storeUint(1, 32).endCell()}))
    .endCell()
    .toBoc()
    .toString("base64");

/** Hosts this run answers; everything else off the page's origin is aborted and recorded. */
async function stubNetwork(page: Page, origin: string) {
  const unexpected: string[] = [];
  const tonapi: string[] = [];
  const quotes: {dry: boolean; refundTo: string; recipient: string}[] = [];
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "1click.chaindefuser.com") {
        if (url.pathname.endsWith("/quote")) {
          const body = JSON.parse(route.request().postData() ?? "{}") as {dry: boolean; amount: string; refundTo: string; recipient: string};
          quotes.push({dry: body.dry, refundTo: body.refundTo, recipient: body.recipient});
          return json({
            quote: {
              ...(body.dry ? {} : {depositAddress: DEPOSIT}),
              amountIn: body.amount,
              amountOut: "15000000",
              minAmountOut: "15000000",
              amountInUsd: "15",
              amountOutUsd: "15",
              deadline: new Date(Date.now() + 3_600_000).toISOString(),
              timeEstimate: 60,
            },
          });
        }
        if (url.pathname.endsWith("/status")) return json({status: "PENDING_DEPOSIT"});
        return json({});
      }
      if (url.hostname === "tonapi.io") {
        tonapi.push(url.pathname);
        if (url.pathname.endsWith("/jettons")) return json({balances: []});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${RAW}","balance":10000000000,"status":"active"}`});
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return {unexpected, tonapi, quotes};
}

/** Hosts TON Connect could reach but must not: its remote list and analytics, GitHub's assets, the 3D diamond's host. */
const TON_HOSTS = ["config.ton.org", "analytics.ton.org", "raw.githubusercontent.com", "s.ton-connect.io"];
/** The SSE bridges of the self-hosted official list (the modal's universal QR listens on all of them). */
const BRIDGE_HOSTS = new Set(
  (JSON.parse(readFileSync("public/tonconnect-wallets.json", "utf8")) as {bridge: {type: string; url?: string}[]}[]).flatMap((w) =>
    w.bridge.flatMap((b) => (b.type === "sse" && b.url ? [new URL(b.url).hostname] : [])),
  ),
);
const toBridge = (url: string) => BRIDGE_HOSTS.has(new URL(url).hostname);

/** Tonkeeper's in-app browser stand-in: TON Connect's JS bridge (window.tonkeeper.tonconnect) with isWalletBrowser. */
async function injectFakeTonkeeper(page: Page, raw = RAW) {
  await page.addInitScript(
    ({raw, signed}) => {
      const device = {platform: "iphone", appName: "Tonkeeper", appVersion: "4.0.0", maxProtocolVersion: 2, features: ["SendTransaction", {name: "SendTransaction", maxMessages: 4}]};
      const w = window as unknown as {__tonSent: unknown[]; tonkeeper: unknown};
      w.__tonSent = [];
      w.tonkeeper = {
        tonconnect: {
          deviceInfo: device,
          walletInfo: {name: "Tonkeeper", app_name: "tonkeeper", image: "", about_url: "", tondns: "", platforms: ["ios", "android"]},
          protocolVersion: 2,
          isWalletBrowser: true,
          connect: async () => ({event: "connect", id: 1, payload: {items: [{name: "ton_addr", address: raw, network: "-239", publicKey: "00".repeat(32), walletStateInit: ""}], device}}),
          restoreConnection: async () => ({event: "connect_error", id: 1, payload: {code: 0, message: "no session"}}),
          send: async (message: {id: string}) => {
            w.__tonSent.push(message);
            return {result: signed, id: message.id};
          },
          listen: () => () => undefined,
        },
      };
    },
    {raw, signed: signedBy(raw)},
  );
}

test("TON: pays by QR until the wallet the page runs in connects, without the modal; then signs exactly the reviewed deposit, contacting nothing TON-side but TonAPI", async ({page, baseURL}) => {
  test.setTimeout(60_000);
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);
  await injectFakeTonkeeper(page);

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  // No TON wallet yet: the QR payment with its refund address, and the wallet offered beside it.
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  await expect(page.getByTestId("swap-review")).toHaveText(/refund address/i);
  expect(net.tonapi, "TonAPI before a TON wallet").toEqual([]);

  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect:tonkeeper")).toContainText("Installed");
  await expect(page.getByTestId("swap-connect-tonconnect")).toBeVisible();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  await expect(page.getByTestId("swap-refund-box")).toHaveCount(0);
  // Straight through the bridge: TON Connect UI was never built.
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);

  // A TON wallet pays now; the payout goes to a typed Base address (no EVM wallet here).
  await page.getByTestId("swap-recipient").fill(RECIPIENT);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via NEAR Intents", {timeout: 20_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 20_000});
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent.length), {timeout: 20_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: RAW});
  expect(tx.messages).toHaveLength(1);
  expect(tx.messages[0]).toMatchObject({address: DEPOSIT, amount: "5000000000"});
  expect(tx.messages[0]!.payload).toBeUndefined();
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  // The live quote was asked with the connected wallet as the refund address and the typed recipient.
  expect(net.quotes.filter((q) => !q.dry).at(-1)).toEqual({dry: false, refundTo: FRIENDLY, recipient: RECIPIENT});

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  // Venues that don't serve TON are blocked here on purpose and log "Failed to load resource"; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: TON Connect closes our menu and opens the official modal, icons from this origin; its bridges only after the pick, until it closes", async ({page, baseURL}, info) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect")).toContainText("Tonkeeper, MyTonWallet and other TON wallets");
  await page.waitForTimeout(500);
  expect(watch.requests.filter(toBridge), "a TON bridge before the pick").toEqual([]);
  expect(watch.requests.filter((u) => u.includes("tonconnect-wallets.json")), "the wallets list before the pick").toEqual([]);

  await page.getByTestId("swap-connect-tonconnect").click();
  // Our menu is gone first (a modal dialog: it would trap focus and block the pointer), then the official modal opens.
  await expect(page.getByTestId("swap-connect")).toHaveCount(0);
  const modal = page.locator("[data-tc-wallets-modal-container]");
  await expect(modal).toBeVisible({timeout: 10_000});
  await expect(modal.locator("[data-tc-wallet-item]").first()).toBeVisible();
  expect(await modal.locator("[data-tc-wallet-item]").count()).toBeGreaterThanOrEqual(3);
  // Its icons are the bundled copies (rendered once loaded): every image on the page from this origin.
  await expect(modal.locator("img[src*='logos/ton-wallets/']").first()).toBeVisible();
  const srcs = await page.locator("#tc-widget-root img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.filter((u) => !u.startsWith(`${origin}/`)), "an icon from another origin").toEqual([]);
  expect(watch.requests.filter((u) => u.includes("tonconnect-wallets.json")).every((u) => u.startsWith(`${origin}/`))).toBe(true);
  // Loading it copied the page's hash query into sessionStorage as Telegram launch params; that is gone.
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ton-connect")))).toEqual([]);
  // The wide modal shows its universal QR at once, which listens on every bridge in the list (the phone's on a tap).
  if (!isPhone(info)) await expect.poll(() => net.unexpected.filter(toBridge).length, {timeout: 10_000}).toBeGreaterThan(0);

  // The viewer closes it: TON stays disconnected, the bridges it listened on stop being contacted, the menu works.
  await page.locator("#tc-widget-root [data-tc-modal] button[data-tc-icon-button]").first().click();
  await expect(modal).toBeHidden();
  await page.waitForTimeout(500);
  const bridgeTries = () => net.unexpected.filter(toBridge).length;
  const tries = bridgeTries();
  await page.waitForTimeout(4_500);
  expect(bridgeTries(), "bridge requests after the modal closed").toBe(tries);
  await expect(page.getByTestId("swap-wallet-pill-ton")).toHaveCount(0);
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect")).toBeEnabled();
  await expect(page.getByTestId("swap-connect-error")).toHaveCount(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => /CSP violation/.test(e)), "CSP violations").toEqual([]);
  // The bridges are blocked here on purpose: their failed connections may log; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource|TON_CONNECT|EventSource|bridge/i.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: a TON Connect that can't start opens no modal and reopens our menu with the reason — our list unreadable, then its chunk", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  await stubNetwork(page, origin);
  // A gateway that lost the list (the SDK alone would show its own bundled list: remote icons, other bridges).
  await page.route(`${origin}/tonconnect-wallets.json`, (route) => route.fulfill({status: 404, body: "not found"}));

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect").click();
  // No click more: the menu is back, on TON, with the reason.
  await expect(page.getByTestId("swap-connect-error")).toHaveText("TON Connect's wallet list didn't load — check your connection and try again.", {timeout: 10_000});
  await expect(page.locator("section[aria-label='TON wallets'] [data-testid='swap-connect-tonconnect']")).toBeEnabled();
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);

  // The list is back but TON Connect UI's chunk can't be fetched (a redeploy replaced it, the network dropped).
  await page.unroute(`${origin}/tonconnect-wallets.json`);
  await page.route(`${origin}/assets/*.js`, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    if (body.includes("data-tc-wallets-modal-container")) return route.abort("failed");
    return route.fulfill({response: res, body});
  });
  await page.getByTestId("swap-connect-tonconnect").click();
  await expect(page.getByTestId("swap-connect-error")).toHaveText("TON Connect didn't load — check your connection and try again.", {timeout: 10_000});
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);
  await expect(page.getByTestId("swap-wallet-pill-ton")).toHaveCount(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  // Any bridge, ours or the SDK's own list's: TON Connect listens at <bridge>/events.
  expect(watch.requests.filter((u) => toBridge(u) || new URL(u).pathname.endsWith("/events")), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => /CSP violation/.test(e)), "CSP violations").toEqual([]);
  // The 404, the aborted chunk and the SDK's note on the list log; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource|TON_CONNECT/i.test(e)), "page errors / console errors").toEqual([]);
});

// ── a TON contract call: Symbiosis paid in USDT (D35) ───────────────────────────────────────────────────────────────

/** A recorded Symbiosis dry quote: 50 USDT on TON → USDC on Arbitrum (a direct release), built for the module's TON placeholder. */
const SYM = (JSON.parse(readFileSync("tests/unit/execute/symbiosisTon.fixture.json", "utf8")) as {live: SymbiosisRecording}).live;
const USDC_ARB = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
interface SymbiosisRecording {
  params: {destAddress: string};
  limits: unknown[];
  response: {tx: {validUntil: number; messages: {address: string; amount: string; payload: string}[]}};
  quote: {tonTo: string; tonValue: string; tonBody: string};
}
/** The sender it was built for, and its USDT jetton wallet (computed from the pinned wallet code). */
const SYM_RAW = "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8";
const SYM_JW = "0:2f2f33ae6dd9c0b6fee08cef597eb00a9d5925152ff8c46ee2417ceb7f296598";
const USDT_RAW = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
const USDT_TON = "ton:eqcxe6mutqjkfngfarotkot1lzbdiix1kcixrv7nw2id_sds";

/**
 * Prices, TonAPI (the payer's TON and USDT, its USDT jetton wallet and that wallet's state) and Symbiosis' API (its
 * limits, the recorded quote with a fresh expiry; `tamper` rewrites the message it carries); anything else off the
 * page's origin is aborted and recorded.
 */
async function stubSymbiosis(page: Page, origin: string) {
  const unexpected: string[] = [];
  const quotes: number[] = [];
  const state: {tamper?: (m: {address: string; amount: string}) => void} = {};
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "tonapi.io") {
        if (url.pathname.endsWith("/methods/get_wallet_address")) return json({success: true, decoded: {jetton_wallet_address: SYM_JW}});
        if (url.pathname.endsWith("/methods/get_wallet_data")) return json({success: true, decoded: {balance: "100000000", owner: SYM_RAW, jetton: USDT_RAW}});
        if (url.pathname.endsWith("/jettons")) return json({balances: [{balance: "100000000", jetton: {address: USDT_RAW}}]});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${SYM_RAW}","balance":10000000000,"status":"active"}`});
      }
      if (url.hostname === "api.symbiosis.finance") {
        if (url.pathname.endsWith("/v1/swap-limits")) return json(SYM.limits);
        if (url.pathname.endsWith("/v2/quote")) {
          quotes.push(Date.now());
          const answer = structuredClone(SYM.response);
          answer.tx.validUntil = Math.floor(Date.now() / 1000) + 600;
          state.tamper?.(answer.tx.messages[0]!);
          return json(answer);
        }
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return {unexpected, quotes, state};
}

/** Pay 50 USDT from the fake Tonkeeper (the recording's sender) for USDC on Arbitrum to its recipient at 0.5 %; open the review. */
async function reviewSymbiosis(page: Page) {
  await page.goto(`./#/?pay=${USDT_TON}&receive=${USDC_ARB}&amount=50`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  // The recording was asked with 0.5 % slippage: the review and its live quote are asked as it was.
  await page.getByTestId("swap-slippage").click();
  const sheet = page.getByRole("dialog", {name: "Max slippage"});
  // 0.5 % is typed: the presets are 0.01 %, 0.05 % and 0.3 %.
  await sheet.getByLabel("Custom").fill("0.5");
  await sheet.getByLabel("Custom").press("Enter");
  await expect(sheet).toBeHidden();
  await page.getByTestId("swap-recipient").fill(SYM.params.destAddress);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via Symbiosis", {timeout: 30_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 30_000});
}

const tonSent = (page: Page) => page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent.length);

test("TON: Symbiosis from a TON wallet signs one jetton transfer — the payer's USDT jetton wallet, the TON it attaches, the venue's exact BoC", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubSymbiosis(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SYM_RAW);
  await reviewSymbiosis(page);
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => tonSent(page), {timeout: 30_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string; stateInit?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: SYM_RAW});
  expect(tx.messages).toEqual([{address: SYM.quote.tonTo, amount: SYM.quote.tonValue, payload: SYM.quote.tonBody}]);
  expect(Address.parse(tx.messages[0]!.address).toRawString()).toBe(SYM_JW);
  expect(Address.parseFriendly(tx.messages[0]!.address).isBounceable).toBe(true);
  expect(tx.messages[0]!.amount).toBe("200000000");
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  expect(net.quotes.length, "Symbiosis quotes").toBeGreaterThan(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  // Venues that don't serve this pair are blocked here on purpose and log "Failed to load resource"; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: a Symbiosis answer tampered after the review is refused before the wallet is asked", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubSymbiosis(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SYM_RAW);
  await reviewSymbiosis(page);
  // From now on the API names the payer's own jetton wallet non-bounceable (a failed transfer would keep the TON).
  net.state.tamper = (m) => void (m.address = Address.parseRaw(SYM_JW).toString({urlSafe: true, bounceable: false}));
  const asked = net.quotes.length;
  await page.getByTestId("swap-confirm").click();

  await expect(page.getByTestId("swap-error")).toContainText("isn't sent bounceable", {timeout: 30_000});
  await expect(page.getByTestId("swap-error")).toContainText("nothing was signed");
  expect(net.quotes.length, "the live quote after Confirm").toBeGreaterThan(asked);
  expect(await tonSent(page)).toBe(0);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

// ── a TON contract call: Omniston's escrow paid in USDT (D35 part B) ────────────────────────────────────────────────

/** The live rev2 escrow of 2026-11-11 (USDT on TON → USDC on Base), the phone's fixture. */
const OMN = JSON.parse(readFileSync("tests/unit/execute/omnistonEscrowRev2.fixture.json", "utf8")) as OmnistonRecording;
interface ChainValue {
  chain: {$case: string; value: string | {kind: {$case: string; value?: string}}};
}
interface OmnistonRecording {
  params: {amountIn: string; destAddress: string; refundAddress: string};
  quoteUpdated: Record<string, unknown> & {inputUnits: string; inputAsset: ChainValue; outputAsset: ChainValue; settlementData: {value: Record<string, unknown>}};
  escrowResponse: {messages: {targetAddress: string; sendAmount: string; payload: string}[]};
}
/** The trader it was built for, and its USDT jetton wallet (the message's target, computed from the pinned wallet code). */
const OMN_RAW = Address.parse(OMN.params.refundAddress).toRawString();
const OMN_JW = Address.parse(OMN.escrowResponse.messages[0]!.targetAddress).toRawString();
const OMN_QUOTE = "stonfi.omni.v1beta8.QuoteRpc.Quote";
const OMN_BUILD = "stonfi.omni.v1beta8.TonRpc.BuildEscrowTransfer";
const OMN_TRACK = "stonfi.omni.v1beta8.OrderRpc.Track";

/** The SDK's JSON (ts-proto, snake_case; a oneof is its case's key): `{chain: {$case, value}}` → `{[case]: value}`. */
const chainJson = (a: ChainValue): Record<string, unknown> => {
  const v = a.chain.value;
  return {[a.chain.$case]: typeof v === "string" ? v : {[v.kind.$case]: v.kind.value ?? {}}};
};
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function omnistonJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(omnistonJson);
  if (!v || typeof v !== "object") return v;
  if ("chain" in v) return chainJson(v as ChainValue);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), omnistonJson(x)]));
}

/** What a stubbed build rewrites: the TON the transfer forwards, what the minter forwards to the escrow, the address a failed creation refunds (raw). */
interface OmnistonTamper {
  forwardTon?: bigint;
  escrowGas?: bigint;
  refundTo?: string;
}

/** The order's auxiliary cell with another address where a failed creation refunds (its 2nd), the rest as it is. */
function refundingTo(aux: Cell, raw: string): Cell {
  const a = aux.beginParse();
  const zero = a.loadAddress();
  a.loadAddress();
  return beginCell().storeAddress(zero).storeAddress(Address.parseRaw(raw)).storeBits(a.loadBits(a.remainingBits)).storeRef(a.loadRef()).endCell();
}

/** The capture's escrow with the quote id and the hashlock the page asked for, `tamper` applied. */
function omnistonEscrow(quoteId: string, hashlock: Buffer, tamper: OmnistonTamper = {}): string {
  const s = Cell.fromBoc(Buffer.from(OMN.escrowResponse.messages[0]!.payload, "hex"))[0]!.beginParse();
  const head = {op: s.loadUint(32), queryId: s.loadUintBig(64), amount: s.loadCoins(), destination: s.loadAddress(), response: s.loadAddress(), custom: s.loadMaybeRef(), forwardTon: s.loadCoins()};
  s.loadBit();
  const order = s.loadRef();
  const o = order.beginParse();
  o.skip(32 + 256);
  // A layout bit, the owner, the TON the minter forwards to the escrow, a layout bit; then the order's four cells.
  const [bit1, owner, escrowGas, bit2] = [o.loadBit(), o.loadAddress(), o.loadCoins(), o.loadBit()];
  const [config, code, aux, flags] = [o.loadRef(), o.loadRef(), o.loadRef(), o.loadRef()];
  const refs = [code, tamper.refundTo ? refundingTo(aux, tamper.refundTo) : aux, flags];
  const c = config.beginParse();
  const configHead = c.loadBits(c.remainingBits);
  const [state, destination] = [c.loadRef(), c.loadRef()];
  const x = state.refs[1]!.beginParse();
  x.skip(32 + 256);
  const execution = beginCell().storeUint(0xc8d4b428, 32).storeBuffer(hashlock).storeBits(x.loadBits(x.remainingBits)).storeRef(x.loadRef()).endCell();
  const newState = beginCell().storeRef(state.refs[0]!).storeRef(execution).endCell();
  // The config's bits run to its two refs: `state` then the destination (its bit is among the bits before).
  const newConfig = beginCell().storeBits(configHead).storeRef(newState).storeRef(destination).endCell();
  const newOrder = beginCell()
    .storeUint(0xc0a5f0d9, 32)
    .storeBuffer(Buffer.from(quoteId.padStart(64, "0"), "hex"))
    .storeBit(bit1)
    .storeAddress(owner)
    .storeCoins(tamper.escrowGas ?? escrowGas)
    .storeBit(bit2)
    .storeRef(newConfig);
  for (const r of refs) newOrder.storeRef(r);
  return beginCell()
    .storeUint(head.op, 32)
    .storeUint(head.queryId, 64)
    .storeCoins(head.amount)
    .storeAddress(head.destination)
    .storeAddress(head.response)
    .storeMaybeRef(head.custom)
    .storeCoins(tamper.forwardTon ?? head.forwardTon)
    .storeBit(1)
    .storeRef(newOrder.endCell())
    .endCell()
    .toBoc()
    .toString("hex");
}

/**
 * Prices, TonAPI (the payer's TON and USDT, its USDT jetton wallet and that wallet's state) and Omniston's WebSocket API
 * (JSON-RPC: every RFQ answered with the capture's quote under a fresh id, the escrow built from the capture with the
 * hashlock the page asked for — `state` rewrites what the build forwards or where a failed creation refunds — and an
 * order feed that never names a fill, so nothing is disclosed); anything else off the page's origin is aborted and
 * recorded.
 */
async function stubOmniston(page: Page, origin: string) {
  const unexpected: string[] = [];
  const methods: string[] = [];
  const builds: {quoteId: string; hash: string; payload: string}[] = [];
  const state: OmnistonTamper = {};
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "tonapi.io") {
        if (url.pathname.endsWith("/methods/get_wallet_address")) return json({success: true, decoded: {jetton_wallet_address: OMN_JW}});
        if (url.pathname.endsWith("/methods/get_wallet_data")) return json({success: true, decoded: {balance: "100000000", owner: OMN_RAW, jetton: USDT_RAW}});
        if (url.pathname.endsWith("/jettons")) return json({balances: [{balance: "100000000", jetton: {address: USDT_RAW}}]});
        // The package's own check of the target: the owner's wallet for the jetton, by TonAPI's index.
        if (/\/jettons\/[^/]+$/.test(url.pathname)) return json({balance: "100000000", wallet_address: {address: OMN_JW}, jetton: {address: USDT_RAW}});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${OMN_RAW}","balance":10000000000,"status":"active"}`});
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  await page.routeWebSocket(/^wss:\/\/omni-ws\.ston\.fi/, (ws) => {
    let subscriptions = 0;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as {id?: number; method: string; params: Record<string, unknown>};
      methods.push(m.method);
      const reply = (result: unknown) => ws.send(JSON.stringify({jsonrpc: "2.0", id: m.id, result}));
      const notify = (subscription: number, result: unknown) => ws.send(JSON.stringify({jsonrpc: "2.0", method: m.method, params: {subscription, result}}));
      if (m.method === OMN_QUOTE) {
        const sub = ++subscriptions;
        reply(sub);
        const now = Math.floor(Date.now() / 1000);
        const rfqId = randomBytes(32).toString("hex");
        const quote = {
          ...OMN.quoteUpdated,
          rfqId,
          quoteId: randomBytes(32).toString("hex"),
          quoteTimestamp: now,
          settlementData: undefined,
          order: {...OMN.quoteUpdated.settlementData.value, tradeStartDeadline: now + 300},
        };
        // After the subscription's id has reached the page: an ack, then the quote.
        setTimeout(() => {
          notify(sub, {ack: {rfq_id: rfqId}});
          notify(sub, {quote_updated: omnistonJson(quote)});
        }, 50);
      } else if (m.method === OMN_BUILD) {
        const quoteId = String(m.params.quote_id);
        const hash = Buffer.from(String((m.params.htlc_secrets as {provided: {hashes: string[]}}).provided.hashes[0]), "base64");
        const payload = omnistonEscrow(quoteId, hash, state);
        builds.push({quoteId, hash: hash.toString("hex"), payload});
        const sent = OMN.escrowResponse.messages[0]!;
        reply({messages: [{target_address: sent.targetAddress, send_amount: sent.sendAmount, payload}]});
      } else if (m.method === OMN_TRACK) {
        reply(++subscriptions);
      } else if (m.method.endsWith(".unsubscribe")) {
        reply(true);
      } else {
        ws.send(JSON.stringify({jsonrpc: "2.0", id: m.id, error: {code: -32601, message: "not stubbed"}}));
      }
    });
  });
  return {unexpected, methods, builds, state};
}

/** Pay 10 USDT from the fake Tonkeeper (the capture's trader) for USDC on Base to its recipient; open the review. */
async function reviewOmniston(page: Page) {
  await page.goto(`./#/?pay=${USDT_TON}&receive=${USDC_BASE}&amount=10`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  await page.getByTestId("swap-recipient").fill(OMN.params.destAddress);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via Omniston", {timeout: 30_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 30_000});
}

/** The page's IndexedDB row `os:<quoteId>`: the HTLC secret the Omniston provider stored for that quote. */
const secretOnDisk = (page: Page, quoteId: string) =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open("cp0x-swap");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("kv").objectStore("kv").get(key);
          get.onsuccess = () => resolve((get.result as {value?: unknown} | undefined)?.value ?? null);
          get.onerror = () => reject(get.error);
        };
      }),
    `os:${quoteId}`,
  );

test("TON: Omniston from a TON wallet signs one escrow transfer — the payer's USDT jetton wallet, 0.4 TON, the exact escrow, locked by the page's own secret", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubOmniston(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, OMN_RAW);
  await reviewOmniston(page);
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => tonSent(page), {timeout: 30_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string; stateInit?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: OMN_RAW});
  expect(net.builds).toHaveLength(1);
  const built = net.builds[0]!;
  expect(tx.messages).toEqual([{address: OMN.escrowResponse.messages[0]!.targetAddress, amount: "400000000", payload: Buffer.from(built.payload, "hex").toString("base64")}]);
  expect(Address.parse(tx.messages[0]!.address).toRawString()).toBe(OMN_JW);
  expect(Address.parseFriendly(tx.messages[0]!.address).isBounceable).toBe(true);
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  // The escrow is locked by the hash of the one secret the page stored for that quote, on disk before the wallet was asked.
  const secrets = (await secretOnDisk(page, built.quoteId)) as string[];
  expect(secrets).toHaveLength(1);
  expect(keccak256(`0x${secrets[0]!}`).slice(2)).toBe(built.hash);
  expect(net.methods).toContain(OMN_QUOTE);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: an Omniston escrow that forwards the minter too little TON to deploy it is refused before the wallet is asked", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubOmniston(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, OMN_RAW);
  await reviewOmniston(page);
  // From now on the build forwards 1 nanoTON (Omniston's package asks only for more than none): never deployed.
  net.state.forwardTon = 1n;
  await page.getByTestId("swap-confirm").click();

  await expect(page.getByTestId("swap-error")).toContainText("forwards too little TON", {timeout: 30_000});
  await expect(page.getByTestId("swap-error")).toContainText("nothing was signed");
  expect(net.builds.length, "the escrow built after Confirm").toBe(1);
  expect(await tonSent(page)).toBe(0);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

// Two more fields of the order Omniston's package doesn't hold (more than none; shape only), each a build it passes.
for (const [what, tamper, why] of [
  ["has the minter forward the escrow 1 nanoTON (its creation fails)", {escrowGas: 1n}, "forwards the escrow too little TON to deploy it"],
  ["refunds a failed creation to another wallet", {refundTo: `0:${"cd".repeat(32)}`}, "refunds a failed creation to another wallet than yours"],
] as const) {
  test(`TON: an Omniston escrow that ${what} is refused before the wallet is asked`, async ({page, baseURL}) => {
    test.setTimeout(90_000);
    const watch = watchPage(page);
    const net = await stubOmniston(page, new URL(baseURL!).origin);
    await injectFakeTonkeeper(page, OMN_RAW);
    await reviewOmniston(page);
    Object.assign(net.state, tamper);
    await page.getByTestId("swap-confirm").click();

    await expect(page.getByTestId("swap-error")).toContainText(why, {timeout: 30_000});
    await expect(page.getByTestId("swap-error")).toContainText("nothing was signed");
    expect(net.builds.length, "the escrow built after Confirm").toBe(1);
    expect(await tonSent(page)).toBe(0);
    expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  });
}

// ── a TON contract call: Omniston's swap between TON and USDT (D35 part C) ──────────────────────────────────────────

/** The SDK's recordings of 2026-10-22 (omnistonSwaps.fixture.json): 2 TON → USDT, once through DeDust v1, once through DeDust CPMM v2. */
const SWAPS = JSON.parse(readFileSync("tests/unit/execute/omnistonSwaps.fixture.json", "utf8")) as {
  tonapi: Record<string, unknown>;
  cases: {recorded: string; pair: string; protocols: string; trader: string; amountIn: string; quote?: Record<string, unknown> & {settlementData: {value: unknown}}; message: {targetAddress: string; sendAmount: string; payload: string}}[];
};
const swapCase = (protocols: string) => SWAPS.cases.find((c) => c.recorded.startsWith("sdk") && c.pair === "GRAM>USDT" && c.amountIn === "2000000000" && c.protocols === protocols)!;
const DEDUST = swapCase("DeDust");
const CPMM = swapCase("DeDustCPMMV2");
/** The trader both were built for (and their recipient). */
const SWAP_RAW = Address.parse(DEDUST.trader).toRawString();
const OMN_BUILD_SWAP = "stonfi.omni.v1beta8.TonRpc.BuildSwap";
/** DeDust v1's native vault, as TonAPI labels it for the package's own target check (the app never asks). */
const DEDUST_VAULT = "EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_";

/**
 * Prices, TonAPI (the payer's TON; for the package's own build checks, DeDust's vault and pools as the SDK recorded
 * them) and Omniston's WebSocket API (JSON-RPC: every RFQ answered with `state.quote`'s recording under a fresh id, the
 * swap built as that recording was; `state.quote` switched after the review stands for Omniston changing its route);
 * anything else off the page's origin is aborted and recorded.
 */
async function stubOmnistonSwap(page: Page, origin: string) {
  const unexpected: string[] = [];
  const methods: string[] = [];
  const builds: {quoteId: string; owner: string; dest: string}[] = [];
  const state = {quote: DEDUST};
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "tonapi.io") {
        const recorded = SWAPS.tonapi[decodeURIComponent(url.pathname)];
        if (recorded) return json(recorded);
        if (url.pathname === `/v2/accounts/${DEDUST_VAULT}`) return json({address: Address.parse(DEDUST_VAULT).toRawString(), status: "active", interfaces: ["dedust_vault"], is_wallet: false});
        if (url.pathname.endsWith("/jettons")) return json({balances: []});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${SWAP_RAW}","balance":10000000000,"status":"active"}`});
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  await page.routeWebSocket(/^wss:\/\/omni-ws\.ston\.fi/, (ws) => {
    let subscriptions = 0;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as {id?: number; method: string; params: Record<string, unknown>};
      methods.push(m.method);
      const reply = (result: unknown) => ws.send(JSON.stringify({jsonrpc: "2.0", id: m.id, result}));
      const notify = (subscription: number, result: unknown) => ws.send(JSON.stringify({jsonrpc: "2.0", method: m.method, params: {subscription, result}}));
      if (m.method === OMN_QUOTE) {
        const sub = ++subscriptions;
        reply(sub);
        const rfqId = randomBytes(32).toString("hex");
        const recorded = state.quote.quote!;
        const quote = {...recorded, rfqId, quoteId: randomBytes(32).toString("hex"), quoteTimestamp: Math.floor(Date.now() / 1000), settlementData: undefined, swap: recorded.settlementData.value};
        setTimeout(() => {
          notify(sub, {ack: {rfq_id: rfqId}});
          notify(sub, {quote_updated: omnistonJson(quote)});
        }, 50);
      } else if (m.method === OMN_BUILD_SWAP) {
        const chain = (k: string) => String((m.params[k] as {ton?: unknown} | undefined)?.ton);
        builds.push({quoteId: String(m.params.quote_id), owner: chain("transfer_src_address"), dest: chain("trader_dst_address")});
        const sent = state.quote.message;
        reply({messages: [{target_address: sent.targetAddress, send_amount: sent.sendAmount, payload: sent.payload}]});
      } else if (m.method.endsWith(".Track")) {
        reply(++subscriptions);
      } else if (m.method.endsWith(".unsubscribe")) {
        reply(true);
      } else {
        ws.send(JSON.stringify({jsonrpc: "2.0", id: m.id, error: {code: -32601, message: "not stubbed"}}));
      }
    });
  });
  return {unexpected, methods, builds, state};
}

/** Pay 2 TON from the fake Tonkeeper (the recordings' trader) for USDT on TON, to itself, at 1 % (as recorded); open the review. */
async function reviewOmnistonSwap(page: Page) {
  await page.goto(`./#/?pay=ton:native&receive=${USDT_TON}&amount=2`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  await page.getByTestId("swap-slippage").click();
  const sheet = page.getByRole("dialog", {name: "Max slippage"});
  // 1 % is typed: the presets are 0.01 %, 0.05 % and 0.3 %.
  await sheet.getByLabel("Custom").fill("1");
  await sheet.getByLabel("Custom").press("Enter");
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("swap-review")).toHaveText("Review via Omniston", {timeout: 30_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 30_000});
}

test("TON: Omniston swaps TON for USDT from a TON wallet through a pinned DEX — one message to DeDust's native vault, the input and gas, the exact recorded body", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubOmnistonSwap(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SWAP_RAW);
  await reviewOmnistonSwap(page);
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => tonSent(page), {timeout: 30_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string; stateInit?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: SWAP_RAW});
  expect(tx.messages).toEqual([{address: DEDUST_VAULT, amount: "2100000000", payload: Buffer.from(DEDUST.message.payload, "hex").toString("base64")}]);
  expect(Address.parseFriendly(tx.messages[0]!.address).isBounceable).toBe(true);
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  // Built for the connected wallet, paying itself.
  expect(net.builds).toHaveLength(1);
  expect([Address.parse(net.builds[0]!.owner).toRawString(), Address.parse(net.builds[0]!.dest).toRawString()]).toEqual([SWAP_RAW, SWAP_RAW]);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: an Omniston swap re-routed after the review through DeDust CPMM v2 (no pin names its pool) is refused before the wallet is asked", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubOmnistonSwap(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SWAP_RAW);
  await reviewOmnistonSwap(page);
  // From now on Omniston quotes and builds the route through DeDust CPMM v2's pool: its package's checks pass it (TonAPI
  // labels the pool), the route list would have refused it by its label, and the gate refuses its bytes.
  net.state.quote = CPMM;
  await page.getByTestId("swap-confirm").click();

  await expect(page.getByTestId("swap-error")).toContainText("goes to a contract the app doesn't pin", {timeout: 30_000});
  await expect(page.getByTestId("swap-error")).toContainText("nothing was signed");
  expect(net.builds.length, "the swap built after Confirm").toBe(1);
  expect(await tonSent(page)).toBe(0);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});
