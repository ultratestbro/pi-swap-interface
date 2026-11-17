import {existsSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {CHAINS} from "../../../src/shared/chains";
import {
  monogram,
  NATIVE_TO_CHAIN,
  NETWORK_LOGOS,
  networkLogo,
  PROVIDER_LOGOS,
  providerLogo,
  TOKEN_IMAGES,
  TOKEN_SVGS,
  tokenLogo,
  WALLETCONNECT_LOGO,
} from "../../../src/ui/logos";

const PUBLIC = `${resolve(process.cwd(), "public")}/`;
const exists = (rel: string) => existsSync(`${PUBLIC}${rel}`);
/** Every URL in a src/srcset, without its descriptor. */
const urls = (src: {src: string; srcSet?: string}) => [src.src, ...(src.srcSet?.split(",").map((p) => p.trim().split(" ")[0]!) ?? [])];

describe("logo files", () => {
  it("every table entry has its file, every URL is relative", () => {
    const all = [
      ...[...PROVIDER_LOGOS].map((p) => providerLogo(p)!),
      ...[...NETWORK_LOGOS].map((n) => networkLogo(n)!),
      ...[...Object.keys(TOKEN_IMAGES), ...TOKEN_SVGS].map((t) => tokenLogo(t)!),
    ];
    for (const src of all) {
      for (const u of urls(src)) {
        expect(u.startsWith("logos/"), u).toBe(true);
        expect(exists(u), u).toBe(true);
      }
    }
  });

  it("every shipped file is reachable from a table (nothing orphaned)", () => {
    const networks = readdirSync(`${PUBLIC}logos/networks`).map((f) => f.replace(/\.svg$/, ""));
    expect(new Set(networks)).toEqual(NETWORK_LOGOS);
    const tokens = readdirSync(`${PUBLIC}logos/tokens`).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, ""));
    expect(new Set(tokens)).toEqual(TOKEN_SVGS);
    const stems = new Set(readdirSync(`${PUBLIC}logos/tokens/png`).map((f) => f.replace(/@[23]x\.png$/, "")));
    expect(stems).toEqual(new Set(Object.values(TOKEN_IMAGES)));
    expect(exists("logos/LICENSES.md")).toBe(true);
    expect(WALLETCONNECT_LOGO).toBe("logos/walletconnect.svg");
    expect(exists(WALLETCONNECT_LOGO)).toBe(true);
  });

  it("covers the 18 venues and every catalog network but morph", () => {
    expect(PROVIDER_LOGOS.size).toBe(18);
    expect([...PROVIDER_LOGOS]).toEqual(expect.arrayContaining(["zeroex", "across"]));
    const missing = CHAINS.map((c) => c.slug).filter((slug) => !NETWORK_LOGOS.has(slug));
    expect(missing).toEqual(["morph"]);
  });
});

describe("tokenLogo resolution order", () => {
  it("PNG wins over the SVG (ARB has both)", () => {
    expect(TOKEN_SVGS.has("ARB")).toBe(true);
    expect(tokenLogo("arb")?.src).toBe("logos/tokens/png/arb@2x.png");
    expect(tokenLogo("ARB")?.srcSet).toBe("logos/tokens/png/arb@2x.png 80w, logos/tokens/png/arb@3x.png 120w");
  });

  it("SVG by symbol next", () => {
    expect(tokenLogo("ETH")).toEqual({src: "logos/tokens/ETH.svg"});
  });

  it("a wrapped or bridged token wears its underlying's file", () => {
    expect(tokenLogo("WPOL")?.src).toBe("logos/tokens/png/pol@2x.png");
    expect(tokenLogo("link.e")?.src).toBe("logos/tokens/png/link@2x.png");
    expect(tokenLogo("TON")?.src).toBe("logos/tokens/png/gram@2x.png");
  });

  it("a gas token without its own logo borrows its chain's", () => {
    expect(tokenLogo("MON")?.src).toBe("logos/networks/monad.svg");
    expect(tokenLogo("XDAI")?.src).toBe("logos/networks/gnosis.svg");
  });

  it("anything else has no logo (monogram)", () => {
    expect(tokenLogo("scrvUSD")).toBeNull();
    expect(networkLogo("morph")).toBeNull();
    expect(providerLogo("fynd2")).toBeNull();
    expect(monogram("scrvUSD")).toBe("SCRV");
    expect(monogram("wS")).toBe("WS");
  });

  it("NATIVE_TO_CHAIN agrees with the chain catalog, and every gas token has a logo", () => {
    for (const [sym, slug] of Object.entries(NATIVE_TO_CHAIN)) {
      expect(CHAINS.find((c) => c.slug === slug)?.native.symbol.toUpperCase(), sym).toBe(sym);
    }
    for (const c of CHAINS) expect(tokenLogo(c.native.symbol), c.native.symbol).not.toBeNull();
  });
});
