import {describe, expect, it} from "vitest";
import type {RefusalCategory} from "../../../src/contracts/routes";
import {DEMO_REFUSALS} from "../../../src/mocks";
import {NO_QUOTE, classifyRefusal, gateCode, gateReport, redactRaw, waitWords} from "../../../src/swap/refusals";
import {parseRejections} from "../../../src/swap/routes";

const ETH = {symbol: "ETH", decimals: 18};
const USDC = {symbol: "USDC", decimals: 6};
const BTC = {symbol: "BTC", decimals: 8};

/**
 * Real refusal texts as the router hands them over ("<provider>: …"): the owner's screenshots of 2026-11-11, the
 * live LI.FI 429, and the onRefusal / throw texts of the installed @anywalletkit/protocol-swap2-* dists.
 */
const SAMPLES: readonly [raw: string, category: RefusalCategory, short: string, pay?: typeof ETH][] = [
  // the screenshots
  ["lifi: The transaction does not match the quote: pays 0x6f844aa8f38d91244f057bcc70438a1f5c461b64, not 0xFc3c00000000000000000000000000000c8670", "safety", "Can't confirm it pays you"],
  [
    "lifi: the transaction does not match the quote: the recipient on a non-EVM destination sits in bridge-specific data and cannot be checked here",
    "safety",
    "Can't confirm it pays you",
  ],
  ["thorchain: Refusing quote on node with stale state: invalid request", "unavailable", "Its node is catching up — try again soon"],
  ["near_intents: below the 1Click minimum (at least 0.003098138138549692 ETH)", "amount", "Minimum 0.003099 ETH"],
  ["near_intents: below the 1Click minimum ($100)", "amount", "Minimum $100 right now"],
  // LI.FI keyless quota (live 2026-11-12: 429, ratelimit-limit 75, retry-after 5693 s) and our cooldown's own line
  ["lifi: Rate limit exceeded, retry in 2 hours", "busy", "Request limit hit — back in about 2 hours"],
  ["lifi: rate limit exceeded, retry in ~119 min", "busy", "Request limit hit — back in about 2 hours"],
  // preview rounds (D7): LI.FI left for the live quote while cp0x's proxy doesn't carry it (no refusal: its own quiet
  // group, the screen words the line for what is missing), a venue whose preview handling isn't read; the venue
  // back-off's own line (D29)
  ["lifi: asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key", "deferred", "Connect a wallet to get this quote"],
  ["newvenue: asked only for your live quote, not for previews", "deferred", "Connect a wallet to get this quote"],
  ["relay: rate limit exceeded, retry in ~1 min", "busy", "Request limit hit — back in about 1 minute"],
  ["lifi: rate limit exceeded, retry in ~15 min", "busy", "Request limit hit — back in about 15 minutes"],
  ["lifi: HTTP 429", "busy", "Busy right now — try again soon"],
  ["relay: too many deposits cleared in the last minutes — try again later [order-reused]", "busy", "Busy right now — try again soon"],
  // LI.FI's other checks
  ["lifi: the transaction does not match the quote: bridges to chain 1, not 8453", "safety", "Its transaction didn't match the quote"],
  ["lifi: the transaction does not match the quote: the route runs a call on the destination chain, whose recipient cannot be checked here", "safety", "Can't confirm it pays you"],
  ["lifi: the transaction does not match the quote: refund pays 0x1111111111111111111111111111111111111111, neither the sender 0x22 nor the recipient", "safety", "Can't confirm it pays you"],
  // protocol-swap2-lifi 0.8.0: LI.FI Intents, the deposit facets and Smart Deposits on a Solana route
  [
    "lifi: the transaction does not match the quote: a LI.FI Intents order to an EVM chain names its own oracles, output settler and output amount, which cannot be checked here — its escrow could release the input without the delivery",
    "safety",
    "Can't confirm it pays you",
  ],
  [
    "lifi: the transaction does not match the quote: NEARIntents pays a deposit address whose off-chain order names the Solana recipient — the transaction does not bind it",
    "safety",
    "Can't confirm it pays you",
  ],
  ["lifi: LI.FI Smart Deposits pay a deposit address whose recipient the transaction does not bind — refused for a Solana destination", "safety", "Can't confirm it pays you"],
  ["lifi: quote does not match the request (recipient)", "safety", "Didn't match what was asked"],
  ["lifi: the transaction is malformed or targets an untrusted contract", "safety", "Uses a contract we haven't verified"],
  ["lifi: the approval target is not a trusted LI.FI contract", "safety", "Uses a contract we haven't verified"],
  ["lifi: floor breach (min=1 < floor=2)", "safety", "Guarantees less than your slippage allows"],
  ["lifi: the route takes 3.5% of the input as a fee (over 2%)", "amount", "Fees would take 3.5% — try more"],
  ["lifi: this route's minimum is 1.23% under the quote (LI.FI applies slippage on every step) — more than the requested 0.5%", "setup", "Needs more than your 0.5% slippage"],
  ["lifi: same-chain route settles asynchronously (300 s via across) — a same-chain swap must deliver in the same transaction", "pair", "No instant route for this pair"],
  ["lifi: No available quotes for the requested transfer", "pair", "No route for this pair or amount"],
  ["lifi: no quote within 12 s", "unreachable", "Didn't answer in time — tap refresh"],
  ["lifi: incomplete quote (no action, estimate or transaction)", "unavailable", "Its answer was incomplete — tap refresh"],
  // THORChain
  ["thorchain: thorchain: THORChain fees 8.22% — too expensive at this amount (cap 5%)", "amount", "Fees would take 8.22% of this amount"],
  ["thorchain: failed to simulate swap: emit asset 2251 less than price limit 2262", "setup", "Price moves more than your slippage"],
  ["thorchain: amount at or below THORChain dust threshold", "amount", "Below its minimum amount"],
  ["thorchain: amount below THORChain recommended minimum", "amount", "Below its minimum amount"],
  ["thorchain: amount less than min (recommended_min_amount_in: 120000)", "amount", "Minimum 0.0012 BTC", BTC],
  ["thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals", "amount", "Round the amount to 8 decimals"],
  ["thorchain: slippage 600 bps is outside 0–500 bps", "setup", "Your max slippage is above its limit"],
  ["thorchain: a second node reports another inbound vault — refused until they agree", "safety", "Couldn't double-check its vault"],
  ["thorchain: two THORNodes could not confirm the inbound vault", "safety", "Couldn't double-check its vault"],
  ["thorchain: quote inbound address differs from the node's current inbound (vault rotated) — retry", "unavailable", "Rotating its vault — tap refresh"],
  ["thorchain: quote router differs from the node's current router — retry", "unavailable", "Rotating its vault — tap refresh"],
  ["thorchain: SOL chain is halted / paused on THORChain", "unavailable", "SOL trading is paused right now"],
  ["thorchain: inbound addresses unavailable from every node", "unavailable", "Its nodes didn't answer — tap refresh"],
  // protocol-swap2-thorchain 0.4.0: the second node's ActiveVault rule, its lag and time limits, the height read
  ["thorchain: a second node lists the inbound vault as RetiringVault, not ActiveVault — refused", "safety", "Couldn't double-check its vault"],
  ["thorchain: a second node's mimir flags the inbound vault as compromised — refused", "safety", "Couldn't double-check its vault"],
  ["thorchain: a second node's mimir flags the inbound vault as insolvent — refused", "safety", "Couldn't double-check its vault"],
  ["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)", "safety", "Couldn't double-check its vault"],
  [
    "thorchain: no confirming node is within 50 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up",
    "unavailable",
    "Its node is catching up — try again soon",
  ],
  [
    "thorchain: the 8 s confirmation budget ran out before a second node could be asked to confirm the inbound vault — retry",
    "unreachable",
    "Didn't answer in time — tap refresh",
  ],
  [
    "thorchain: THORChain height (/thorchain/lastblock) unavailable from every node that answered the inbound addresses",
    "unavailable",
    "Its nodes didn't answer — tap refresh",
  ],
  ["thorchain: ETH is halted / paused on the confirming node", "unavailable", "ETH trading is paused right now"],
  ["thorchain: memo failed verification (=:SOL.SOL:abc)", "safety", "Can't confirm it pays you"],
  ["thorchain: memo limit 100 is below expected 120 minus 50 bps slippage (1e8 units)", "safety", "Guarantees less than your slippage allows"],
  ["thorchain: router 0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146 is not a THORChain router this module trusts on eip155:1 (THORCHAIN_ROUTERS / trustedRouters)", "safety", "Uses a contract we haven't verified"],
  ["thorchain: quote expires in 3 s — too soon to execute", "unavailable", "Quote expired — tap refresh"],
  ["thorchain: expected output rounds to zero", "amount", "Too small — try a larger amount"],
  ["thorchain: no pool for USDT on eip155:1 → USDT on solana:mainnet", "pair", "No pool for this pair"],
  // NEAR Intents (1Click)
  ["near_intents: 1Click 400: Temporary swap limits: minimum swap amount is $100. [dry=true tron:728126428->eip155:8453 amount=171798507]", "amount", "Minimum $100 right now"],
  ["near_intents: 1Click 400: No liquidity available [dry=true solana:x->tron:728126428 amount=1]", "unavailable", "Not enough liquidity right now"],
  ["near_intents: 1Click 400: Quoting for this pair is not available [dry=true eip155:1->tron:728126428 amount=2000000]", "pair", "Not quoting this pair right now"],
  ["near_intents: 1Click 500: Internal server error [dry=true a->b amount=1]", "unavailable", "Unavailable right now — try later"],
  ["near_intents: 1Click network error: fetch failed", "unreachable", "Couldn't reach it — tap refresh"],
  ["near_intents: 1Click does not list eip155:1 stETH [dry=true eip155:1->solana:mainnet amount=1]", "pair", "Doesn't list one of these tokens"],
  ["near_intents: corridor paused by the app [dry=true a->b amount=1]", "unavailable", "Paused on this network for now"],
  // Relay
  ["relay: the deposit calls 0xa5f565650890fba1824ee0f21ebbbf660a179934, not the pinned depository [tx-target]", "pair", "Doesn't take this token as a source"],
  // An imported (unlisted) source, probed 2026-11-15 (DEGEN on Base → Arbitrum USDC): Relay would swap it first through its router.
  [
    "relay: the deposit calls 0x5567954cd026cebfe486062cb75848e0f1c12e58, not the Base depository 0x4cd00e387622c35bddb9b4c962c136462338bc31 — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]",
    "pair",
    "Doesn't take this token as a source",
  ],
  ["relay: relay: the order pays 0x1111111111111111111111111111111111111111, not the recipient 0x2222 [output-recipient]", "safety", "Can't confirm it pays you"],
  ["relay: solver 0xabc on \"8453\" is not a pinned Relay solver [solver-not-pinned]", "safety", "Uses a contract we haven't verified"],
  ["relay: the order pays 2 outputs, exactly one is accepted [order-payments]", "safety", "Didn't match what was asked"],
  ["relay: no quote — INSUFFICIENT_LIQUIDITY: Max amount is $1,234.", "amount", "Maximum $1,234 right now"],
  ["relay: no quote — AMOUNT_TOO_LOW: Amount too low", "amount", "Too small — try a larger amount"],
  ["relay: no quote — SWAP_IMPACT_TOO_HIGH: Swap impact is too high: -40.81%", "amount", "Moves the price 41% — try less"],
  ["relay: no quote — SWAP_IMPACT_TOO_HIGH", "amount", "Moves the price too much — try less"],
  ["lifi: The slippage is larger than the defined threshold. Please request a new route to get a fresh quote.", "amount", "Can't hold your slippage at this size"],
  ["lifi: No available quotes for the requested transfer (ROUTE_SLIPPAGE_FLOOR_UNREACHABLE: the slippage floor cannot be met)", "amount", "Can't hold your slippage at this size"],
  ["relay: quote request failed — Failed to fetch", "unreachable", "Couldn't reach it — tap refresh"],
  // Chainflip, Jupiter, CCTP, USDT0, Uniswap, Wrap, Omniston, Symbiosis
  ["chainflip: below the minimum deposit (2000000 BTC)", "amount", "Minimum 0.02 BTC", BTC],
  ["chainflip: no vault swap eip155:8453 → eip155:1", "pair", "Doesn't support this pair"],
  ["chainflip: quote 500: upstream", "unavailable", "Unavailable right now — try later"],
  ["chainflip: encoded destination differs from the request", "safety", "Didn't match what was asked"],
  ["jupiter: the recipient must be the signing wallet (Jupiter pays the taker)", "setup", "Pays only the wallet that signs"],
  ["jupiter: build 400: No routes found", "pair", "No route for this pair or amount"],
  ["jupiter: build 400: Could not find any route", "pair", "No route for this pair or amount"],
  ["cctp: Fast Transfer allowance is exhausted", "unavailable", "Fast transfers used up — try later"],
  ["cctp: amount is below the Fast Transfer fee", "amount", "Too small — try a larger amount"],
  ["cctp: catalog USDC on the source chain is not Circle's native USDC", "pair", "Doesn't list one of these tokens"],
  ["cctp: returned no quote", "other", "No quote right now"],
  ["usdt0: amount 5 is below the OFT minimum 1000000", "amount", "Minimum 1 USDC", USDC],
  ["usdt0: amount 5 exceeds the OFT maximum 12345678901", "amount", "Maximum 12340 USDC", USDC],
  ["usdt0: amount is below the OFT dust threshold — nothing would arrive", "amount", "Too small — try a larger amount"],
  ["usdt0: usdt0: RPC for Arbitrum unavailable — try again", "unreachable", "Couldn't reach it — tap refresh"],
  // protocol-swap2-usdt0 0.5.0: Legacy Mesh recipients the app's address check lets through
  ["usdt0: destination is a testnet-only TON address", "setup", "Doesn't accept this recipient address"],
  ["usdt0: destination is the zero account — nothing sent there can be recovered", "setup", "Doesn't accept this recipient address"],
  ["usdt0: destination must be a TON address (raw 0:… or user-friendly EQ…/UQ…)", "setup", "Doesn't accept this recipient address"],
  ["usdt0: destination must be a TON workchain 0 address — the USDT0 Legacy Mesh pays on the basechain only, not workchain -1", "setup", "Doesn't accept this recipient address"],
  ["uniswap: HTTP request failed. URL: https://rpc.example.org/v2/SECRETKEY Request body: {\"method\":\"eth_call\"}", "unreachable", "Couldn't reach it — tap refresh"],
  ["uniswap: pool liquidity runs out before the full amount (partial fill)", "amount", "Too large for its pools — try less"],
  ["uniswap: no Uniswap v3 pool route for this pair and amount", "pair", "No route for this pair or amount"],
  ["wrap: wrapping pays the sender's own address — send the result separately", "setup", "Pays only your own address"],
  ["omniston: untrusted ton:-239 settlement contract EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ", "safety", "Uses a contract we haven't verified"],
  ["omniston: amount above the 1000 USD per-swap cap", "amount", "Up to $1000 per swap"],
  ["omniston: cross-chain orders are token corridors only (no ETH native leg)", "pair", "Doesn't move native coins across networks"],
  ["omniston: no resolver quoted this route/amount", "pair", "No route for this pair or amount"],
  ["omniston: unavailable in this browser (site storage is blocked)", "setup", "Needs site storage, blocked here"],
  ["symbiosis: Symbiosis answered with a stargate route (a third party holds the funds)", "safety", "Holds funds with a third party"],
  // Symbiosis' HTTP errors (chunk-K3EPNDVO.js:176-183): its 429 is a rate limit (the engine backs off), the rest unavailable
  ["symbiosis: Symbiosis API → 429", "busy", "Busy right now — try again soon"],
  ["symbiosis: Symbiosis: The limit of requests has been exceeded", "busy", "Busy right now — try again soon"],
  ["symbiosis: Symbiosis API → 503", "unavailable", "Unavailable right now — try later"],
  ["symbiosis: amount 100000 is below Symbiosis' minimum 300000 on Base", "amount", "Minimum 0.3 USDC", USDC],
  // the same text for what would arrive is in the receive token's units: no number in the pay token
  ["symbiosis: received amount 10000000 is below Symbiosis' minimum 20000000 on Base", "amount", "Below its minimum amount", ETH],
  // a venue's build check that failed: never weakened, worded as a skip (chunk lines in the dists of 2026-11-04)
  ["chainflip: encoder targets 0x1111111111111111111111111111111111111111, not the Ethereum Vault", "safety", "Uses a contract we haven't verified"],
  ["chainflip: native vault call with a different amount", "safety", "Didn't match what was asked"],
  ["chainflip: token vault call with a different token or amount", "safety", "Didn't match what was asked"],
  ["chainflip: TRC-20 transfer is not the amount to the Vault", "safety", "Didn't match what was asked"],
  ["chainflip: floor 123456 above the expected output 100000", "safety", "Guarantees less than your slippage allows"],
  ["symbiosis: Symbiosis built a transaction for chain 1, not Base", "safety", "Didn't match what was asked"],
  ["symbiosis: Symbiosis quoted another token or chain than requested", "safety", "Didn't match what was asked"],
  ["symbiosis: Symbiosis returned a malformed contract address", "safety", "Didn't match what was asked"],
  ["symbiosis: Symbiosis asks a Tron fee limit of 200000000 sun, above the 100000000 ceiling", "safety", "Didn't match what was asked"],
  ["thorchain: quote names a router for a deposit source — execution model changed", "safety", "Didn't match what was asked"],
  ["thorchain: quote has no router for an EVM source", "safety", "Didn't match what was asked"],
  ["thorchain: the router call moves 0x2222222222222222222222222222222222222222, not the source asset", "safety", "Didn't match what was asked"],
  ["usdt0: OFT asks for a fee in LZ token — unsupported", "safety", "Didn't match what was asked"],
  // Curve (protocol-swap2-curve 0.1.6 dist chunk-NW2OLRIK.js: its RPC loop :469, verifyDeployment :602-616, getQuote :773-875)
  ["curve: curve: no RPC answered on chain 1 (HTTP 429)", "unreachable", "No RPC answered — tap refresh"],
  ["curve: no RPC answered on chain 8453 (rate limit exceeded)", "unreachable", "No RPC answered — tap refresh"],
  ["curve: no RPC answered on chain 10 (Failed to fetch)", "unreachable", "No RPC answered — tap refresh"],
  ["curve: no allowlisted Curve pool route for this pair", "pair", "No vetted Curve pool for this pair"],
  ["curve: no allowlisted Curve pool quotes this pair and amount", "pair", "No route for this pair or amount"],
  ["curve: no Curve router, pool allowlist or RPC for eip155:56", "pair", "Doesn't support this pair"],
  ["curve: the router on chain 1 is not the pinned code (code hash mismatch) — refusing", "safety", "Uses a contract we haven't verified"],
  ["curve: the router on chain 8453 reports version 1.0.0, not 1.1.1 — refusing", "safety", "Uses a contract we haven't verified"],
  ["curve: built a call its own check refuses (the route pays 0x1111111111111111111111111111111111111111, not the recipient)", "safety", "Didn't match what was asked"],
  ["curve: the minimum rounds to zero for this amount", "amount", "Too small — try a larger amount"],
  ["curve: floor breach (min=993010 < floor=995000)", "safety", "Guarantees less than your slippage allows"],
  ["curve: same-chain swaps only", "pair", "Doesn't support this pair"],
  ["curve: that is a wrap/unwrap, not a swap", "pair", "A wrap, not a swap"],
  ["uniswap: that is a wrap/unwrap, not a swap", "pair", "A wrap, not a swap"],
  // Fynd, through cp0x's proxy (protocol-swap2-fynd 0.2.12 dist chunk-6AQCGGUZ.js getQuote :151-235, checkFyndTransaction chunk-6WSGOEAI.js:53-89)
  ["fynd: API unreachable (TypeError)", "unreachable", "Couldn't reach it — tap refresh"],
  ["fynd: API key rejected (HTTP 401)", "unavailable", "Unavailable right now — try later"],
  ["fynd: API key rejected (HTTP 403)", "unavailable", "Unavailable right now — try later"],
  ["fynd: API answered HTTP 502", "unavailable", "Unavailable right now — try later"],
  ["fynd: rate limited (HTTP 429)", "busy", "Busy right now — try again soon"],
  ["fynd: no route for this pair", "pair", "No route for this pair or amount"],
  ["fynd: not enough liquidity for this amount", "amount", "Too large for its pools — try less"],
  ["fynd: the solver timed out", "unreachable", "Didn't answer in time — tap refresh"],
  ["fynd: the solver is still syncing", "unavailable", "Its node is catching up — try again soon"],
  ["fynd: could not encode the swap (fees + slippage leave nothing)", "amount", "Too small — try a larger amount"],
  ["fynd: the route goes through uniswap_v4_hooks, which this wallet excludes", "safety", "Routes through pools we leave out"],
  ["fynd: the route does not execute on-chain right now (simulation reverted via uniswap_v3, curve)", "unavailable", "Would fail on-chain right now"],
  ["fynd: malformed API response (order count)", "unavailable", "Its answer was incomplete — tap refresh"],
  ["fynd: malformed quote amounts", "unavailable", "Its answer was incomplete — tap refresh"],
  ["fynd: quoted 999999, not the requested 1000000", "safety", "Didn't match what was asked"],
  ["fynd: the quote carries a client fee", "safety", "Didn't match what was asked"],
  ["fynd: fee breakdown does not add up to the output", "safety", "Didn't match what was asked"],
  ["fynd: floor breach (min=993010 < floor=995000)", "safety", "Guarantees less than your slippage allows"],
  ["fynd: the transaction targets 0x1111111111111111111111111111111111111111, not the Tycho router on Ethereum", "safety", "Uses a contract we haven't verified"],
  ["fynd: not a plain singleSwap / sequentialSwap / splitSwap call (Permit2 and vault variants are not used)", "safety", "Uses a contract we haven't verified"],
  ["fynd: calldata spends 5, not 1000000", "safety", "Didn't match what was asked"],
  ["fynd: calldata swaps other tokens than requested", "safety", "Didn't match what was asked"],
  ["fynd: calldata pays 0x1111111111111111111111111111111111111111, not 0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "safety", "Can't confirm it pays you"],
  ["fynd: calldata amounts do not match the quote", "safety", "Didn't match what was asked"],
  ["fynd: calldata carries client-fee parameters — this module charges none", "safety", "Didn't match what was asked"],
  ["fynd: native value does not match the input", "safety", "Didn't match what was asked"],
  // a preview round while cp0x's proxy doesn't carry Fynd (its gate keeps it from being asked at all then; this is the
  // round that started as its slot stopped)
  ["fynd: asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key", "deferred", "Connect a wallet to get this quote"],
  // 0x, through cp0x's proxy (protocol-swap2-0x 0.1.1 provider.ts getQuote, settler.ts; D38)
  ["zeroex: API unreachable (TypeError)", "unreachable", "Couldn't reach it — tap refresh"],
  ["zeroex: API key rejected (HTTP 401)", "unavailable", "Unavailable right now — try later"],
  ["zeroex: API answered HTTP 404", "unavailable", "Unavailable right now — try later"],
  ["zeroex: API answered HTTP 502", "unavailable", "Unavailable right now — try later"],
  ["zeroex: rate limited (HTTP 429)", "busy", "Busy right now — try again soon"],
  ["zeroex: no liquidity for this pair and amount", "unavailable", "Not enough liquidity right now"],
  ["zeroex: 0x has too little liquidity for this pair and amount (INSUFFICIENT_ASSET_LIQUIDITY)", "amount", "Too large for its pools — try less"],
  ["zeroex: 0x does not support one of these tokens (TOKEN_NOT_SUPPORTED)", "pair", "Doesn't list one of these tokens"],
  ["zeroex: wrapping and unwrapping are not 0x swaps", "pair", "A wrap, not a swap"],
  ["zeroex: the token being bought taxes transfers — the amount received cannot be guaranteed", "pair", "Doesn't take a token that taxes transfers"],
  ["zeroex: the quoted minimum 14000000 is below the requested slippage (50 bps of 14164402)", "safety", "Guarantees less than your slippage allows"],
  ["zeroex: floor breach (min=14093580 < floor=14100000)", "safety", "Guarantees less than your slippage allows"],
  ["zeroex: quoted 7000000000000000, not the requested 8000000000000000", "safety", "Didn't match what was asked"],
  ["zeroex: malformed API response (liquidity)", "unavailable", "Its answer was incomplete — tap refresh"],
  ["zeroex: recipient must be an EVM address", "setup", "Doesn't accept this recipient address"],
  [
    "zeroex: the 0x registry on chain 8453 names Settler deployment 25 (0x1111111111111111111111111111111111111111), newer than the newest this module accepts there (24) — update @anywalletkit/protocol-swap2-0x, or raise the chain's pins",
    "safety",
    "Uses a 0x contract we haven't checked yet",
  ],
  ["zeroex: no RPC answered on chain 8453 — the 0x Settler cannot be resolved", "unreachable", "No RPC answered — tap refresh"],
  ["zeroex: no RPC is configured for chain 8453 — the 0x Settler cannot be resolved", "setup", "Needs an RPC for this network"],
  ["zeroex: the swap pays 0x1111111111111111111111111111111111111111, not the recipient of this swap", "safety", "Can't confirm it pays you"],
  // Across, priced through cp0x's proxy (protocol-swap2-across 0.1.0: "across: <what> [<code>]"; D38)
  ["across: Across API V5 did not answer (TypeError) [api-answer]", "unreachable", "Couldn't reach it — tap refresh"],
  ["across: Across API V5 answered HTTP 401 unauthenticated [api-error]", "unavailable", "Unavailable right now — try later"],
  ["across: Across API V5 answered HTTP 503 system.unavailable [api-error]", "unavailable", "Unavailable right now — try later"],
  ["across: Across API V5 answered HTTP 429 [api-error]", "busy", "Busy right now — try again soon"],
  ["across: Across API V5 answered HTTP 400 policy.amount_out_of_range (the amount must be at least 2500000 base units) [api-error]", "amount", "Minimum 2.5 USDC", USDC],
  ["across: Across's relayers take at least 500156 base units on this route [relayer-price]", "amount", "Minimum 0.5002 USDC", USDC],
  ["across: Across's relayers take at most 685850520819 base units on this route [relayer-price]", "amount", "Maximum 685800 USDC", USDC],
  ["across: Across's relayer fee quote says the amount is too low relative to fees [relayer-price]", "amount", "Too small — try a larger amount"],
  ["across: the deposit leaves 3000000 of 25000000 as fees, over the 1000 bps cap [tx-fee]", "amount", "Fees would take over 10% — try more"],
  ["across: the deposit leaves relayers 100 of 25000000, under the 100-per-million floor for USDC from Base — relayers do not fill it, and the funds wait for a refund [tx-fee]", "safety", "Priced below what its relayers take"],
  ["across: the deposit leaves relayers no fee — nobody fills it, and the funds wait for a refund [tx-fee]", "safety", "Priced below what its relayers take"],
  ["across: the deposit pays 24000000, under the caller's floor 24900000 [tx-output-amount]", "safety", "Guarantees less than your slippage allows"],
  // a venue's status prefix, or a throw, in front of words no rule knows: never the code, never base units
  ["chainflip: quote 404: ", "other", NO_QUOTE],
  ["chainflip: quote 403: Forbidden", "other", NO_QUOTE],
  ["chainflip: encode 400: invalid destination tag 1234", "other", NO_QUOTE],
  ["chainflip: quote 400: Unsupported asset", "other", "Unsupported asset"],
  ["near_intents: 1Click 401:  [dry=true a->b amount=1]", "other", NO_QUOTE],
  ["near_intents: threw: Unexpected token < in JSON at position 0", "unavailable", "Its answer was incomplete — tap refresh"],
  ["near_intents: threw: Failed to fetch", "unreachable", "Couldn't reach it — tap refresh"],
  // a 429 is busy only where the SDK names it as a status; one inside an amount or a floor is that amount
  ["chainflip: quote 429: ", "busy", "Busy right now — try again soon"],
  ["lifi: Too many requests", "busy", "Busy right now — try again soon"],
  ["near_intents: below the 1Click minimum (at least 0.429 ETH)", "amount", "Minimum 0.429 ETH"],
  ["near_intents: below the 1Click minimum ($429)", "amount", "Minimum $429 right now"],
  ["lifi: floor breach (min=429 < floor=500)", "safety", "Guarantees less than your slippage allows"],
  // the router itself
  ["near_intents: quote timed out after 8000ms", "unreachable", "Didn't answer in time — tap refresh"],
  ["lifi: rejected by validation (minDest=1 vs floor=2, validUntil=0, now=1)", "safety", "Didn't match what was asked"],
  // the page's own: a route left out for thin pools (valueGuard.ts, D50)
  ["uniswap: loses 99.8% of the value to price impact — its pools are too thin for this amount", "amount", "Loses 99.8% to price impact"],
];

const HAS_HOURS = /retry in ~?\d+(?:\.\d+)?\s*h/i;

describe("classifyRefusal: the SDK's texts as the route list shows them", () => {
  it.each(SAMPLES)("%s", (raw, category, short, pay) => {
    const [r] = parseRejections([raw], pay);
    expect(r).toMatchObject({category, reason: short});
  });

  it("every short line is short and plain: no address, hex, base units, URL or HTTP code; never 'minute' for a wait in hours", () => {
    for (const [raw, , , pay] of SAMPLES) {
      const {reason, raw: shown} = parseRejections([raw], pay)[0]!;
      expect(reason.length, raw).toBeLessThanOrEqual(45);
      // an HTTP code is a bare 4xx / 5xx, not the digits of an amount ("Minimum 0.429 ETH", "Minimum $429 right now")
      expect(reason, raw).not.toMatch(/0x[0-9a-f]{4}|\d{7}|https?:|\bHTTP\b|(?<![\d.$])[45]\d\d\b(?![.,]\d)|\[/i);
      expect(shown, raw).not.toMatch(/https?:/);
      if (HAS_HOURS.test(raw)) expect(reason, raw).not.toMatch(/minute/);
    }
  });

  it("safety skips, minimums and the rest each carry one plain sentence; unknown texts carry none", () => {
    const [lifi] = parseRejections([SAMPLES[0]![0]]);
    expect(lifi!.detail).toBe(
      "We check every route's transaction before showing it. This one could pay an address we couldn't confirm is yours, so we left it out.",
    );
    const [fee] = parseRejections(["thorchain: THORChain fees 8.22% — too expensive at this amount (cap 5%)"]);
    // A U-shaped fee share: the text can't tell which side dominates, so it never says "larger" or "smaller".
    expect(`${fee!.reason} ${fee!.detail}`).not.toMatch(/larger|smaller|try more/);
    expect(parseRejections(["lifi: Rate limit exceeded, retry in 2 hours"])[0]!.detail).toMatch(/about 2 hours\.$/);
    expect(classifyRefusal("x", "a brand new SDK sentence that is quite long and unknown")).toEqual({
      reason: NO_QUOTE,
      category: "other",
      raw: "a brand new SDK sentence that is quite long and unknown",
    });
  });

  it("the venue prefix goes (twice when doubled); raw keeps the rest, redacted", () => {
    const r = classifyRefusal("thorchain", "thorchain: thorchain: refusing quote on node with stale state: invalid request");
    expect(r).toMatchObject({category: "unavailable", raw: "refusing quote on node with stale state: invalid request"});
    expect(classifyRefusal("uniswap", "HTTP request failed.\n\n  URL: https://rpc.example.org/key?x=1 Details: boom").raw).toBe("HTTP request failed. URL: <url> Details: boom");
  });

  it("a minimum the venue states in base units rounds UP to 4 significant digits (typing it passes), a maximum DOWN", () => {
    expect(classifyRefusal("chainflip", "below the minimum deposit (3098138138549692 ETH)", ETH).reason).toBe("Minimum 0.003099 ETH");
    expect(classifyRefusal("usdt0", "amount 9 exceeds the OFT maximum 98765432", USDC).reason).toBe("Maximum 98.76 USDC");
    // Without the payer's token the number can't be read: say so without one.
    expect(classifyRefusal("usdt0", "amount 5 is below the OFT minimum 1000000").reason).toBe("Below its minimum amount");
    expect(classifyRefusal("chainflip", "below the minimum deposit (2000000 BTC)", ETH).reason).toBe("Below its minimum amount");
  });

  it("a short unknown text shows as is; one with a code, number or address falls back", () => {
    expect(classifyRefusal("x", "amount must be positive").reason).toBe("Amount must be positive");
    expect(classifyRefusal("x", "unusual 0xabcdef12 thing").reason).toBe(NO_QUOTE);
    expect(classifyRefusal("x", "SOME_CODE happened").reason).toBe(NO_QUOTE);
    expect(classifyRefusal("x", "received 1234567").reason).toBe(NO_QUOTE);
  });
});

describe("classifyRefusal: the venue's reason (swap2-core 0.12.0)", () => {
  it("words a text no rule knows by the reason its venue gave it", () => {
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "insufficient_liquidity")).toMatchObject({
      reason: "Too large for its pools — try less",
      category: "amount",
    });
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "vault_mismatch")).toMatchObject({reason: "Uses a contract we haven't verified", category: "safety"});
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "recipient_mismatch")).toMatchObject({reason: "Can't confirm it pays you", category: "safety"});
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "rate_limited")).toMatchObject({reason: "Busy right now — try again soon", category: "busy"});
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "chain_halted")).toMatchObject({category: "unavailable"});
    expect(classifyRefusal("x", "something new and odd 12345", undefined, "unsupported_pair")).toMatchObject({reason: "Doesn't support this pair", category: "pair"});
  });

  it("a venue's own refusal of the amount stays an amount, though its module tags it price_check_failed", () => {
    // 10 000 USDC Ethereum → clBTC Base, 2026-11-16: Relay's impact cap, tagged price_check_failed by the module.
    expect(classifyRefusal("relay", "relay: no quote — SWAP_IMPACT_TOO_HIGH: Swap impact is too high: -40.81%", undefined, "price_check_failed")).toMatchObject({
      reason: "Moves the price 41% — try less",
      category: "amount",
    });
    expect(classifyRefusal("lifi", "lifi: The slippage is larger than the defined threshold. Please request a new route to get a fresh quote.", undefined, "price_check_failed")).toMatchObject({
      category: "amount",
    });
    // Our own checks keep their section: Relay's output floor (also price_check_failed) is a safety skip.
    expect(classifyRefusal("relay", "relay: the order's minimum output 5 is under the caller's floor 9 [output-minimum]", undefined, "price_check_failed")).toMatchObject({category: "safety"});
  });

  it("never overrides a rule that reads the text, and an unknown or absent reason changes nothing", () => {
    // A rule's own line wins over the reason (the reason here is deliberately another kind).
    expect(classifyRefusal("lifi", "Rate limit exceeded, retry in 2 hours", undefined, "no_route").reason).toBe("Request limit hit — back in about 2 hours");
    expect(classifyRefusal("x", "unusual 0xabcdef12 thing").reason).toBe(NO_QUOTE);
    expect(classifyRefusal("x", "unusual 0xabcdef12 thing", undefined, "not_a_reason" as never).reason).toBe(NO_QUOTE);
  });

  it("0x's and Across's texts no rule reads take the reason their modules give them", () => {
    const rows = parseRejections([
      {message: "zeroex: the API asks for an allowance to something other than canonical Permit2", reason: "vault_mismatch"},
      {message: "zeroex: the quoted minimum is not between zero and the quoted output", reason: "price_check_failed"},
      {message: "zeroex: the 0x Settler registry on chain 8453 reports no taker Settler in force (paused or removed)", reason: "chain_halted"},
      {message: "across: Across's relayer fee quote says this route is not enabled for relayers [relayer-price]", reason: "unsupported_pair"},
      {message: "across: the deposit's depositor 0x1111111111111111111111111111111111111111 is not the signing account [tx-depositor]", reason: "recipient_mismatch"},
    ]);
    expect(rows.map((r) => [r.provider, r.reason, r.category])).toEqual([
      ["zeroex", "Uses a contract we haven't verified", "safety"],
      ["zeroex", "Didn't match what was asked", "safety"],
      ["zeroex", "Paused on this network for now", "unavailable"],
      ["across", "Doesn't support this pair", "pair"],
      ["across", "Can't confirm it pays you", "safety"],
    ]);
  });

  it("parseRejections reads the router's classified refusals as it reads their texts", () => {
    const rows = parseRejections([{message: "zz: something new 12345", reason: "amount_too_small"}, "yy: something new 12345", {message: "lifi: HTTP 429"}]);
    expect(rows.map((r) => [r.provider, r.reason, r.category])).toEqual([
      ["zz", "Too small — try a larger amount", "amount"],
      ["yy", NO_QUOTE, "other"],
      ["lifi", "Busy right now — try again soon", "busy"],
    ]);
  });
});

