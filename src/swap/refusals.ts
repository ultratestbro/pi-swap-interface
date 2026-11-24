/**
 * Why a venue sat out, in the user's words (D28). The SDK's refusal texts are
 * written for logs — addresses, base units, HTTP codes, `[dry=…]` tails — and
 * drift between releases, so ONE ordered table turns each into a short line
 * (≤ 45 chars: never an address, hex, base units or an HTTP code), the section
 * of the route list it belongs to, and a plain sentence behind the row's
 * disclosure. The venue's own text stays available, redacted, as the
 * "Technical reason". First match wins, so the order matters: rate limits
 * (RATE_LIMITED, which LI.FI's cooldown reads too) and transport failures
 * before anything that reads like a check, THORChain's vault rotation before
 * the generic "differs" safety rule, the specific safety lines before the
 * generic ones. A text no rule knows is worded by the reason its venue gave
 * it (`Swap2RefusalReason`: since swap2-core 0.12.0 every module classifies its
 * refusals, texts unchanged), else degrades to "No quote right now" unless the
 * API's own words, past the venue's status prefix, are a short plain phrase.
 * The text stays first: a reason only fills in where no rule has read it.
 * No React, no network — unit-tested in refusals.test.ts.
 */
import type {Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {PaySide, RefusalCategory, RouteRejection} from "../contracts/routes";
import {formatUnits} from "./amount";

/** classifyRefusal's answer: a RouteRejection without the venue (parseRejections adds it). */
export type ClassifiedRefusal = Omit<RouteRejection, "provider">;

type Line = string | ((m: RegExpMatchArray, pay?: PaySide) => string);

interface Rule {
  category: RefusalCategory;
  re: RegExp;
  short: Line;
  detail?: Line;
  /** Only for this venue (its refusal codes mean something else elsewhere). */
  provider?: string;
}

/** A short line or detail with this venue's numbers filled in. */
const fill = (line: Line, m: RegExpMatchArray, pay?: PaySide): string => (typeof line === "string" ? line : line(m, pay));

/** `units` rounded to 4 significant digits: up for a minimum (typing it always passes), down for a maximum. */
function sig4(units: bigint, up: boolean): bigint {
  const digits = units.toString().length;
  if (digits <= 4) return units;
  const unit = 10n ** BigInt(digits - 4);
  return up ? ((units + unit - 1n) / unit) * unit : (units / unit) * unit;
}

/** Base units → a decimal with 4 significant digits ("3098138138549692" at 18 → "0.003099" rounded up). */
const units4 = (units: bigint, decimals: number, up: boolean): string => formatUnits(sig4(units, up), decimals);

/** A decimal string from the venue ("0.003098138138549692") → 4 significant digits, rounded up. */
function decimal4Up(text: string): string {
  const [int = "0", frac = ""] = text.split(".");
  return units4(BigInt(`${int}${frac}` || "0"), frac.length, true);
}

/** "$100." → "100": a trailing full stop is the sentence's, not the number's. */
const dollars = (text: string): string => text.replace(/[.,]+$/, "");

/** "Minimum 0.02 BTC" in the payer's own symbol, or the venue's minimum without a number when the token is unknown. */
const minimumOf = (units: string | undefined, decimals: number | undefined, pay?: PaySide): string =>
  pay && units && decimals !== undefined ? `Minimum ${units4(BigInt(units), decimals, true)} ${pay.symbol}` : "Below its minimum amount";

/** N of a venue's wait unit ("hours", "min", "secs") in ms, or null when that isn't a positive wait. */
export function waitMs(n: number, unit: string): number | null {
  const u = unit.toLowerCase();
  const ms = n * (u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1_000);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The wait a venue names ("retry in 2 hours", our cooldown's "retry in ~119 min") as words, rounded to its unit. */
export function waitWords(n: number, unit: string): string | null {
  const ms = waitMs(n, unit);
  if (ms === null) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (ms >= 60_000) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = Math.ceil(ms / 1_000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

const waitOf = (m: RegExpMatchArray): string | null => waitWords(Number(m[1]), m[2] ?? "");

const PAYS_YOU =
  "We check every route's transaction before showing it. This one could pay an address we couldn't confirm is yours, so we left it out.";
const MISMATCH = "We re-check every quote against your request. This one didn't match, so we left it out.";
const RETRY = "Busy right now — try again soon";
const BUSY = "The venue is limiting requests from this browser for a while.";

/**
 * A venue's rate limit, read the same way by the route list, the engine's back-off (limiter.ts) and LI.FI's cooldown
 * (providerWrappers.ts): its own words, or a 429 the SDK names as a status ("HTTP 429", "quote 429: …", Symbiosis'
 * "Symbiosis API → 429" for a body without a message, chunk-K3EPNDVO.js:176-183) — never any 429, which can be a
 * minimum ("at least 0.429 ETH") or a floor ("min=429").
 */
export const RATE_LIMITED = /rate.?limit|too many requests|limit of requests|(?:HTTP|status|quote|build|encode|1Click|API \u2192):?\s*429\b/i;
/**
 * The wait a rate limit names ("retry in 2 hours", "retry after ~3 min"; number, unit): ONE pattern, so the list's
 * "back in about …" and the back-offs that stop asking (limiter.ts, coolDownOnRateLimit) read the same wait.
 */
export const RETRY_WAIT = String.raw`retry (?:in|after) ~?(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b`;

/** The table, in match order. Each line was checked against the SDK texts in refusals.test.ts. */
const RULES: readonly Rule[] = [
  // ── venue codes that mean something else elsewhere ──
  {
    provider: "relay",
    category: "pair",
    re: /\[tx-target\]$/,
    short: "Doesn't take this token as a source",
    detail: "Its deposit would first swap through a router we don't sign for — pick a token it bridges directly.",
  },
  {
    provider: "omniston",
    category: "safety",
    re: /untrusted .*(?:settlement contract|order protocol)/,
    short: "Uses a contract we haven't verified",
    detail: "Its settlement contract isn't on our audited list, so we left it out.",
  },
  {provider: "omniston", category: "amount", re: /above the ([\d.,]+) USD per-swap cap/, short: (m) => `Up to $${dollars(m[1]!)} per swap`, detail: "This venue caps each swap — try a smaller amount."},
  {
    provider: "omniston",
    category: "pair",
    re: /token corridors only/,
    short: "Doesn't move native coins across networks",
    detail: "Between networks it carries tokens only, not the native coin.",
  },
  // Curve quotes from the contracts: its RPC loop's last word names the RPC's own failure (a 429, -32005, a timeout),
  // so this goes before the rate-limit and transport rules.
  {
    provider: "curve",
    category: "unreachable",
    re: /no RPC answered on chain/,
    short: "No RPC answered — tap refresh",
    detail: "Curve quotes straight from its contracts over this network's RPCs, and none of them answered this time.",
  },
  {
    provider: "curve",
    category: "pair",
    re: /no allowlisted Curve pool route/,
    short: "No vetted Curve pool for this pair",
    detail: "Curve is asked only over a pinned list of checked pools, and none of them connects these tokens.",
  },
  {
    provider: "curve",
    category: "safety",
    re: /is not the pinned code|reports version .* refusing/,
    short: "Uses a contract we haven't verified",
    detail: "Its router or pool on this network isn't the exact contract the Curve module pins, so we left it out.",
  },
  {provider: "curve", category: "safety", re: /built a call its own check refuses/, short: "Didn't match what was asked", detail: MISMATCH},
  // Fynd is reached only through cp0x's proxy (Standard): a transport failure or a refused key means "not now".
  {
    provider: "fynd",
    category: "unreachable",
    re: /^API unreachable/,
    short: "Couldn't reach it — tap refresh",
    detail: "Fynd is asked through cp0x's server, and this browser couldn't reach it — an ad blocker, VPN or network filter can cause this.",
  },
  {
    provider: "fynd",
    category: "unavailable",
    re: /^API (?:key rejected|answered HTTP)/,
    short: "Unavailable right now — try later",
    detail: "Fynd is asked through cp0x's server with cp0x's key, and it couldn't get a quote from Fynd just now.",
  },
  {
    provider: "fynd",
    category: "safety",
    re: /which this wallet excludes/,
    short: "Routes through pools we leave out",
    detail: "Its route goes through a kind of pool this app leaves out (Uniswap v4 hook pools quoted above the market and reverted), so we left it out.",
  },
  {
    provider: "fynd",
    category: "unavailable",
    re: /does not execute on-chain right now/,
    short: "Would fail on-chain right now",
    detail: "We simulated its transaction and it would revert, so we left it out — a fresh quote may work.",
  },

  // 0x and Across are reached only through cp0x's proxy (Standard, D38): a transport failure or a refused key means
  // "not now". 0x's own texts (protocol-swap2-0x 0.1.1 provider.ts / settler.ts), worded where the reason alone would
  // say less.
  {
    provider: "zeroex",
    category: "unreachable",
    re: /^API unreachable/,
    short: "Couldn't reach it — tap refresh",
    detail: "0x is asked through cp0x's server, and this browser couldn't reach it — an ad blocker, VPN or network filter can cause this.",
  },
  {
    provider: "zeroex",
    category: "unavailable",
    re: /^API (?:key rejected|answered HTTP (?!429))/,
    short: "Unavailable right now — try later",
    detail: "0x is asked through cp0x's server with cp0x's key, and it couldn't get a quote from 0x just now.",
  },
  {provider: "zeroex", category: "amount", re: /too little liquidity for this pair and amount/, short: "Too large for its pools — try less", detail: "Its liquidity runs out before the full amount — try a smaller amount or split the swap."},
  {provider: "zeroex", category: "pair", re: /does not support one of these tokens|does not serve the token being (?:bought|sold)/, short: "Doesn't list one of these tokens", detail: "This venue doesn't trade one of these tokens on this network."},
  {
    provider: "zeroex",
    category: "pair",
    re: /taxes transfers/,
    short: "Doesn't take a token that taxes transfers",
    detail: "The token you'd receive takes a fee on every transfer, so the amount 0x guarantees wouldn't arrive — it's left out.",
  },
  {provider: "zeroex", category: "safety", re: /is below the requested slippage/, short: "Guarantees less than your slippage allows", detail: "Its guaranteed amount is below what your max slippage allows, so we left it out."},
  {
    provider: "zeroex",
    category: "safety",
    re: /newer than the newest this module accepts/,
    short: "Uses a 0x contract we haven't checked yet",
    detail: "0x deployed a new Settler contract; this app calls it once that deployment is reviewed and pinned, so we left it out.",
  },
  {provider: "zeroex", category: "unreachable", re: /no RPC answered on chain|could not read the 0x Settler/, short: "No RPC answered — tap refresh", detail: "0x's contract is read from the chain over this network's RPCs, and none of them answered this time."},
  {provider: "zeroex", category: "setup", re: /no RPC is configured for chain/, short: "Needs an RPC for this network", detail: "0x's contract is read from the chain: add a working RPC for this network in Settings."},
  // Across (protocol-swap2-across 0.1.0: "across: <what> [<code>]"): API V5 prices through cp0x's proxy; its own
  // relayer-fee quote and the deposit checks.
  {
    provider: "across",
    category: "unreachable",
    re: /^Across API V5 did not answer/,
    short: "Couldn't reach it — tap refresh",
    detail: "Across is priced through cp0x's server, and this browser couldn't reach it — an ad blocker, VPN or network filter can cause this.",
  },
  {
    provider: "across",
    category: "amount",
    re: /the amount must be at least (\d+) base units|relayers take at least (\d+) base units/,
    short: (m, pay) => minimumOf(m[1] ?? m[2], pay?.decimals, pay),
    detail: "Below what Across's relayers take on this route — try a larger amount.",
  },
  {
    provider: "across",
    category: "amount",
    re: /the amount must be at most (\d+) base units|relayers take at most (\d+) base units/,
    short: (m, pay) => (pay ? `Maximum ${units4(BigInt(m[1] ?? m[2]!), pay.decimals, false)} ${pay.symbol}` : "Above its maximum for this pair"),
    detail: "More than Across's relayers take on this route in one deposit — try a smaller amount.",
  },
  {
    provider: "across",
    category: "unavailable",
    re: /^Across API V5 answered HTTP (?!429)\d+ (?:unauthenticated|auth\.|permission\.)/,
    short: "Unavailable right now — try later",
    detail: "Across is priced through cp0x's server with cp0x's key, and it couldn't get a price from Across just now.",
  },
  {
    provider: "across",
    category: "amount",
    re: /as fees, over the (\d+) bps cap/,
    short: (m) => `Fees would take over ${Number(m[1]) / 100}% — try more`,
    detail: "At this size Across's fee is above the share of the amount this app accepts — a larger amount spreads it.",
  },
  {
    provider: "across",
    category: "safety",
    re: /leaves relayers (?:no fee|\d+ of \d+, under the)/,
    short: "Priced below what its relayers take",
    detail: "Its price leaves Across's relayers less than they take to fill a deposit, so it could wait hours for a refund — we left it out.",
  },
  // ── rate limits (LI.FI keyless: about 75 quotes per 2 h per IP) ──
  {
    category: "busy",
    re: new RegExp(String.raw`(?:${RATE_LIMITED.source})[\s\S]*?${RETRY_WAIT}`, "i"),
    short: (m) => {
      const wait = waitOf(m);
      return wait ? `Request limit hit — back in about ${wait}` : RETRY;
    },
    detail: (m) => {
      const wait = waitOf(m);
      return wait ? `This venue limits how often one browser can ask for quotes; it should answer again in about ${wait}.` : BUSY;
    },
  },
  {category: "busy", re: new RegExp(`${RATE_LIMITED.source}|too many deposits`, "i"), short: RETRY, detail: BUSY},

  // CoW (protocol-swap2-cow 0.1.0, D48): "cow: the orderbook is unreachable (TypeError)" when its fetch fails — the
  // browser never reached api.cow.fi, as the transport rule below reads it (a 5xx reads "unavailable" by its reason).
  {
    provider: "cow",
    category: "unreachable",
    re: /the orderbook is unreachable/,
    short: "Couldn't reach it — tap refresh",
    detail: "Your browser couldn't connect to CoW's orderbook — an ad blocker, VPN or network filter can cause this.",
  },

  // ── the browser never got an answer ──
  {
    category: "unreachable",
    re: /Failed to fetch|NetworkError when attempting|Load failed|\bCORS\b|network error|fetch failed|HTTP request failed|took too long to respond|RPC for .* unavailable|\bURL: /i,
    short: "Couldn't reach it — tap refresh",
    detail: "Your browser couldn't connect to it — an ad blocker, VPN or network filter can cause this.",
  },
  {
    category: "unreachable",
    re: /timed out|no quote within|AbortError|TimeoutError|signal is aborted|operation was aborted|user aborted|^aborted$/i,
    short: "Didn't answer in time — tap refresh",
    detail: "It took longer than the quote round allows, so the list went on without it.",
  },

  // ── THORChain node health and vault ──
  {
    category: "unavailable",
    re: /stale state|not (?:yet )?synced|catching up|still syncing/i,
    short: "Its node is catching up — try again soon",
    detail: "The node we asked is a few blocks behind and won't quote until it catches up.",
  },
  // protocol-swap2-thorchain 0.4.3 (chunk-EIAXGWNG.js:648/651): every node that could double-check the vault lags the
  // quoting node by more than 50 blocks, or the 8 s confirmation budget ran out before one could be asked.
  {
    category: "unavailable",
    re: /no confirming node is within \d+ blocks/,
    short: "Its node is catching up — try again soon",
    detail: "The nodes that double-check its vault are behind the one that quoted, and won't confirm until they catch up.",
  },
  {
    category: "unreachable",
    re: /confirmation budget ran out/,
    short: "Didn't answer in time — tap refresh",
    detail: "No second THORChain node could double-check its vault in the time a quote allows, so the list went on without it.",
  },
  {
    category: "safety",
    re: /could not confirm the inbound vault|refused until they agree|no second node answered|reports another (?:inbound vault|router)|not ActiveVault|mimir flags the inbound vault/,
    short: "Couldn't double-check its vault",
    detail: "Two THORChain nodes must agree on where your funds go; they didn't this time, so we left it out.",
  },
  {category: "unavailable", re: /vault rotated|router differs/, short: "Rotating its vault — tap refresh", detail: "THORChain is moving to a new vault; a fresh quote will use it."},

  // ── a preview round left it for the live quote (D7): no refusal, the list's quiet "Quoted after you connect" group;
  // the screen words the short line for what is missing (form/model.ts deferredCopy) ──
  {
    category: "deferred",
    re: /asked only for your live quote/,
    short: "Connect a wallet to get this quote",
    detail: "Preview prices skip it here to save its request limit for your own quote — it's asked as soon as your wallet is connected or your address is entered.",
  },

  // ── something the user can change ──
  {
    category: "setup",
    re: /recipient must be the signing wallet|pays only the wallet that signs/,
    short: "Pays only the wallet that signs",
    detail: 'It always pays the wallet that signs — turn off "Send to another address" to use it.',
  },
  {
    category: "setup",
    re: /wrapping pays the sender's own address/,
    short: "Pays only your own address",
    detail: 'Wrapping lands in the paying wallet — turn off "Send to another address" and send it afterwards.',
  },
  {
    category: "setup",
    re: /minimum is ([\d.]+)% under the quote[\s\S]*requested ([\d.]+)%/,
    short: (m) => `Needs more than your ${m[2]}% slippage`,
    detail: (m) => `Its guaranteed minimum is ${m[1]}% below the quote — raise max slippage in settings to see it.`,
  },
  {
    category: "setup",
    re: /emit asset \d+ less than price limit/,
    short: "Price moves more than your slippage",
    detail: "The pool would pay less than your max slippage allows — raise slippage or try a smaller amount.",
  },
  {
    category: "setup",
    re: /slippage \S+ bps is (?:outside|out of range)|slippage must be/,
    short: "Your max slippage is above its limit",
    detail: "This venue caps slippage — lower it in settings to see this route.",
  },
  {
    category: "setup",
    re: /recipient is not valid|destination address is not the same chain|(?:recipient|destination) (?:is not|must be) an? [\s\S]*address|testnet-only TON address|destination is the zero account/i,
    short: "Doesn't accept this recipient address",
    detail: "The receiving address isn't one this venue can pay on the destination network.",
  },
  {
    category: "setup",
    re: /refund ?address (?:is not|must be)|refundAddress is not/i,
    short: "Doesn't accept this refund address",
    detail: "The refund address isn't one this venue can use on the paying network.",
  },
  {
    category: "setup",
    re: /site storage is blocked|enable site storage/i,
    short: "Needs site storage, blocked here",
    detail: "This venue keeps a record of your swap in browser storage — allow site data or leave private mode.",
  },
  {category: "setup", re: /no RPC configured/, short: "Needs an RPC for this network", detail: "Add a working RPC for this network in Settings."},

  // ── the amount ──
  {
    category: "amount",
    re: /fees ([\d.]+)%\s*[—–-]+\s*too expensive/,
    short: (m) => `Fees would take ${m[1]}% of this amount`,
    detail: "Small amounts lose most to the network fee, large ones to the pool's price impact — try a different amount.",
  },
  {
    category: "amount",
    re: /takes ([\d.]+)% of the input as a fee/,
    short: (m) => `Fees would take ${m[1]}% — try more`,
    detail: "At this size most of the amount goes to fixed fees — a larger amount spreads them.",
  },
  {
    category: "amount",
    re: /minimum swap amount is \$([\d.,]+)|below the 1Click minimum \(\$([\d.,]+)\)/i,
    short: (m) => `Minimum $${dollars(m[1] ?? m[2]!)} right now`,
    detail: "This venue's current minimum for the pair, in dollars; it moves with network fees.",
  },
  {
    category: "amount",
    re: /below the 1Click minimum \(at least (\d+(?:\.\d+)?) ([A-Za-z][\w.]{0,11})\)/,
    short: (m) => `Minimum ${decimal4Up(m[1]!)} ${m[2]}`,
    detail: "Below this venue's minimum for the pair; it moves with network fees.",
  },
  {
    category: "amount",
    re: /recommended_min_amount_in"?:\s*"?(\d+)/,
    short: (m, pay) => minimumOf(m[1], 8, pay),
    detail: "Below THORChain's recommended minimum, which covers the network fee on the way out.",
  },
  {
    category: "amount",
    re: /THORChain dust threshold|THORChain recommended minimum/,
    short: "Below its minimum amount",
    detail: "Below THORChain's recommended minimum, which covers the network fee on the way out.",
  },
  {
    category: "amount",
    re: /below the minimum deposit \((\d+) (\S+)\)/,
    short: (m, pay) => (pay && (m[2] === pay.symbol || m[2] === pay.catalogSymbol) ? minimumOf(m[1], pay.decimals, pay) : "Below its minimum amount"),
    detail: "Below this venue's minimum for the pair.",
  },
  {category: "amount", re: /below minimum swap amount \((\d+)\)/i, short: (m, pay) => minimumOf(m[1], pay?.decimals, pay), detail: "Below this venue's minimum for the pair."},
  {
    // Symbiosis says the same for what would arrive, in the receive token's units: no number in the pay token.
    category: "amount",
    re: /received amount \d+ is below Symbiosis' minimum/,
    short: "Below its minimum amount",
    detail: "Too little would arrive for this venue's minimum — try a larger amount.",
  },
  {
    category: "amount",
    re: /below the OFT minimum (\d+)|(?:^|\s)amount \d+ is below Symbiosis' minimum (\d+)/,
    short: (m, pay) => minimumOf(m[1] ?? m[2], pay?.decimals, pay),
    detail: "Below this venue's minimum for this token.",
  },
  {
    category: "amount",
    re: /exceeds the OFT maximum (\d+)/,
    short: (m, pay) => (pay ? `Maximum ${units4(BigInt(m[1]!), pay.decimals, false)} ${pay.symbol}` : "Above its maximum for this pair"),
    detail: "Above this venue's per-transfer limit — try a smaller amount.",
  },
  {category: "amount", re: /Max amount is \$([\d.,]+)/i, short: (m) => `Maximum $${dollars(m[1]!)} right now`, detail: "More than the liquidity it has right now — try a smaller amount."},
  {
    category: "amount",
    re: /above Symbiosis' maximum|per-swap cap|initial amount is too high/i,
    short: "Above its maximum for this pair",
    detail: "More than this venue takes in one swap — try a smaller amount.",
  },
  {category: "amount", re: /more precision than THORChain/, short: "Round the amount to 8 decimals", detail: "THORChain counts in 8 decimals — drop the extra digits."},
  {
    category: "amount",
    re: /dust threshold|too small for this pool|minimum output rounds to 0|rounds to zero|AMOUNT_TOO_LOW|amount is too low|lower than estimated swap fees|below the Fast Transfer fee|nothing would arrive|fees higher than the initial amount|fee takes the whole amount|bridges nothing after|fees \+ slippage leave nothing/i,
    short: "Too small — try a larger amount",
    detail: "Too little would arrive after this venue's fees.",
  },
  {
    category: "amount",
    re: /partial fill|insufficient liquidity for requested amount|INSUFFICIENT_LIQUIDITY|not enough liquidity for this amount/i,
    short: "Too large for its pools — try less",
    detail: "Its pools run out before the full amount — try a smaller amount or split the swap.",
  },
  // The venues' own refusals of the amount that their modules tag `price_check_failed` — read here by their text, so the
  // reason doesn't file them under "Skipped for your safety": none of them is one of our checks.
  {
    // Relay's price-impact cap (SWAP_IMPACT_TOO_HIGH: "Swap impact is too high: -40.81%").
    provider: "relay",
    category: "amount",
    re: /SWAP_IMPACT_TOO_HIGH(?:: Swap impact is too high: -?([\d.]+)%)?/,
    short: (m) => (m[1] ? `Moves the price ${Math.max(1, Math.round(Number(m[1])))}% — try less` : "Moves the price too much — try less"),
    detail: "At this size the trade would move the price too far on its route — a smaller amount gets a fair rate.",
  },
  {
    // LI.FI's SlippageError (1007) and its slippage-floor filter: its route can't hold the slippage asked at this size.
    provider: "lifi",
    category: "amount",
    re: /slippage is larger than the defined threshold|ROUTE_SLIPPAGE_FLOOR_UNREACHABLE/i,
    short: "Can't hold your slippage at this size",
    detail: "At this amount its route would slip more than your max slippage allows — try a smaller amount or a higher max slippage.",
  },

  // ── the venue is down or paused ──
  {
    category: "unavailable",
    re: /inbound addresses unavailable|no quote from any node|THORChain height \(\/thorchain\/lastblock\) unavailable/,
    short: "Its nodes didn't answer — tap refresh",
    detail: "None of the nodes we use for this venue answered this time.",
  },
  {
    category: "unavailable",
    re: /(?:^|\s)([A-Z][A-Z0-9]{1,5}) (?:chain )?is halted/,
    short: (m) => `${m[1]} trading is paused right now`,
    detail: "This venue has paused that network; it usually resumes on its own.",
  },
  {category: "unavailable", re: /corridor paused by the app/, short: "Paused on this network for now", detail: "This venue is paused on this network while it has issues."},
  {
    category: "unavailable",
    re: /1Click 5\d\d|HTTP 5\d\d|Internal server error|RFQ failed|SOR answered HTTP|^(?:quote|build|encode) 5\d\d\b|Symbiosis API/i,
    short: "Unavailable right now — try later",
    detail: "The venue's service returned an error on its side.",
  },
  {category: "unavailable", re: /allowance is exhausted/, short: "Fast transfers used up — try later", detail: "Circle's fast-transfer budget is spent for now."},
  {category: "unavailable", re: /too soon to execute|deadline (?:already passed|too close)|quote again|re-quote/i, short: "Quote expired — tap refresh", detail: "The quote ran out before it could be used."},
  {
    category: "unavailable",
    re: /no liquidity/i,
    short: "Not enough liquidity right now",
    detail: "No one offered this pair at this amount just now — a different amount may work.",
  },
  {
    category: "unavailable",
    re: /incomplete quote|without an? \w+ amount|answer without|unusable|not JSON|not valid JSON|Unexpected token|unreadable|no minimum output|no minAmountOut|answered without order|named no \w|reported no fees|malformed (?:API response|quote amounts)/i,
    short: "Its answer was incomplete — tap refresh",
    detail: "It answered without something we need to check the quote, so we left it out.",
  },

  // ── the SDK refused the route (safety): never weakened, only worded ──
  {
    category: "safety",
    re: /pays \S+, (?:not|neither)|non-EVM destination|recipient cannot be checked|does not bind|not the recipient|is credited to|\[output-recipient\]|\[refund-|memo does not pay|memo failed verification|another owner|refund-not-trader|excess-not-trader|receiver-not-destination|pays a TON address that is not the recipient|release the input without the delivery/,
    short: "Can't confirm it pays you",
    detail: PAYS_YOU,
  },
  {category: "safety", re: /third party holds the funds/, short: "Holds funds with a third party", detail: "This route parks your funds with another service on the way, so we left it out."},
  {
    category: "safety",
    re: /transaction does not match the quote/,
    short: "Its transaction didn't match the quote",
    detail: "We check every route's transaction before showing it. This one didn't match its own quote, so we left it out.",
  },
  {
    category: "safety",
    re: /untrusted|not a trusted|not pinned|did not pin|this module trusts|unknown Diamond call|does not decode|calldata is|not a known deposit|solver-not-pinned|not the pinned|approval target is not|unknown-layout|unsupported-ton-route|targets \S+, not the|not a plain singleSwap/i,
    short: "Uses a contract we haven't verified",
    detail: "Its transaction calls a contract we haven't checked, so we left it out.",
  },
  {
    category: "safety",
    re: /floor breach|below the floor|caller's floor|memo limit \d+ is below|bps under its expected|below the \d+ shown|guaranteed \d+ is below|min-out-|^floor \d+ above the expected output/,
    short: "Guarantees less than your slippage allows",
    detail: "Its guaranteed amount is below what your max slippage allows, so we left it out.",
  },
  {
    category: "safety",
    re: /(?:does|do|did) not match|mismatch|differs from|ignored the requested slippage|more than the \d+ spent|rejected by validation|is not the canonical|outside 0\.5x|charges an app fee|gas top-up|inconsistent with|more received than sent|another destination|quoted \d+, not the requested|spends \d+, not|other tokens than requested|carries (?:a )?client.fee|does not add up/i,
    short: "Didn't match what was asked",
    detail: MISMATCH,
  },
  {
    // The venues' own build checks: Chainflip's vault call, THORChain's router call, Symbiosis' transaction, USDT0's fee.
    category: "safety",
    re: /vault call with a different|is not the amount to the Vault|source token \S+ is not|router for (?:an EVM|a deposit) source|moves \S+, not the|built a transaction for chain|built a Tron call that is not|quoted another token or chain|answered with a '|malformed (?:Tron )?(?:contract|transaction)|fee limit (?:of )?\d+|fee in LZ token/,
    short: "Didn't match what was asked",
    detail: MISMATCH,
  },
  {
    // Relay names each check by a code ("… [order-payments]"); the ones left here are its order / deposit checks.
    provider: "relay",
    category: "safety",
    re: /\[(?:order|quote|tx|input|output|payment|protocol|hub)-[a-z-]+\]$/,
    short: "Didn't match what was asked",
    detail: MISMATCH,
  },

  // ── it doesn't serve this pair ──
  {
    category: "pair",
    re: /settles asynchronously/,
    short: "No instant route for this pair",
    detail: "A swap on one network must finish in one transaction; it only offered a delayed one.",
  },
  {
    category: "pair",
    re: /does not list|asset not listed|unknown (?:source |destination )?token|not in the catalog|invalid or in deny list|INVALID_(?:INPUT|OUTPUT)_CURRENCY|UNSUPPORTED_CURRENCY|not Circle's native USDC|is not USDT0/i,
    short: "Doesn't list one of these tokens",
    detail: "This venue doesn't trade one of these tokens on these networks.",
  },
  {category: "pair", re: /no pool for|pool does not exist/, short: "No pool for this pair", detail: "It has no pool for one of these tokens."},
  {
    category: "pair",
    re: /that is a wrap\/unwrap, not a swap|wrapping and unwrapping are not 0x swaps/,
    short: "A wrap, not a swap",
    detail: "Native coin ⇄ its wrapped token is a 1:1 wrap, which the Wrap venue does.",
  },
  {
    category: "pair",
    re: /does not serve|no vault swap|not wired for|is not a destination|same-chain (?:\S+ )?only|same-chain swaps are not|not a bridge|not an Omniston order corridor|USDT0 is not deployed|not offered for this pair|publishes no fee|UNSUPPORTED_(?:CHAIN|ROUTE)|chain-unsupported|sources are switched off|no (?:Uniswap v3 deployment|Balancer v2 Vault|wrapped native token|Curve router, pool allowlist) or RPC|only \S+ ↔ \S+/i,
    short: "Doesn't support this pair",
    detail: "This venue doesn't connect these tokens or networks.",
  },
  {category: "pair", re: /pair is not available/i, short: "Not quoting this pair right now", detail: "It isn't offering this pair at the moment."},
  {
    category: "pair",
    re: /No routes? found|no route for this pair|could not find any route|no Uniswap v3 pool route|no Balancer v2 pool route|no allowlisted Curve pool quotes|no resolver quoted|no TON DEX route|No available quotes|NO_SWAP_ROUTES_FOUND|neither Fast nor Standard/i,
    short: "No route for this pair or amount",
    detail: "It found no way to make this swap right now — another amount may work.",
  },

  // ── no reason given ──
  {category: "other", re: /returned no quote/, short: "No quote right now", detail: "It answered without a quote and gave no reason."},
];

/** The short line every unknown text falls back to. */
export const NO_QUOTE = "No quote right now";

/** Never in a short line: an address or hash, a long base58 run, a URL, an HTTP status (also as the SDK names it). */
const UNSHOWABLE = /0x[0-9a-f]{4}|[1-9A-HJ-NP-Za-km-z]{25,}|https?:|<url>|\b(?:HTTP|status) ?\d{3}\b|\b(?:quote|build|encode|1Click) \d{3}\b/i;
/** An unknown text is shown only without those, a number of 3+ digits (base units, a code, a chain id), brackets or a CODE_NAME. */
const UNSHOWN_TEXT = /\d{3}|[[\]{}()<>]|\b[A-Z]+_[A-Z_]+\b/i;
/** What a venue puts before the API's own words: Chainflip "quote 404: ", Jupiter "build 400: ", 1Click, NEAR's "threw: ". */
const STATUS_PREFIX = /^(?:(?:quote|build|encode|1Click) (?:\d{3}|failed|network error)|threw):\s*/i;
/** A bare HTTP reason phrase ("Forbidden") tells a person nothing they can act on. */
const HTTP_PHRASE = /^(?:bad request|unauthorized|forbidden|not found|method not allowed|conflict|gone|internal server error|bad gateway|service unavailable|gateway timeout)\.?$/i;

/** The SDK text as support reads it: URLs out (keyed RPCs), one line, at most 400 chars. */
export function redactRaw(text: string): string {
  const one = text
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, "<url>")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 400 ? `${one.slice(0, 399)}…` : one;
}

/** "thorchain: thorchain: x" → "x": the router and some modules each prefix the venue. */
function stripVenue(provider: string, text: string): string {
  let t = text.trim();
  const prefix = `${provider.toLowerCase()}: `;
  for (let i = 0; i < 2 && provider && t.toLowerCase().startsWith(prefix); i++) t = t.slice(prefix.length).trim();
  return t;
}

/** An unknown text, if what the venue's API said is already a short plain phrase; else the fallback line. */
function fallbackLine(text: string): string {
  const r = text
    .replace(/\s*\[dry=[^\]]*\]?$/, "")
    .replace(/\s*\[[a-z]+(?:-[a-z]+)*\]$/, "")
    .replace(STATUS_PREFIX, "")
    .trim();
  if (!r || r.length > 40 || HTTP_PHRASE.test(r) || UNSHOWABLE.test(r) || UNSHOWN_TEXT.test(r)) return NO_QUOTE;
  return r[0]!.toUpperCase() + r.slice(1);
}

/**
 * The line for a text no rule knows, by the reason its venue classified it with (swap2-core 0.12.0
 * `Swap2RefusalReason`; the router keeps it next to the text, `RouteSet.refusals` / `lastRefusals`). Worded as the
 * rules above word the same kind of refusal, never stronger than the reason says.
 */
/**
 * The SDK's safety refusals: a check that refused the route — a recipient or vault it couldn't verify, a node behind,
 * the venue's own policy, a failed simulation — as against no route, a limit or an expired quote. Reported to the swap
 * statistics (D41: activity/counter reportRefused, from a quote round and from execution).
 */
export const GATE_REASONS: ReadonlySet<Swap2RefusalReason> = new Set<Swap2RefusalReason>([
  "recipient_unverifiable",
  "recipient_mismatch",
  "vault_mismatch",
  "stale_node",
  "policy_refused",
  "simulation_failed",
]);

/**
 * Which of a venue's checks refused, for the swap statistics (owner 2026-11-19): `policy_refused:memo`. The tag is a
 * word from this fixed list — the first whose pattern the SDK's text names, the narrower ones first — never the text
 * itself (it can name tokens, hosts, functions). A rough area, not the exact check; a text none fits keeps the bare reason.
 */
const CHECK_TAGS: readonly (readonly [tag: string, re: RegExp])[] = [
  // The request, not the venue's answer: THORChain's 8 decimals, a slippage past its cap.
  ["precision", /\bprecision\b|\bdecimals\b/i],
  ["slippage", /slippage|tolerance/i],
  // The quote's own state: priced for display, from another session or caller; a venue switched off or busy.
  ["requote", /quote again|dry quote|not checked on this device|not known on this side|not sealed|not issued to this caller|intent (?:id|token)|integrity check/i],
  ["disabled", /\bdisabled\b|switched off|\bpaused\b/i],
  ["limit", /too many|try again later/i],
  ["origin", /redirect|another origin/i],
  // What the venue built.
  ["memo", /\bmemo\b|\bnote\b/i],
  // Relay's deposit that first swaps through a router ("… go through a router and are not signed by this module"):
  // the router, not a signature — its "signed by" would otherwise land under signature.
  ["router", /through a router/i],
  ["signature", /permit|typed (?:data|order)|EIP712|signature|signed by|\bnonce\b|\btypes\b|witness/i],
  ["approval", /approv|allowance|spender|transfer_?from/i],
  ["fees", /fee|affiliate/i],
  ["gas", /\bgas\b|compute.?budget|\btip\b/i],
  ["deadline", /deadline|\bexpir|live (?:longer|past)|quote time|\bwindow\b/i],
  ["node", /\bnodes?\b|THORNode|\bheight\b/i],
  ["balance", /\bbalances?\b|not enough of/i],
  ["calldata", /calldata|\bdecodes?\b|re-encode|canonically encoded/i],
  ["recipient", /recipient|receiver|destination|beneficiary|\bowner\b|refund|\bpays?\b|on behalf of|\bsender\b|\bdepositor\b|credited to|\btaker\b|\btrader\b|\bmaker\b/i],
  ["chain", /\bchain(?:Id)?\b/i],
  ["order", /\border\b|solver|relayer/i],
  ["router", /\brouter\b/i],
  ["contract", /contract|\bvault\b|\bbridge\b|\bportal\b|settlement|\bdex\b|wrapped native/i],
  ["route", /\broutes?\b|\bsteps?\b|\bhops?\b|\bbatch\b|\blegs?\b|\bpools\b|\bsources?\b|swap.?(?:type|mode)|\bwraps?\b/i],
  ["token", /\btokens?\b|\bassets?\b|\bpath\b|\bpool\b|\bcoins?\b|\bmints?\b|jetton|\bdelivers\b|\bsells\b/i],
  ["amount", /\bamounts?\b|amountIn|\bsends?\b|\btakes\b|\bmoves\b|\bvalue\b|\bwei\b|\bcovers\b|\binput\b|\bspends?\b|\bbridges\b|\bswaps\b|\bpull\b/i],
  ["price", /\bprice\b|too little|\boutput\b|\bminimum\b/i],
  ["calldata", /calldata|function|selector|decode|encod|\bcalls?\b|router|target|transaction|payload|message|\bbytes?\b|instruction|program|protobuf|\bBoC\b|\bcell\b|escrow|interaction|profile|\bbuild\b|param|offset|array/i],
  // A call that is not the one function it must be: "transfer is not batchSwap", "… is not deposit()".
  ["calldata", /\bis not (?:[a-z]+[A-Z]\w*|\w+\(\))/],
  ["quote", /quote|metadata/i],
];

/** A failed simulation, by what its revert names (its text always names the transaction, so the list above can't). */
const REVERT_TAGS: readonly (readonly [tag: string, re: RegExp])[] = [
  ["approval", /allowance|transfer_?from|approv|permit/i],
  ["balance", /\bbalances?\b|not enough|insufficient funds/i],
  ["price", /slippage|too little|insufficient.?output|minimum|return amount|price/i],
  ["deadline", /deadline|expired/i],
  ["gas", /\bgas\b/i],
  ["requote", /no longer quotes/i],
];

/** A revert's custom error: its 4-byte selector, alone or before whole 32-byte words (never an address or a hash). */
const SELECTOR = /0x([0-9a-f]{8})(?:[0-9a-f]{64})*(?![0-9a-f])/i;

/**
 * The code a safety refusal is reported with: its reason, and the check its text names ("policy_refused:fees"). A
 * failed simulation none of its words fit is named by its revert's selector, when the text carries one
 * ("simulation_failed:0x97a6f3b9": an error a contract declares, not free text).
 */
export function gateCode(reason: Swap2RefusalReason, text: string): string {
  // Without the "<venue>: " / "swap2: " in front (of each error of a chain, " | "): a venue's name is no check ("wrap: …").
  const said = text.replace(/(^| \| )(?:[\w-]+: )+/g, "$1");
  const tag = (reason === "simulation_failed" ? REVERT_TAGS : CHECK_TAGS).find(([, re]) => re.test(said))?.[0];
  if (tag) return `${reason}:${tag}`;
  const selector = reason === "simulation_failed" ? said.match(SELECTOR)?.[1] : undefined;
  return selector ? `${reason}:0x${selector.toLowerCase()}` : reason;
}

/** Route-list sections that ask the person to change their own request — the amount, a setting — not a check's verdict. */
const REQUEST_CATEGORIES: ReadonlySet<RefusalCategory> = new Set<RefusalCategory>(["amount", "setup"]);

/**
 * The code a venue's refusal is reported to the swap statistics with (D41), or null when it is no safety refusal: a
 * reason outside GATE_REASONS, or one the route list files under the person's own request. THORChain's module refuses
 * 8+ decimals, its 5% fee cap and a slippage past its range as `policy_refused`, yet each asks for another amount or
 * setting — the owner's alert "policy_refused:precision" for 0.000000165 ETH (2026-11-20) was no check at work.
 */
export function gateReport(provider: string, reason: Swap2RefusalReason | undefined, text: string): string | null {
  if (!reason || !GATE_REASONS.has(reason)) return null;
  if (REQUEST_CATEGORIES.has(classifyRefusal(provider, text, undefined, reason).category)) return null;
  return gateCode(reason, text);
}

const BY_REASON: Readonly<Record<Swap2RefusalReason, {category: RefusalCategory; short: string; detail: string}>> = {
  rate_limited: {category: "busy", short: RETRY, detail: BUSY},
  upstream_unavailable: {category: "unavailable", short: "Unavailable right now — try later", detail: "The venue's service didn't give a usable answer just now."},
  key_rejected: {category: "unavailable", short: "Unavailable right now — try later", detail: "The venue refused the key it was asked with, so it couldn't quote just now."},
  chain_halted: {category: "unavailable", short: "Paused on this network for now", detail: "This venue has paused that network; it usually resumes on its own."},
  stale_node: {category: "unavailable", short: "Its node is catching up — try again soon", detail: "The node we asked is behind and won't quote until it catches up."},
  quote_expired: {category: "unavailable", short: "Quote expired — tap refresh", detail: "The quote ran out before it could be used."},
  simulation_failed: {category: "unavailable", short: "Would fail on-chain right now", detail: "We simulated its transaction and it would revert, so we left it out — a fresh quote may work."},
  no_route: {category: "pair", short: "No route for this pair or amount", detail: "It found no way to make this swap right now — another amount may work."},
  unsupported_pair: {category: "pair", short: "Doesn't support this pair", detail: "This venue doesn't connect these tokens or networks."},
  amount_too_small: {category: "amount", short: "Too small — try a larger amount", detail: "Too little would arrive after this venue's fees."},
  amount_too_large: {category: "amount", short: "Above its maximum for this pair", detail: "More than this venue takes in one swap — try a smaller amount."},
  insufficient_liquidity: {category: "amount", short: "Too large for its pools — try less", detail: "Its pools run out before the full amount — try a smaller amount or split the swap."},
  recipient_unverifiable: {category: "safety", short: "Can't confirm it pays you", detail: PAYS_YOU},
  recipient_mismatch: {category: "safety", short: "Can't confirm it pays you", detail: PAYS_YOU},
  vault_mismatch: {category: "safety", short: "Uses a contract we haven't verified", detail: "Its transaction calls a contract we haven't checked, so we left it out."},
  price_check_failed: {category: "safety", short: "Didn't match what was asked", detail: MISMATCH},
  policy_refused: {category: "safety", short: "Didn't match what was asked", detail: MISMATCH},
};

/**
 * A venue's refusal for the route list: the short line, its section, one plain sentence and the redacted original.
 * `raw` is the text after "<provider>: " (parseRejections splits it); `pay` lets minimums in base units read as
 * "Minimum 0.02 BTC". A templated line that would still show an address or a code falls back to "No quote right now".
 * `reason`: the venue's classification of it (swap2-core 0.12.0), read only when no rule knows the text.
 */
export function classifyRefusal(provider: string, raw: string, pay?: PaySide, reason?: Swap2RefusalReason): ClassifiedRefusal {
  const text = stripVenue(provider, raw);
  const shown = redactRaw(text);
  for (const rule of RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    const m = text.match(rule.re);
    if (!m) continue;
    const short = fill(rule.short, m, pay);
    const line = UNSHOWABLE.test(short) ? NO_QUOTE : short;
    const detail = rule.detail ? fill(rule.detail, m, pay) : undefined;
    return {reason: line, category: rule.category, ...(detail ? {detail} : {}), raw: shown};
  }
  const by = reason !== undefined && Object.prototype.hasOwnProperty.call(BY_REASON, reason) ? BY_REASON[reason] : undefined;
  if (by) return {reason: by.short, category: by.category, detail: by.detail, raw: shown};
  return {reason: fallbackLine(text), category: "other", raw: shown};
}
