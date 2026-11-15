/**
 * Importing a token by its address (D39) in the real build, with the chain stubbed: EVM JSON-RPC answers eth_getCode
 * and decimals() / symbol() / name() for the tokens below (every other call reverts), Solana's getMultipleAccounts
 * answers a mint and its Metaplex metadata, the price APIs answer empty maps, and every other request is recorded and
 * aborted — so the run is deterministic and nothing reaches a venue.
 * - Paste an EVM contract → the confirmation with the warning → "I understand" → imported; the next round asks the
 *   venues for that contract with its decimals (a preview: no wallet; Balancer's SOR query carries both), and the venues
 *   with their own token lists read "Listed tokens only".
 * - A token whose symbol is a listed one's shows the amber look-alike line.
 * - A Solana mint imports from its mint account and Metaplex metadata.
 * - A pair link naming an unlisted token opens with that side empty and the confirmation up, and asks no venue for it
 *   until the viewer confirms.
 */
import {expect, test as base, type Page} from "@playwright/test";
import {Buffer} from "node:buffer";
import {encodeAbiParameters, type Hex} from "viem";
import {expectNoHorizontalScroll, isCp0xHost, isPhone, watchPage, type PageWatch} from "./helpers";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const FAKE_USDC = "0x2222222222222222222222222222222222222222";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const ERC20: Readonly<Record<string, {decimals: number; symbol: string; name: string}>> = {
  [DEGEN.toLowerCase()]: {decimals: 18, symbol: "DEGEN", name: "Degen"},
  [FAKE_USDC]: {decimals: 6, symbol: "USDC", name: "USD Coin"},
};
/** How the contract sits in calldata (a padded word): a venue's quote call naming it. */
const DEGEN_WORD = `000000000000000000000000${DEGEN.slice(2).toLowerCase()}`;
const BASE_PAIR = "pay=base:native&receive=base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const PRICE_HOSTS = new Set(["coins.llama.fi", "api.coingecko.com"]);
const CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"};

const abi = (type: "string" | "uint256", v: string | bigint): Hex => encodeAbiParameters([{type}], [v as never]);

/** A classic SPL mint (82 bytes: decimals at 44, initialized at 45) and a Metaplex metadata account for it. */
function solanaAccounts(): unknown[] {
  const mint = Buffer.alloc(82);
  mint[44] = 5;
  mint[45] = 1;
  const bs58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of BONK) n = n * 58n + BigInt(bs58.indexOf(c));
  const mintKey = Buffer.from(n.toString(16).padStart(64, "0"), "hex");
  const str = (s: string, pad: number) => {
    const b = Buffer.alloc(pad);
    b.write(s);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(pad);
    return Buffer.concat([len, b]);
  };
  const meta = Buffer.concat([Buffer.from([4]), Buffer.alloc(32), mintKey, str("Bonk", 32), str("BONK", 10), str("https://bonk", 200)]);
  return [
    {owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [mint.toString("base64"), "base64"], lamports: 1, executable: false, rentEpoch: 0, space: 82},
    {owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [meta.toString("base64"), "base64"], lamports: 1, executable: false, rentEpoch: 0, space: meta.length},
  ];
}

type Rpc = {jsonrpc?: string; id?: unknown; method?: string; params?: unknown[]};

/** One JSON-RPC answer: the stubbed tokens' reads; anything else reverts (venue quotes, gas…) or is unknown. */
function answer(r: Rpc): Record<string, unknown> {
  const p = r.params ?? [];
  switch (r.method) {
    case "eth_chainId":
      return {result: "0x2105"};
    case "eth_blockNumber":
      return {result: "0x100"};
    case "eth_gasPrice":
      return {result: "0x3b9aca00"};
    case "eth_getCode":
      return {result: ERC20[String(p[0]).toLowerCase()] ? "0x6080604052" : "0x"};
    case "eth_call": {
      const {to, data} = (p[0] ?? {}) as {to?: string; data?: string};
      // Balancer checks its pinned Vault (WETH()) before it asks its SOR API: Base's WETH.
      if (String(to).toLowerCase() === BALANCER_VAULT && data === "0xad5c4648") return {result: `0x${"4200000000000000000000000000000000000006".padStart(64, "0")}`};
      const t = ERC20[String(to).toLowerCase()];
      if (t && data === "0x313ce567") return {result: abi("uint256", BigInt(t.decimals))};
      if (t && data === "0x95d89b41") return {result: abi("string", t.symbol)};
      if (t && data === "0x06fdde03") return {result: abi("string", t.name)};
      return {error: {code: 3, message: "execution reverted", data: "0x"}};
    }
    case "getMultipleAccounts": {
      const keys = (p[0] ?? []) as string[];
      return {result: {context: {slot: 1}, value: keys[0] === BONK ? solanaAccounts() : keys.map(() => null)}};
    }
    default:
      return {error: {code: -32601, message: "not stubbed"}};
  }
}