describe("waitWords / redactRaw", () => {
  it("rounds a wait to its unit, hours from 60 minutes on", () => {
    expect(waitWords(2, "hours")).toBe("2 hours");
    expect(waitWords(119, "min")).toBe("2 hours");
    expect(waitWords(61, "minutes")).toBe("1 hour");
    expect(waitWords(1, "minute")).toBe("1 minute");
    expect(waitWords(30, "seconds")).toBe("30 seconds");
    expect(waitWords(0, "hours")).toBeNull();
  });
  it("caps support text at 400 chars on one line", () => {
    const long = redactRaw(`${"x ".repeat(300)}\n\ttail`);
    expect(long.length).toBe(400);
    expect(long.endsWith("…")).toBe(true);
    expect(redactRaw("a\n\n b wss://ws.example/t")).toBe("a b <url>");
  });
});

describe("demo refusals", () => {
  it("are worded exactly as the classifier words their raw text", () => {
    expect(classifyRefusal("lifi", DEMO_REFUSALS.timeout.raw)).toEqual(DEMO_REFUSALS.timeout);
    expect(classifyRefusal("lifi", DEMO_REFUSALS.paysElsewhere.raw)).toEqual(DEMO_REFUSALS.paysElsewhere);
    expect(classifyRefusal("chainflip", DEMO_REFUSALS.minimumEth.raw, ETH)).toEqual(DEMO_REFUSALS.minimumEth);
    expect(classifyRefusal("chainflip", DEMO_REFUSALS.minimumUsdc.raw, USDC)).toEqual(DEMO_REFUSALS.minimumUsdc);
    expect(classifyRefusal("lifi", DEMO_REFUSALS.liveOnly.raw)).toEqual(DEMO_REFUSALS.liveOnly);
    expect(classifyRefusal("jupiter", DEMO_REFUSALS.signerOnly.raw)).toEqual(DEMO_REFUSALS.signerOnly);
    expect(classifyRefusal("symbiosis", DEMO_REFUSALS.timeout.raw)).toEqual(DEMO_REFUSALS.timeout);
    expect(classifyRefusal("omniston", DEMO_REFUSALS.nativeLeg.raw, ETH)).toEqual(DEMO_REFUSALS.nativeLeg);
    expect(classifyRefusal("omniston", DEMO_REFUSALS.noResolver.raw, USDC)).toEqual(DEMO_REFUSALS.noResolver);
  });
});

