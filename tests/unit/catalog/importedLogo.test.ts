// An imported token's logo (D39): found by its contract or mint at DefiLlama's icons, then Trust Wallet's assets; only a
// raster image of at most LOGO_MAX_BYTES, inlined as a data: URL; a copy named USDC finds nothing by its symbol.
import {afterEach, describe, expect, it, vi} from "vitest";
import {TOKENS, chainBySlugWeb, importedToken} from "../../../src/catalog";
import {CHAIN_LIST} from "../../../src/catalog/network";
import {LOGO_MAX_BYTES, TRUST_WALLET_CHAINS, fetchTokenLogo, logoUrls} from "../../../src/catalog/importedLogo";
import {importable} from "../../../src/catalog/imported";

type Reply = {status?: number; type?: string; bytes?: Uint8Array; length?: number; throws?: Error};

const calls: {url: string; init?: RequestInit}[] = [];
function mockFetch(route: (url: string) => Reply) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, init});
      const r = route(url);
      if (r.throws) throw r.throws;
      const status = r.status ?? 200;
      const bytes = r.bytes ?? new Uint8Array([137, 80, 78, 71]);
      const headers = new Headers({"content-type": r.type ?? "image/png", "content-length": String(r.length ?? bytes.length)});
      return {ok: status >= 200 && status < 300, status, headers, arrayBuffer: async () => bytes.slice().buffer} as Response;
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const degen = importedToken(chainBySlugWeb("base")!, DEGEN.toLowerCase(), {decimals: 18, symbol: "DEGEN", name: "Degen"});
const bonk = importedToken(chainBySlugWeb("solana")!, BONK, {decimals: 5, symbol: "Bonk", name: "Bonk"});
const LLAMA = `https://token-icons.llamao.fi/icons/tokens/8453/${DEGEN}?h=64&w=64`;
const TW = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/${DEGEN}/logo.png`;

describe("logoUrls", () => {
  it("EVM: DefiLlama by chain id, then Trust Wallet, the address checksummed", () => {
    expect(logoUrls(degen)).toEqual([LLAMA, TW]);
    // A network Trust Wallet has no directory for: DefiLlama only.
    const ink = importedToken(chainBySlugWeb("ink")!, DEGEN, {decimals: 18, symbol: "X", name: "X"});
    expect(logoUrls(ink)).toEqual([`https://token-icons.llamao.fi/icons/tokens/57073/${DEGEN}?h=64&w=64`]);
  });

  it("Solana: Trust Wallet by the mint as written", () => {
    expect(logoUrls(bonk)).toEqual([`https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/${BONK}/logo.png`]);
  });

  it("nothing for a catalog token", () => {
    expect(logoUrls(TOKENS.find((t) => t.key === "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")!)).toEqual([]);
  });

  it("names only importable networks", () => {
    const slugs = new Set(CHAIN_LIST.filter((c) => importable(c)).map((c) => c.slug));
    expect(Object.keys(TRUST_WALLET_CHAINS).filter((s) => !slugs.has(s))).toEqual([]);
  });
});

describe("fetchTokenLogo", () => {
  it("inlines the first source's image, asking without credentials or a referrer", async () => {
    mockFetch(() => ({type: "image/webp", bytes: new Uint8Array([1, 2, 3])}));
    expect(await fetchTokenLogo(degen)).toBe("data:image/webp;base64,AQID");
    expect(calls.map((c) => c.url)).toEqual([LLAMA]);
    expect(calls[0]!.init).toMatchObject({credentials: "omit", referrerPolicy: "no-referrer"});
  });

  it("falls through a 404, an SVG, an HTML page and an oversized image to the next source", async () => {
    for (const miss of [{status: 404}, {type: "image/svg+xml"}, {type: "text/html; charset=utf-8"}, {length: LOGO_MAX_BYTES + 1}, {bytes: new Uint8Array(LOGO_MAX_BYTES + 1), length: 0}]) {
      mockFetch((u) => (u === LLAMA ? miss : {type: "image/png", bytes: new Uint8Array([255])}));
      expect(await fetchTokenLogo(degen)).toBe("data:image/png;base64,/w==");
      expect(calls.map((c) => c.url)).toEqual([LLAMA, TW]);
    }
  });

  it("no logo anywhere is the answer (null); a source it couldn't reach makes it ask again (throws)", async () => {
    mockFetch(() => ({status: 404}));
    expect(await fetchTokenLogo(degen)).toBeNull();
    mockFetch((u) => (u === LLAMA ? {throws: new TypeError("Failed to fetch")} : {status: 404}));
    await expect(fetchTokenLogo(degen)).rejects.toThrow("No logo source could be reached.");
    // Reached the second source, though: its logo wins.
    mockFetch((u) => (u === LLAMA ? {throws: new TypeError("Failed to fetch")} : {}));
    expect(await fetchTokenLogo(degen)).toMatch(/^data:image\/png;base64,/);
  });

  it("asks nothing for a catalog token", async () => {
    mockFetch(() => ({}));
    expect(await fetchTokenLogo(TOKENS[0]!)).toBeNull();
    expect(calls).toEqual([]);
  });
});