interface Seen {
  url: string;
  body: string;
}

/** Stub the chain and the price APIs; record every other off-origin request (and abort it). */
async function stubNetwork(page: Page, origin: string): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") return route.fulfill({status: 204, headers: CORS});
      if (PRICE_HOSTS.has(url.hostname)) return route.fulfill({status: 200, headers: CORS, contentType: "application/json", body: url.hostname === "coins.llama.fi" ? '{"coins":{}}' : "{}"});
      const body = req.postData() ?? "";
      seen.push({url: url.href, body});
      let rpc: Rpc | Rpc[] | null;
      try {
        rpc = JSON.parse(body) as Rpc | Rpc[];
      } catch {
        rpc = null;
      }
      const calls = rpc ? (Array.isArray(rpc) ? rpc : [rpc]) : [];
      if (calls.length && calls.every((c) => c?.jsonrpc === "2.0")) {
        const out = calls.map((c) => ({jsonrpc: "2.0", id: c.id, ...answer(c)}));
        return route.fulfill({status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(Array.isArray(rpc) ? out : out[0])});
      }
      return route.abort("blockedbyclient");
    },
  );
  return seen;
}

/** A request naming the contract as a venue would: in a quote's calldata or a venue API's URL or body (not its own reads). */
const asksFor = (s: Seen): boolean => {
  const text = `${s.url} ${s.body}`.toLowerCase();
  if (text.includes(DEGEN_WORD)) return true;
  const own = /"method":"eth_(?:getcode|call)"/.test(text) && text.includes(`"to":"${DEGEN.toLowerCase()}"`) && /"data":"0x(?:313ce567|95d89b41|06fdde03)"/.test(text);
  return !own && !/"method":"eth_getcode"/.test(text) && text.includes(DEGEN.slice(2).toLowerCase());
};

/** Balancer's SOR query for `token` as the source, `amount` in its own units (its swapAmount, cut with sourceDecimals). */
const sorAsks =
  (token: string, amount: string) =>
  (s: Seen): boolean => {
    if (!s.url.startsWith("https://api-v3.balancer.fi")) return false;
    try {
      const q = String((JSON.parse(s.body) as {query?: unknown}).query ?? "");
      return q.includes(`tokenIn: "${token}"`) && q.includes(`swapAmount: "${amount}"`);
    } catch {
      return false;
    }
  };

const test = base.extend<{watch: PageWatch}>({
  watch: [
    async ({page}, use) => {
      const watch = watchPage(page);
      await use(watch);
      // Aborted venue requests log "Failed to load resource" (blocked here on purpose); nothing else may.
      expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
      expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
    },
    {auto: true},
  ],
});

/** Paste `address` into the open token sheet's search. */
async function paste(page: Page, address: string): Promise<void> {
  await page.getByTestId("swap-token-search").fill(address);
}

test("an EVM contract imports after the warning, and the next round asks the venues for it", async ({page, baseURL}, info) => {
  const seen = await stubNetwork(page, new URL(baseURL!).origin);
  await page.goto(`./#/?${BASE_PAIR}&amount=1`);
  await expect(page.getByTestId("swap-pay-token")).toHaveAttribute("aria-label", "ETH on Base, change token");

  await page.getByTestId("swap-pay-token").click();
  await paste(page, DEGEN);
  const result = page.getByTestId("swap-import-result");
  await expect(result.getByTestId("swap-import-network")).toHaveValue("base");
  await result.getByTestId("swap-import-open").click();

  const confirm = page.getByTestId("swap-import-confirm");
  await expect(confirm.getByTestId("swap-import-symbol")).toHaveText("DEGEN");
  await expect(confirm.getByTestId("swap-import-name")).toHaveText("Degen");
  await expect(confirm.getByTestId("swap-import-address")).toHaveText(DEGEN);
  await expect(confirm.getByTestId("swap-import-warning")).toHaveText(/^Anyone can create a token with any name — including fake copies of real tokens\./);
  await expect(confirm.getByTestId("swap-import-lookalike")).toHaveCount(0);
  await expect(confirm.getByTestId("swap-import-confirm-button")).toBeDisabled();
  await expectNoHorizontalScroll(page);
  // Nothing has asked a venue about it yet: only its own reads.
  expect(seen.filter(asksFor), "a venue asked before the import").toEqual([]);

  await confirm.getByTestId("swap-import-understand").check();
  await confirm.getByTestId("swap-import-confirm-button").click();
  await expect(page.getByTestId("swap-pay-token")).toHaveAttribute("aria-label", "DEGEN on Base, change token");
  await expect(page.getByTestId("swap-pay-usd")).toHaveText("Imported token · no price");
  await page.getByTestId("swap-amount").fill("1000");

  // The preview round asks the venues that take any token, naming the contract (a quote call's calldata, an API).
  // Balancer's SOR query names the source by contract and its amount in the decimals read on-chain (sourceDecimals):
  // 1000 DEGEN at 18 decimals reads "1000" — the venue got both.
  await expect.poll(() => seen.filter(sorAsks(DEGEN, "1000")).length, {timeout: 15_000}).toBeGreaterThan(0);
  expect(seen.filter(asksFor).length).toBeGreaterThan(0);
  await expect(page.getByTestId("swap-review")).toHaveText(/^Connect EVM wallet to swap$/);
  if (!isPhone(info)) {
    // (Phones list the venues in the route sheet; the wording is the same.)
    const uncovered = page.getByTestId("swap-uncovered-toggle");
    await expect(uncovered).toBeVisible({timeout: 15_000});
    await uncovered.click();
    await expect(page.getByRole("list", {name: "Not for this pair"})).toContainText("Listed tokens only");
  }

  // Kept in this browser: listed under the catalog with its badge after a reload.
  await page.reload();
  await page.getByTestId("swap-receive-token").click();
  await page.getByTestId("swap-net-base").click();
  await expect(page.getByTestId(`swap-token-base:${DEGEN.toLowerCase()}`)).toContainText("Imported");
});