describe("gateReport (a safety refusal for the swap statistics, never the person's own request)", () => {
  it("leaves out what the route list asks the person to change: another amount, another setting", () => {
    // THORChain's module refuses these as policy_refused; the owner's alert of 2026-11-20 was the first (0.000000165 ETH).
    expect(gateReport("thorchain", "policy_refused", "thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals")).toBeNull();
    expect(gateReport("thorchain", "policy_refused", "thorchain: thorchain: THORChain fees 8.22% — too expensive at this amount (cap 5%)")).toBeNull();
    expect(gateReport("thorchain", "policy_refused", "thorchain: slippage 600 bps is outside 0–500 bps")).toBeNull();
  });
  it("keeps a check's verdict, with the check it names; no reason or another one is none", () => {
    expect(gateReport("thorchain", "policy_refused", "thorchain: memo failed verification (=:BASE.ETH:0xab12:123:cp:30)")).toBe("policy_refused:memo");
    expect(gateReport("thorchain", "vault_mismatch", "thorchain: router 0xab12 is not a THORChain router this module trusts on ETH")).toBe("vault_mismatch:router");
    expect(gateReport("fynd", "simulation_failed", "swap2: the transaction does not simulate from this account (execution reverted: TRANSFER_FROM_FAILED)")).toBe("simulation_failed:approval");
    expect(gateReport("thorchain", undefined, "thorchain: memo failed verification")).toBeNull();
    expect(gateReport("thorchain", "amount_too_small", "thorchain: memo failed verification")).toBeNull();
  });
});

