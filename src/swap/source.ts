/**
 * How the engine names the token a swap sells (D39): a catalog token by its catalog symbol, as always; a token imported
 * by its address by its contract or mint, with the decimals read on-chain as `sourceDecimals` (swap2-core 0.14.0's
 * unlisted source: the venues that trade any token resolve it with `sourceAssetOf`, the rest refuse it).
 */
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {Token} from "../contracts/domain";

/** The quote params' source token (and, for an imported token, its decimals). */
export function sourceParams(t: Pick<Token, "catalogSymbol" | "contract" | "decimals" | "imported">): Pick<QuoteParams, "sourceToken" | "sourceDecimals"> {
  return t.imported && t.contract ? {sourceToken: t.contract, sourceDecimals: t.decimals} : {sourceToken: t.catalogSymbol};
}
