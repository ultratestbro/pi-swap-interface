/**
 * The execute module's public entry (contract: ExecuteModule in src/contracts/modules.ts) — the only code that asks
 * a wallet to sign: the per-execution gate, the EVM / Solana / NEAR engine accounts behind it, executeSwap and its
 * runner, QR deposits, CCTP claims, swap ids and error texts (engine.md §6-§9, ARCHITECTURE.md D10, D20, D25).
 */
export {executePort} from "./port";
export {maybeSent, swapErrorText, swapFailureExpected, WALLET_DECLINED_TEXT} from "./errors";
export {decodeSwapId, encodeSwapId} from "./ids";
export {FEE_CEILING, swapFeeCap, uncappedFeeText, SwapGateRefusal, SwapReviewMismatch} from "./gate";
export {SOLANA_FEE_CEILING} from "./accounts/solana";
export {omnistonSwapRouteSigned, tonCallSigned} from "./tonPlan";
export {pinnedVenueOf} from "./pins";
