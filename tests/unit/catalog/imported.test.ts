// Tokens imported by their address (D39): address detection per family, the on-chain reads (ERC-20 strings and
// bytes32, decimals bounds, invisible and bidi characters, Solana mints with Token-2022 or Metaplex metadata), the
// browser store's guard and cap, the look-alike check, and how an import joins prices, search and balances.
import {getAddressEncoder} from "@solana/kit";
import {encodeAbiParameters, stringToHex, type Hex} from "viem";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  IMPORTED_TOKENS_CAP,
  IMPORTED_TOKENS_KEY,
  TOKENS,
  TokenReadError,
  addImportedToken,
  balanceSpecs,
  bytesToBase64,
  chainBySlugWeb,
  cleanTokenText,
  decodeTokenString,
  decodeUint,
  detectTokenAddress,
  importKey,
  importedToken,
  importedTokens,
  listedToken,
  lookalikeOf,
  matchesToken,
  metaplexMetadata,
  parseImportedTokens,
  parseMint,
  parseTokenKey,
  readEvmToken,
  readSolanaToken,
  readTokenForImport,
  readsAs,
  removeImportedToken,
  resetImportedTokens,
  swapTokens,
  token2022Metadata,
  tokenPrice,
  type TokenReadClient,
} from "../../../src/catalog";
import {balanceKey} from "../../../src/catalog/balances";
import type {Chain, Token} from "../../../src/contracts";

const BASE = chainBySlugWeb("base")!;
const SOLANA = chainBySlugWeb("solana")!;
/** DEGEN on Base: not in swap2-assets 0.3.0 (probed 2026-11-15 as a real unlisted ERC-20). */
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
/** BONK on Solana: not in the catalog. */
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const abiString = (s: string): Hex => encodeAbiParameters([{type: "string"}], [s]);
const abiUint = (n: bigint): Hex => encodeAbiParameters([{type: "uint256"}], [n]);

const degen = (over: Partial<Token> = {}): Token => ({...importedToken(BASE, DEGEN, {decimals: 18, symbol: "DEGEN", name: "Degen"}), ...over});