describe("gateCode (the swap statistics' code for a safety refusal)", () => {
  it("names the check the SDK's text points at, from a fixed list", () => {
    // THORChain's own rules (pinned 0.4.4): the request, not a mismatch.
    expect(gateCode("policy_refused", "thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals")).toBe("policy_refused:precision");
    expect(gateCode("policy_refused", "thorchain: THORChain fees 5.20% — too expensive at this amount (cap 5%)")).toBe("policy_refused:fees");
    expect(gateCode("policy_refused", "thorchain: slippage 600 bps is outside 0–500 bps")).toBe("policy_refused:slippage");
    // And what it built: the memo, the router call.
    expect(gateCode("policy_refused", "thorchain: memo failed verification (=:BASE.ETH:0xab12:123:cp:30)")).toBe("policy_refused:memo");
    expect(gateCode("policy_refused", "thorchain: transfer is not depositWithExpiry")).toBe("policy_refused:calldata");
    expect(gateCode("policy_refused", "thorchain: the router calldata does not decode")).toBe("policy_refused:calldata");
    expect(gateCode("vault_mismatch", "thorchain: router 0xab12 is not a THORChain router this module trusts on ETH")).toBe("vault_mismatch:router");
    expect(gateCode("stale_node", "thorchain: two THORNodes could not confirm the inbound vault")).toBe("stale_node:node");
    // Other venues.
    expect(gateCode("policy_refused", "across: the fill deadline is 30000 s away, past the 21600 s the SpokePool allows")).toBe("policy_refused:deadline");
    expect(gateCode("policy_refused", "symbiosis: Symbiosis built a transaction for chain 1, not 8453")).toBe("policy_refused:chain");
    expect(gateCode("vault_mismatch", "relay: the deposit calls 0x5567954cd026cebfe486062cb75848e0f1c12e58, not the Ethereum depository 0x4cd00e387622c35bddb9b4c962c136462338bc31 — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]")).toBe("vault_mismatch:router");
    expect(gateCode("recipient_unverifiable", "relay: the order is signed by 0xab12, not by its solver 0xcd34")).toBe("recipient_unverifiable:signature");
    expect(gateCode("recipient_mismatch", "relay: the deposit is credited to 0xab12, not to the sender 0xcd34")).toBe("recipient_mismatch:recipient");
    expect(gateCode("policy_refused", "core: swap2: remote provider 'x' asks to approve 0xab on 1, which the app did not pin as a spender")).toBe("policy_refused:approval");
    expect(gateCode("policy_refused", "curve: the route has 9 steps, more than 5")).toBe("policy_refused:route");
    expect(gateCode("policy_refused", "wrap: transfer is not deposit()")).toBe("policy_refused:calldata");
  });

  it("a failed simulation by what its revert names; a text none fits keeps the bare reason", () => {
    expect(gateCode("simulation_failed", "swap2: the transaction does not simulate from this account (execution reverted: TRANSFER_FROM_FAILED)")).toBe("simulation_failed:approval");
    expect(gateCode("simulation_failed", "jupiter: not enough of the input token in the wallet — simulation fails: x")).toBe("simulation_failed:balance");
    expect(gateCode("simulation_failed", "fynd: the swap would revert now (Too little received). Nothing was sent; refresh the quote.")).toBe("simulation_failed:price");
    expect(gateCode("simulation_failed", "swap2: the transaction does not simulate from this account (execution reverted)")).toBe("simulation_failed");
    // No word fits: the revert's selector, alone or before its arguments — never an address or a hash.
    expect(gateCode("simulation_failed", "swap2: the signed swap does not simulate from this account (execution reverted: 0x97A6F3B9)")).toBe("simulation_failed:0x97a6f3b9");
    expect(gateCode("simulation_failed", `the swap would revert now (0x8f2b6f5e${"0".repeat(63)}1)`)).toBe("simulation_failed:0x8f2b6f5e");
    expect(gateCode("simulation_failed", "reverted calling 0x1111111111111111111111111111111111111111")).toBe("simulation_failed");
    expect(gateCode("simulation_failed", `reverted in 0x${"ab".repeat(32)}`)).toBe("simulation_failed");
    expect(gateCode("policy_refused", "cctp: finality threshold 0x12345678")).toBe("policy_refused");
    expect(gateCode("policy_refused", "cctp: finality threshold 1000 is neither Fast nor Standard")).toBe("policy_refused");
  });

  it("never more than the server takes: [A-Za-z0-9_.:-], 48 at most", () => {
    for (const reason of ["recipient_unverifiable", "recipient_mismatch", "vault_mismatch", "stale_node", "policy_refused", "simulation_failed"] as const) {
      for (const text of ["the recipient is unknown", "the signature is odd", "the quote is stale", "fees too high", "a call to 0xab"]) {
        expect(gateCode(reason, text)).toMatch(/^[A-Za-z0-9_.:-]{1,48}$/);
      }
    }
  });
});
