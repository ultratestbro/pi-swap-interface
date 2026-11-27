// Uniswap v3 and v4 as two rows (D53): the gate's pins for Uniswap are the package's own (0.5.0) — SwapRouter02, the
// chain's Universal Router 2.1.2 and Uniswap's SwapProxy as call targets, SwapRouter02 and the SwapProxy as spenders.
import {describe, expect, it} from "vitest";
import {VENUE_RULES, pinnedVenueOf} from "../../../src/execute/pins";

const BASE = "eip155:8453";
const SWAP_ROUTER02_BASE = "0x2626664c2603336E57B271c5C0b26F421741e481";
const UNIVERSAL_ROUTER_BASE = "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40";
const SWAP_PROXY = "0x0000000085E102724e78eCd2F45DC9cA239Affad";

describe("Uniswap's pins (D53)", () => {
  const rule = VENUE_RULES.uniswap!;
  it("v3's SwapRouter02, v4's Universal Router (native input) and SwapProxy (token input) — read live 2026-11-27", () => {
    if (rule.kind !== "pins") throw new Error("uniswap must be a pins rule");
    const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
    expect(lower(rule.pins.callTargets(BASE))).toEqual(expect.arrayContaining(lower([SWAP_ROUTER02_BASE, UNIVERSAL_ROUTER_BASE, SWAP_PROXY])));
    expect(lower(rule.pins.spenders(BASE))).toEqual(expect.arrayContaining(lower([SWAP_ROUTER02_BASE, SWAP_PROXY])));
    // Never the Universal Router as a spender: a v4 native input needs no approval, a token input approves the SwapProxy.
    expect(lower(rule.pins.spenders(BASE))).not.toContain(UNIVERSAL_ROUTER_BASE.toLowerCase());
  });
  it("names a SwapProxy allowance as Uniswap's in the Approvals section", () => {
    expect(pinnedVenueOf(BASE, SWAP_PROXY)).toBe("uniswap");
    expect(pinnedVenueOf(BASE, UNIVERSAL_ROUTER_BASE)).toBeNull();
  });
});
