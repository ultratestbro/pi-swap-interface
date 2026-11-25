/**
 * The 0x chain table this page runs on (D51): the module's seven chains, plus Monad, which protocol-swap2-0x doesn't
 * list (owner 2026-11-26: on 62 000 MON → AUSD, Matcha's best was 0x at 719.92 AUSD and 0x wasn't even asked here).
 *
 * Monad's entry was read from the chain on 2026-11-26 (rpc.monad.xyz, chain id 143) as the module's README asks:
 *   - the Settler registry 0x00000000000004533Fe15556B1E086BB1A72cEae has code (the same address on every 0x chain);
 *   - `ownerOf(2)` (taker Settler in force) = 0xF16D1df42E368e4dd873b1f92ED0670FF4c987eB = zeroExSettlerAddress(143, 12),
 *     `prev(2)` = 0x031D28683fFc9936903a31670bC618b8Bc9b65dD = zeroExSettlerAddress(143, 11) — both hold code;
 *   - canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) has code;
 *   - WMON 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A answers symbol() "WMON" (Uniswap's WETH9 there too).
 * Every check of the module runs on it unchanged: the Settler is still read from the registry per quote, native sales
 * go only to deployments 12 and 11, token sales also to 13–14 once they hold code, the transaction is decoded and held
 * to the request, and the only spender is Permit2. A newer deployment is refused until this pin is raised.
 */
import {ZEROEX_SETTLER_REGISTRY, zeroExChains, type ZeroExChain} from "@anywalletkit/protocol-swap2-0x/chains";

/** The chains this page adds to the module's table (the provider's `chains` option). */
export const ZEROEX_EXTRA_CHAINS: Readonly<Record<number, ZeroExChain>> = Object.freeze({
  143: Object.freeze({
    name: "Monad",
    registry: ZEROEX_SETTLER_REGISTRY,
    newestLiveNonce: 12,
    previousLiveNonce: 11,
    wrappedNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  }),
});

/** The table in force here: the module's defaults with ZEROEX_EXTRA_CHAINS merged over them (it validates each entry). */
export const WEB_ZEROEX_CHAINS: Readonly<Record<number, ZeroExChain>> = zeroExChains(ZEROEX_EXTRA_CHAINS);