describe("detectTokenAddress", () => {
  it("reads an EVM contract in any case — a wrong checksum is no reason to refuse it", () => {
    expect(detectTokenAddress(` ${DEGEN} `)).toEqual({family: "evm", address: DEGEN});
    expect(detectTokenAddress(DEGEN.toLowerCase())).toEqual({family: "evm", address: DEGEN.toLowerCase()});
    const badChecksum = `0x${DEGEN.slice(2).toUpperCase()}`;
    expect(detectTokenAddress(badChecksum)).toEqual({family: "evm", address: badChecksum});
  });

  it("refuses the zero address and anything that isn't an address", () => {
    expect(detectTokenAddress("0x0000000000000000000000000000000000000000")).toBeNull();
    expect(detectTokenAddress("usdc")).toBeNull();
    expect(detectTokenAddress("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefe")).toBeNull();
    expect(detectTokenAddress("")).toBeNull();
  });

  it("reads a 32-byte Solana mint, not the system program — even when it also has a Bitcoin address's shape", () => {
    expect(detectTokenAddress(BONK)).toEqual({family: "solana", address: BONK});
    expect(detectTokenAddress("11111111111111111111111111111111")).toBeNull();
    // A Bitcoin legacy address is base58 too, but decodes to 25 bytes.
    expect(detectTokenAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toEqual({family: "unsupported", addressFamily: "btc"});
  });

  it("says another family's address can't be imported (TON, Tron, Bitcoin, NEAR, Zcash)", () => {
    expect(detectTokenAddress("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")).toEqual({family: "unsupported", addressFamily: "ton"});
    expect(detectTokenAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toEqual({family: "unsupported", addressFamily: "tron"});
    expect(detectTokenAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toEqual({family: "unsupported", addressFamily: "btc"});
    expect(detectTokenAddress("usdt.tether-token.near")).toEqual({family: "unsupported", addressFamily: "near"});
    expect(detectTokenAddress("t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua")).toEqual({family: "unsupported", addressFamily: "zcash"});
  });
});

describe("keys and the catalog", () => {
  it("keys an EVM import lowercased like the catalog, a Solana one verbatim (a lowercased mint is another address)", () => {
    expect(importKey(BASE, DEGEN)).toBe(`base:${DEGEN.toLowerCase()}`);
    expect(importKey(SOLANA, BONK)).toBe(`solana:${BONK}`);
  });

  it("finds a listed token by contract: any case on EVM, exactly on Solana", () => {
    expect(listedToken(BASE.caip2, BASE_USDC.toLowerCase())?.symbol).toBe("USDC");
    expect(listedToken(SOLANA.caip2, SOL_USDC)?.symbol).toBe("USDC");
    expect(listedToken(SOLANA.caip2, SOL_USDC.toLowerCase())).toBeUndefined();
    expect(listedToken(BASE.caip2, DEGEN)).toBeUndefined();
  });

  it("parses a link's unlisted token key (checksummed on EVM), never a listed, non-importable or malformed one", () => {
    expect(parseTokenKey(`base:${DEGEN.toLowerCase()}`)).toEqual({chain: BASE, address: DEGEN});
    expect(parseTokenKey(`solana:${BONK}`)).toEqual({chain: SOLANA, address: BONK});
    expect(parseTokenKey(`base:${BASE_USDC.toLowerCase()}`)).toBeNull();
    expect(parseTokenKey("tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBeNull();
    expect(parseTokenKey("base:native")).toBeNull();
    expect(parseTokenKey("nowhere:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")).toBeNull();
    expect(parseTokenKey(DEGEN)).toBeNull();
  });

  it("builds an import whose engine symbol is its contract, never a gas token", () => {
    expect(degen()).toMatchObject({key: `base:${DEGEN.toLowerCase()}`, catalogSymbol: DEGEN, contract: DEGEN, imported: true, gasToken: false, name: "Degen", decimals: 18});
  });
});

describe("cleanTokenText", () => {
  it("strips control, bidi, zero-width and other invisible characters", () => {
    expect(cleanTokenText("U\u202eSDC", 20)).toBe("USDC");
    expect(cleanTokenText("US\u200bD\u200dC\ufeff", 20)).toBe("USDC");
    expect(cleanTokenText("\u2067USDC\u2069\u200f", 20)).toBe("USDC");
    expect(cleanTokenText("US\u0000DC\u0007", 20)).toBe("USDC");
    // Hangul fillers read as blanks but aren't whitespace.
    expect(cleanTokenText("\u3164USDC\u115f", 20)).toBe("USDC");
  });

  it("collapses whitespace, cuts stacks of combining marks and caps the length", () => {
    expect(cleanTokenText("  Wrapped \n\t Ether  ", 48)).toBe("Wrapped Ether");
    expect(cleanTokenText("q\u0301\u0302\u0303\u0304", 20)).toBe("q\u0301\u0302");
    expect(cleanTokenText("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)).toBe("ABCDEFGHI…");
    expect(cleanTokenText("\u200b\u202e", 10)).toBe("");
  });
});

describe("ERC-20 answers", () => {
  it("decodes an ABI string and a legacy bytes32", () => {
    expect(decodeTokenString(abiString("Degen"))).toBe("Degen");
    expect(decodeTokenString(stringToHex("MKR", {size: 32}))).toBe("MKR");
    expect(decodeTokenString(stringToHex("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", {size: 32}))).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  it("refuses an empty, short or overrunning answer", () => {
    expect(decodeTokenString("0x")).toBeNull();
    expect(decodeTokenString(undefined)).toBeNull();
    expect(decodeTokenString("0x1234")).toBeNull();
    // offset 0x20, length 0x40 — longer than what follows
    expect(decodeTokenString(`0x${"20".padStart(64, "0")}${"40".padStart(64, "0")}${"41".repeat(32)}`)).toBeNull();
    expect(decodeTokenString(`0x${"ff".padStart(64, "0")}${"00".repeat(32)}`)).toBeNull();
  });

  it("reads the first word as a number", () => {
    expect(decodeUint(abiUint(18n))).toBe(18n);
    expect(decodeUint("0x")).toBeNull();
    expect(decodeUint("0x12")).toBeNull();
  });
});

describe("readEvmToken", () => {
  const client = (o: {code?: string; codeFails?: boolean; answers?: Record<string, Hex | Error>}): TokenReadClient =>
    ({
      getCode: vi.fn(async () => {
        if (o.codeFails) throw Object.assign(new Error("fetch failed"), {name: "HttpRequestError"});
        return o.code ?? "0x6080604052";
      }),
      call: vi.fn(async ({data}: {data: Hex}) => {
        const a = o.answers?.[data];
        if (a instanceof Error) throw a;
        return {data: a};
      }),
    }) as unknown as TokenReadClient;
  const ok = {"0x313ce567": abiUint(18n), "0x95d89b41": abiString("DEGEN"), "0x06fdde03": abiString("Degen")} as const;

  it("reads decimals, symbol and name", async () => {
    await expect(readEvmToken(BASE, DEGEN, client({answers: ok}))).resolves.toEqual({decimals: 18, symbol: "DEGEN", name: "Degen"});
  });

  it("takes a bytes32 symbol, cleans an RTL trick and calls a missing one UNKNOWN", async () => {
    const answers = {"0x313ce567": abiUint(6n), "0x95d89b41": stringToHex("MKR", {size: 32}), "0x06fdde03": abiString("\u202eCDSU Maker")};
    await expect(readEvmToken(BASE, DEGEN, client({answers}))).resolves.toEqual({decimals: 6, symbol: "MKR", name: "CDSU Maker"});
    const reverts = {"0x313ce567": abiUint(0n), "0x95d89b41": new Error("execution reverted"), "0x06fdde03": "0x" as Hex};
    await expect(readEvmToken(BASE, DEGEN, client({answers: reverts}))).resolves.toEqual({decimals: 0, symbol: "UNKNOWN", name: "UNKNOWN"});
  });

  it("refuses an address with no code, or an EIP-7702 delegated account", async () => {
    await expect(readEvmToken(BASE, DEGEN, client({code: "0x", answers: ok}))).rejects.toMatchObject({message: "No token contract at this address on Base.", definitive: true});
    await expect(readEvmToken(BASE, DEGEN, client({code: `0xef0100${"ab".repeat(20)}`, answers: ok}))).rejects.toMatchObject({definitive: true});
  });

  it("requires decimals() in 0..36", async () => {
    await expect(readEvmToken(BASE, DEGEN, client({answers: {...ok, "0x313ce567": new Error("execution reverted")}}))).rejects.toMatchObject({
      message: expect.stringMatching(/doesn't read as a token on Base/),
      definitive: true,
    });
    await expect(readEvmToken(BASE, DEGEN, client({answers: {...ok, "0x313ce567": abiUint(37n)}}))).rejects.toMatchObject({message: expect.stringMatching(/37 decimals/)});
    await expect(readEvmToken(BASE, DEGEN, client({answers: {...ok, "0x313ce567": abiUint(36n)}}))).resolves.toMatchObject({decimals: 36});
    await expect(readEvmToken(BASE, DEGEN, client({answers: {...ok, "0x313ce567": abiUint(2n ** 255n)}}))).rejects.toBeInstanceOf(TokenReadError);
  });

  it("tells a network failure (asked again) from the chain's own answer", async () => {
    await expect(readEvmToken(BASE, DEGEN, client({codeFails: true}))).rejects.toMatchObject({definitive: false});
    const down = Object.assign(new Error("HTTP request failed"), {name: "HttpRequestError"});
    await expect(readEvmToken(BASE, DEGEN, client({answers: {...ok, "0x313ce567": down}}))).rejects.toMatchObject({definitive: false});
  });
});

// ── Solana ──────────────────────────────────────────────────────────────────────────────────────────────────────

const enc = getAddressEncoder();
const mintBytes = (m: string) => new Uint8Array(enc.encode(m as Parameters<typeof enc.encode>[0]));
const u32le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const borsh = (s: string, pad = 0) => {
  const b = new TextEncoder().encode(s);
  const body = new Uint8Array(Math.max(pad, b.length));
  body.set(b);
  return new Uint8Array([...u32le(body.length), ...body]);
};
const classicMint = (decimals: number, initialized = true) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = initialized ? 1 : 0;
  return d;
};
const mint2022 = (decimals: number, mint: string, meta?: {name: string; symbol: string}) => {
  const base = new Uint8Array(166);
  base[44] = decimals;
  base[45] = 1;
  base[165] = 1; // AccountType::Mint
  const pointer = new Uint8Array([18, 0, 64, 0, ...new Uint8Array(32), ...mintBytes(mint)]); // MetadataPointer → the mint itself
  const value = meta ? new Uint8Array([...new Uint8Array(32), ...mintBytes(mint), ...borsh(meta.name), ...borsh(meta.symbol), ...borsh("https://x"), ...u32le(0)]) : null;
  const tlv = value ? new Uint8Array([19, 0, value.length & 0xff, value.length >> 8, ...value]) : new Uint8Array();
  return new Uint8Array([...base, ...pointer, ...tlv]);
};
const metaplex = (mint: string, name: string, symbol: string) =>
  new Uint8Array([4, ...new Uint8Array(32), ...mintBytes(mint), ...borsh(name, 32), ...borsh(symbol, 10), ...borsh("https://x", 200)]);

describe("Solana mint parsing", () => {
  it("reads a classic mint and refuses a token account or an uninitialized mint", () => {
    expect(parseMint(classicMint(5), false)).toEqual({decimals: 5, extensions: null});
    expect(parseMint(classicMint(5, false), false)).toBeNull();
    expect(parseMint(new Uint8Array(165), false)).toBeNull();
    expect(parseMint(new Uint8Array(40), false)).toBeNull();
  });

  it("reads a Token-2022 mint's metadata extension for that mint only", () => {
    const data = mint2022(6, BONK, {name: "Bonk 2022", symbol: "BONK"});
    const parsed = parseMint(data, true)!;
    expect(parsed.decimals).toBe(6);
    expect(token2022Metadata(parsed.extensions!, mintBytes(BONK))).toEqual({name: "Bonk 2022", symbol: "BONK"});
    expect(token2022Metadata(parsed.extensions!, mintBytes(SOL_USDC))).toBeNull();
    // A Token-2022 account that isn't a mint (AccountType::Account) is refused.
    const account = data.slice();
    account[165] = 2;
    expect(parseMint(account, true)).toBeNull();
  });

  it("reads Metaplex metadata with its zero padding stripped, for that mint only", () => {
    expect(metaplexMetadata(metaplex(BONK, "Bonk", "Bonk"), mintBytes(BONK))).toEqual({name: "Bonk", symbol: "Bonk"});
    expect(metaplexMetadata(metaplex(BONK, "Bonk", "Bonk"), mintBytes(SOL_USDC))).toBeNull();
    expect(metaplexMetadata(new Uint8Array([3, ...new Uint8Array(80)]), mintBytes(BONK))).toBeNull();
  });
});

describe("readSolanaToken", () => {
  const account = (owner: string, data: Uint8Array) => ({owner, data: [bytesToBase64(data), "base64"]});
  const rpc = (value: unknown) => vi.fn(async () => ({value})) as never;

  it("reads a classic SPL mint with its Metaplex metadata in one call", async () => {
    const call = rpc([account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", classicMint(5)), account("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", metaplex(BONK, "Bonk", "Bonk"))]);
    await expect(readSolanaToken(BONK, call)).resolves.toEqual({decimals: 5, symbol: "Bonk", name: "Bonk"});
    expect((call as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((call as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("getMultipleAccounts");
  });

  it("reads a Token-2022 mint's own metadata and marks it", async () => {
    const call = rpc([account("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", mint2022(9, BONK, {name: "Bonk 2022", symbol: "BK22"})), null]);
    await expect(readSolanaToken(BONK, call)).resolves.toEqual({decimals: 9, symbol: "BK22", name: "Bonk 2022", token2022: true});
  });

  it("names a mint without metadata UNKNOWN", async () => {
    await expect(readSolanaToken(BONK, rpc([account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", classicMint(2)), null]))).resolves.toEqual({decimals: 2, symbol: "UNKNOWN", name: "UNKNOWN"});
  });

  it("refuses no account, another program's account and decimals past 36", async () => {
    await expect(readSolanaToken(BONK, rpc([null, null]))).rejects.toMatchObject({message: "No token at this address on Solana.", definitive: true});
    await expect(readSolanaToken(BONK, rpc([account("11111111111111111111111111111111", classicMint(5)), null]))).rejects.toMatchObject({message: /isn't a token mint/});
    await expect(readSolanaToken(BONK, rpc([account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", classicMint(40)), null]))).rejects.toMatchObject({message: /40 decimals/});
  });

  it("asks again after a network failure", async () => {
    const down = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as never;
    await expect(readSolanaToken(BONK, down)).rejects.toMatchObject({definitive: false});
  });
});

describe("readTokenForImport", () => {
  it("refuses a listed token, a non-importable network and a malformed address before any read", async () => {
    await expect(readTokenForImport(BASE.caip2, BASE_USDC)).rejects.toMatchObject({message: "This is the listed USDC — pick it from the list."});
    await expect(readTokenForImport("tron:728126428", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).rejects.toMatchObject({message: /EVM networks and Solana/});
    await expect(readTokenForImport(BASE.caip2, BONK)).rejects.toMatchObject({message: "That isn't a token address on Base."});
  });
});

// ── look-alikes ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("lookalikeOf", () => {
  it("finds the listed token an import's symbol or name reads as, on its own network only", () => {
    expect(lookalikeOf(degen({symbol: "usdc"}))?.contract?.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(lookalikeOf(degen({symbol: "SCAM", name: "USDC"}))?.symbol).toBe("USDC");
    expect(lookalikeOf({caip2: "eip155:1", symbol: "DEGEN", name: "Degen"})).toBeNull();
    expect(lookalikeOf(degen())).toBeNull();
  });

  it("folds look-alike letters, fullwidth forms and spacing", () => {
    expect(readsAs("USDС")).toBe(readsAs("USDC")); // Cyrillic С
    expect(readsAs("ＵＳＤＣ")).toBe(readsAs("USDC"));
    expect(readsAs("USDC.e")).toBe(readsAs("USDCE"));
    expect(lookalikeOf(degen({symbol: "UЅDС"}))?.symbol).toBe("USDC");
  });

  it("names the network's own coin, and ignores UNKNOWN", () => {
    expect(lookalikeOf(degen({symbol: "ETH"}))).toMatchObject({symbol: "ETH", contract: null});
    expect(lookalikeOf(degen({symbol: "UNKNOWN", name: "UNKNOWN"}))).toBeNull();
  });
});

// ── the store ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("imported tokens in this browser", () => {
  const stored = (over: Record<string, unknown> = {}) => ({chain: "base", contract: DEGEN, symbol: "DEGEN", name: "Degen", decimals: 18, ...over});
  beforeEach(() => {
    localStorage.clear();
    resetImportedTokens();
  });
  afterEach(() => {
    localStorage.clear();
    resetImportedTokens();
    history.replaceState(null, "", "/");
  });

  it("holds every stored entry to the rules again and drops the rest, never crashing", () => {
    expect(parseImportedTokens("nope")).toEqual([]);
    expect(parseImportedTokens(null)).toEqual([]);
    const out = parseImportedTokens([
      stored(),
      stored(), // duplicate
      stored({contract: DEGEN.toLowerCase()}), // the same token in another case
      stored({chain: "base", contract: BASE_USDC}), // listed
      stored({decimals: 37}),
      stored({decimals: 6.5}),
      stored({decimals: "18"}),
      stored({chain: "tron", contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}),
      stored({chain: "nowhere"}),
      stored({contract: "0x0000000000000000000000000000000000000000"}),
      42,
      stored({chain: "solana", contract: BONK, symbol: "\u202eKNOB", name: "", decimals: 5, token2022: true}),
    ]);
    expect(out.map((t) => t.key)).toEqual([`base:${DEGEN.toLowerCase()}`, `solana:${BONK}`]);
    expect(out[1]).toMatchObject({symbol: "KNOB", name: "UNKNOWN", token2022: true, imported: true});
  });

  it("keeps at most the cap", () => {
    const many = Array.from({length: IMPORTED_TOKENS_CAP + 5}, (_, i) => stored({contract: `0x${(i + 1).toString(16).padStart(40, "a")}`}));
    expect(parseImportedTokens(many)).toHaveLength(IMPORTED_TOKENS_CAP);
  });

  it("adds newest first, moves a re-import to the top, drops the oldest past the cap and removes by key", () => {
    addImportedToken(degen());
    const other = importedToken(SOLANA, BONK, {decimals: 5, symbol: "Bonk", name: "Bonk"});
    addImportedToken(other);
    expect(importedTokens().map((t) => t.symbol)).toEqual(["Bonk", "DEGEN"]);
    addImportedToken(degen());
    expect(importedTokens().map((t) => t.symbol)).toEqual(["DEGEN", "Bonk"]);
    expect(JSON.parse(localStorage.getItem(IMPORTED_TOKENS_KEY)!)).toEqual([
      {chain: "base", contract: DEGEN, symbol: "DEGEN", name: "Degen", decimals: 18},
      {chain: "solana", contract: BONK, symbol: "Bonk", name: "Bonk", decimals: 5},
    ]);
    for (let i = 0; i < IMPORTED_TOKENS_CAP; i++) addImportedToken(importedToken(BASE, `0x${(i + 1).toString(16).padStart(40, "b")}`, {decimals: 18, symbol: `T${i}`, name: "t"}));
    expect(importedTokens()).toHaveLength(IMPORTED_TOKENS_CAP);
    expect(importedTokens().some((t) => t.symbol === "Bonk")).toBe(false);
    removeImportedToken(importedTokens()[0]!.key);
    expect(importedTokens()).toHaveLength(IMPORTED_TOKENS_CAP - 1);
  });

  it("never keeps a listed token or out-of-range decimals, whatever a caller hands it", () => {
    addImportedToken({...degen(), contract: BASE_USDC, catalogSymbol: BASE_USDC});
    addImportedToken(degen({decimals: 99}));
    expect(importedTokens()).toEqual([]);
  });

  it("reads what another tab wrote, and survives storage that throws", () => {
    localStorage.setItem(IMPORTED_TOKENS_KEY, JSON.stringify([stored()]));
    resetImportedTokens();
    expect(importedTokens().map((t) => t.symbol)).toEqual(["DEGEN"]);
    localStorage.setItem(IMPORTED_TOKENS_KEY, "{not json");
    resetImportedTokens();
    expect(importedTokens()).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    addImportedToken(degen());
    expect(importedTokens().map((t) => t.symbol)).toEqual(["DEGEN"]);
    spy.mockRestore();
  });

  it("keeps imports in memory only on an IPFS path gateway, whose storage every site there shares", () => {
    history.replaceState(null, "", "/ipfs/bafybeigdyrzt/");
    localStorage.setItem(IMPORTED_TOKENS_KEY, JSON.stringify([stored()]));
    resetImportedTokens();
    expect(importedTokens()).toEqual([]);
    addImportedToken(degen());
    expect(importedTokens()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(IMPORTED_TOKENS_KEY)!)).toEqual([stored()]);
  });
});

// ── joining the token list ──────────────────────────────────────────────────────────────────────────────────────

describe("an imported token in the list", () => {
  it("is never priced, even when its symbol is a priced one", () => {
    const fake = degen({symbol: "USDC"});
    expect(tokenPrice(fake, {USDC: 1})).toBeUndefined();
    const [row] = swapTokens([fake], {[fake.key]: {amount: "5000000", state: "loaded"}}, {USDC: 1}, {evm: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"});
    expect(row).toMatchObject({usd: 0, amount: "5000000", payMode: "wallet"});
    expect(row?.priceUsd).toBeUndefined();
  });

  it("is found by symbol, name and a contract prefix — not by any piece of its contract", () => {
    const [row] = swapTokens([degen()], {}, {}, {});
    expect(matchesToken(row!, "degen")).toBe(true);
    expect(matchesToken(row!, "0x4ed4")).toBe(true);
    expect(matchesToken(row!, "e862")).toBe(false);
  });

  it("is read in a balance read of its own per network, keyed by the imports", () => {
    const solMint = importedToken(SOLANA, BONK, {decimals: 5, symbol: "Bonk", name: "Bonk", token2022: true});
    const specs = balanceSpecs({evm: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", solana: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"}, undefined, [degen(), solMint]);
    const mine = specs.filter((s) => s.imported);
    expect(mine.map((s) => [s.slug, s.tokens.map((t) => t.key)])).toEqual([
      ["base", [`base:${DEGEN.toLowerCase()}`]],
      ["solana", [`solana:${BONK}`]],
    ]);
    expect(balanceKey(mine[0]!)).toEqual(["bal", "base", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "imported", `base:${DEGEN.toLowerCase()}`]);
    expect(balanceKey(specs.find((s) => s.slug === "base" && !s.imported)!)).toEqual(["bal", "base", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]);
    // No imports: the same reads as before.
    expect(balanceSpecs({evm: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}).some((s) => s.imported)).toBe(false);
  });

  it("is never a catalog token", () => {
    expect(TOKENS.some((t: Token) => t.imported)).toBe(false);
    const chain: Chain = BASE;
    expect(listedToken(chain.caip2, DEGEN)).toBeUndefined();
  });
});
