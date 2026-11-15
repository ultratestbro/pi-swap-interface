// A token imported by its address in the engine (D39): its contract and the decimals read on-chain go to the venues
// as the source (swap2-core 0.14.0 `sourceDecimals`), its contract as the destination; a catalog token is named as
// before; venues that serve listed tokens only read "Listed tokens only" in "Not for this pair".
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {describe, expect, it} from "vitest";
import type {PreviewRequest, RouteSnapshot} from "../../../src/contracts/routes";
import {LISTED_ONLY_VENUES, sourceParams, venueScope} from "../../../src/swap";
import {createQuoteEngine, quoteParams} from "../../../src/swap/engine";
import {previewBaseParams} from "../../../src/swap/preview";
import {ME, USDC_ARB, USDC_BASE, request, token, venue} from "./fixtures";

const DEGEN_ADDRESS = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
/** DEGEN on Base as an import: its catalogSymbol is its contract, decimals read on-chain. */
const DEGEN = token({
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  symbol: "DEGEN",
  decimals: 18,
  contract: DEGEN_ADDRESS,
  catalogSymbol: DEGEN_ADDRESS,
  imported: true,
  name: "Degen",
});

describe("sourceParams", () => {
  it("names a catalog token by its catalog symbol and nothing else", () => {
    expect(sourceParams(USDC_ARB)).toEqual({sourceToken: "USDC"});
  });
  it("names an imported token by its contract, with its decimals", () => {
    expect(sourceParams(DEGEN)).toEqual({sourceToken: DEGEN_ADDRESS, sourceDecimals: 18});
  });
});

describe("quoteParams with an imported token", () => {
  it("carries the contract and sourceDecimals for an imported source", () => {
    expect(quoteParams(request({from: DEGEN, to: USDC_BASE, amountIn: 10n ** 21n}))).toEqual({
      sourceChain: "eip155:8453",
      sourceToken: DEGEN_ADDRESS,
      sourceDecimals: 18,
      destChain: "eip155:8453",
      destToken: USDC_BASE.contract,
      amountIn: "1000000000000000000000",
      slippageBps: 30,
      destAddress: ME,
      refundAddress: ME,
      dry: true,
    });
  });

  it("names an imported destination by its contract and leaves a catalog source as it was", () => {
    const p = quoteParams(request({from: USDC_BASE, to: DEGEN}));
    expect(p).toMatchObject({sourceToken: "USDC", destToken: DEGEN_ADDRESS});
    expect("sourceDecimals" in p).toBe(false);
  });

  it("does the same in a preview round's base params", () => {
    const preview: PreviewRequest = {preview: true, from: DEGEN, to: USDC_BASE, amountIn: 10n ** 21n, slippageBps: 30, toOther: false};
    expect(previewBaseParams(preview)).toMatchObject({sourceToken: DEGEN_ADDRESS, sourceDecimals: 18, destToken: USDC_BASE.contract});
  });
});

describe("a quote round for an imported token", () => {
  it("asks the venues with the contract and sourceDecimals, and lists a listed-only venue as not for this pair", async () => {
    const seen: QuoteParams[] = [];
    const anyToken = venue("uniswap", {min: "70000000", sameChain: true, delayMs: 5});
    const ask = anyToken.getQuote.bind(anyToken);
    anyToken.getQuote = (params, signal) => {
      seen.push(params);
      return ask(params, signal);
    };
    // A venue with its own token list says no in supportsRoute: it is never asked.
    const listed = {...venue("cctp", {sameChain: true}), supportsRoute: (from: {token: string}) => from.token === "USDC"};
    const engine = createQuoteEngine({providers: () => [anyToken, listed], gasPrice: async () => null});
    const final = (await engine.quoteRoutes({mode: "live", req: request({from: DEGEN, to: USDC_BASE, amountIn: 10n ** 21n})}, () => {})) as RouteSnapshot;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({sourceToken: DEGEN_ADDRESS, sourceDecimals: 18, destToken: USDC_BASE.contract, dry: true});
    expect(final.asked).toEqual(["uniswap"]);
    expect(final.venues).toEqual(["uniswap", "cctp"]);
    expect(final.routes.map((r) => r.provider)).toEqual(["uniswap"]);
    expect(venueScope("cctp", DEGEN, USDC_BASE)).toBe("Listed tokens only");
  });
});

describe("venueScope with an imported token", () => {
  it("reads 'Listed tokens only' for every venue with its own token list, either side", () => {
    for (const v of LISTED_ONLY_VENUES) {
      expect(venueScope(v, DEGEN, USDC_ARB)).toBe("Listed tokens only");
      expect(venueScope(v, USDC_ARB, DEGEN)).toBe("Listed tokens only");
    }
  });

  it("keeps the network reason for venues that take any token, and says nothing new for listed pairs", () => {
    expect(venueScope("uniswap", DEGEN, USDC_ARB)).toBe("Same-network swaps only");
    expect(venueScope("jupiter", DEGEN, USDC_BASE)).toBe("Swaps within Solana only");
    // A copy named USDC is still an import: CCTP doesn't read it as USDC.
    expect(venueScope("cctp", {...DEGEN, symbol: "USDC"}, USDC_ARB)).toBe("Listed tokens only");
    expect(venueScope("cctp", USDC_BASE, USDC_ARB)).not.toBe("Listed tokens only");
  });
});