test("a token named like a listed one shows the amber look-alike line", async ({page, baseURL}) => {
  await stubNetwork(page, new URL(baseURL!).origin);
  await page.goto(`./#/?${BASE_PAIR}`);
  await page.getByTestId("swap-receive-token").click();
  await paste(page, FAKE_USDC);
  await page.getByTestId("swap-import-open").click();
  const confirm = page.getByTestId("swap-import-confirm");
  await expect(confirm.getByTestId("swap-import-symbol")).toHaveText("USDC");
  await expect(confirm.getByTestId("swap-import-lookalike")).toHaveText("Not the listed USDC — that one's address is 0x8335…2913");
  await expectNoHorizontalScroll(page);
});

test("a Solana mint imports from its mint account and Metaplex metadata", async ({page, baseURL}) => {
  const seen = await stubNetwork(page, new URL(baseURL!).origin);
  await page.goto("./#/?pay=solana:native&receive=solana:epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v");
  await page.getByTestId("swap-receive-token").click();
  await paste(page, BONK);
  await expect(page.getByTestId("swap-import-result")).toContainText("BONK");
  await expect(page.getByTestId("swap-import-network")).toHaveCount(0);
  await page.getByTestId("swap-import-open").click();
  const confirm = page.getByTestId("swap-import-confirm");
  await expect(confirm.getByTestId("swap-import-name")).toHaveText("Bonk");
  await expect(confirm).toContainText("Solana · 5 decimals");
  await confirm.getByTestId("swap-import-understand").check();
  await confirm.getByTestId("swap-import-confirm-button").click();
  await expect(page.getByTestId("swap-receive-token")).toHaveAttribute("aria-label", "BONK on Solana, change token");
  expect(seen.some((s) => s.body.includes('"getMultipleAccounts"') && s.body.includes(BONK)), "the mint was read on Solana").toBe(true);
});

test("a pair link naming an unlisted token opens its confirmation with that side empty, and asks no venue until confirmed", async ({page, baseURL}) => {
  const seen = await stubNetwork(page, new URL(baseURL!).origin);
  await page.goto(`./#/?pay=base:native&receive=base:${DEGEN.toLowerCase()}&amount=1`);
  const confirm = page.getByTestId("swap-import-confirm");
  await expect(confirm.getByTestId("swap-import-symbol")).toHaveText("DEGEN");
  await expect(confirm.getByTestId("swap-import-warning")).toBeVisible();
  await expect(page.getByTestId("swap-receive-token")).toHaveAttribute("aria-label", "Select a token");
  await expect(page.getByTestId("swap-review")).toHaveText("Select a token");
  await page.waitForTimeout(1_500);
  expect(seen.filter(asksFor), "a venue asked about a token nobody confirmed").toEqual([]);

  await confirm.getByTestId("swap-import-cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("swap-receive-token")).toHaveAttribute("aria-label", "Select a token");
  await page.waitForTimeout(1_000);
  expect(seen.filter(asksFor), "a venue asked after the import was cancelled").toEqual([]);
  await expect(page.getByRole("radio")).toHaveCount(0);
});
