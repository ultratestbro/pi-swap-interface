/**
 * Preview rounds (D7): prices before the user's addresses exist — no wallet connected, no recipient or refund typed
 * yet. A preview is priced, never reviewed: the snapshot is marked `preview`, the screen can't open the review on it,
 * and the live round re-quotes with the real addresses before anything is shown for review or paid.
 *
 * Placeholders live ONLY here, inside the engine's preview round, and only where a venue's dry quote needs a
 * destination it doesn't fill itself (each read in the installed 0.x dists, 2026-11-12):
 *   - uniswap refuses a blank recipient ("recipient must be an EVM address", chunk-6ZGWUPLL.js:145);
 *   - curve refuses one the same way (chunk-NW2OLRIK.js:789); it quotes with get_dy over RPC, so the sample only
 *     ever sits in calldata that is never sent;
 *   - balancer refuses one the same way (chunk-XFRLZ25H.js:125); it prices with the Vault's queryBatchSwap eth_call,
 *     which moves nothing, the sample as recipient and, with no refund given, as sender too (:176-178);
 *   - thorchain sends the blank destination, gets no memo and refuses "incomplete quote" (protocol-swap2-thorchain
 *     0.4.3 chunk-EIAXGWNG.js:725/781);
 *   - chainflip throws on a blank Solana destination (chunk-SJ6UVIVY.js:119-128);
 *   - near_intents passes the recipient as given (chunk-4DBCMQCI.js:198);
 *   - fynd refuses a blank recipient the same way (protocol-swap2-fynd 0.2.12 chunk-6AQCGGUZ.js:168); the sample is
 *     then its sender too, with no EVM refund given (:170), and a dry quote needs no real one: the API is sent both
 *     only as the order's addresses (:181), and the native-input simulation runs the quote's call from the sender with
 *     a state override that gives it the input plus 1 ETH (:230-232), so the sample needs no funds;
 *   - lifi only for Solana → EVM: its dry quote reuses the SENDER's placeholder as the destination (protocol-swap2-lifi
 *     0.8.3 chunk-G26GE46T.js:789/961-962), its own EVM placeholder (the EVM sample, :688) or Solana one (:689, in
 *     VENUE_SAMPLES), right for EVM → EVM and Solana → Solana and an address of the wrong family for Solana → EVM.
 *     EVM → Solana keeps the blank: it prices for its own Solana placeholder (dryRecipient, :789). The sender stays
 *     its own placeholder (or the user's refund); every LI.FI check runs on the dry quote as on a live one, and a
 *     quote priced for a placeholder comes back price-only, without its transaction (placeholderIn, :790-793/1182).
 * Every other venue keeps its blank address and applies its own handling: relay flags a quote with a blank
 * address as a placeholder and never issues it (chunk-BCY6ZEAE.js:170/276) — a value here would bypass that, so it
 * is NEVER filled; cctp fills its own EVM placeholder; usdt0 fills its own (the EVM sample, or the zero account into
 * TON or Tron) and returns a price-only quote without its transaction (protocol-swap2-usdt0 0.5.3 chunk-7FQDRYVI.js:89,
 * :285, :494, :556; never filled here: the TON sample is the zero account it refuses); symbiosis fills its own on a
 * dry quote, the sender too, so it never needs a real one (chunk-K3EPNDVO.js:257-261; VENUE_SAMPLES); omniston's RFQ
 * carries no address, and it checks the addresses only for a live quote (chunk-DMO24BFW.js:2072-2101; its IndexedDB
 * quote store then holds blank ones); wrap and jupiter quote a blank or lone address; zeroex (0x) asks its price
 * endpoint with no `taker` when it has none (protocol-swap2-0x 0.1.1 provider.ts getQuote: a dry quote's taker is the
 * refund or recipient only when one is an address), and across prices a dry quote for its own placeholder depositor
 * and recipient (`ACROSS_PLACEHOLDER`, the EVM sample) and never builds or signs it (protocol-swap2-across 0.1.0
 * verify.ts acrossRequestOf, provider.ts requestOf); stargate prices a dry quote with a blank sender or recipient for
 * its own placeholder, 0x1111…1111, and returns its transaction built for it (protocol-swap2-stargate 0.1.0, checked
 * live 2026-11-17) — never issued: a preview is never reviewable (D7), and a live quote carries the user's addresses.
 * The refund address is the user's real one or absent (never "": NEAR reads `refundAddress ?? its placeholder`).
 * Symbiosis' pacer (providers.ts) is the page's one, shared with live rounds: a preview burst queues in it and never
 * goes past its 1 request/s; a superseded round's queued call sends nothing (its signal is aborted).
 * LI.FI, Fynd, 0x and Across are asked in a preview only while cp0x's proxy carries them with cp0x's key (KEYED_PREVIEW_VENUES:
 * a Standard page, health "keyed", the slot not stopped), decided per round: there cp0x's daily budgets cap the
 * spend, not LI.FI's keyless ~75 /quote per 2 h per IP or one visitor's share of Fynd's, 0x's or Across's key.
 * Anywhere else LI.FI waits for the live quote ("Connect a wallet to get this quote", a `deferred` row); Fynd, 0x and
 * Across, asked only while their slot is live (providers.ts whileLive), are then asked by no round, live ones
 * included, and absent from the list.
 */
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {Family} from "../contracts/domain";
import type {PreviewRequest} from "../contracts/routes";
import {destTokenId} from "../catalog";
import {SIGNER_ONLY_REFUSAL} from "./providerWrappers";
import {sourceParams} from "./source";

/**
 * One sample address per destination family, copied from the SDK's own table (protocol-swap2-near-intents
 * chunk-4DBCMQCI.js:46-60, which picked live, valid addresses); each passes isAddressFor (preview.test.ts). NEAR's
 * "near" is not an address the app accepts, so NEAR pairs get no preview. Never shown or stored, and never a reason
 * to refuse what a user types: 0xd8dA…6045 is a real account people send to.
 */
export const PREVIEW_PLACEHOLDER: Readonly<Partial<Record<Family, string>>> = {
  evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  solana: "1nc1nerator11111111111111111111111111111111",
  ton: "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ",
  tron: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9",
  zcash: "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua",
};

/** What a sample reads as in a venue's text. No space, so the refusal rules' `\S+` ("pays \S+, not") still match. */
export const SAMPLE_STANDIN = "<sample-address>";

/**
 * Placeholders a venue fills in itself for a blank address, scrubbed like the samples. usdt0, cctp, Symbiosis and
 * LI.FI use the EVM sample above; Symbiosis adds a TON one and the EVM sample in Tron form (chunk-K3EPNDVO.js:33-35/213),
 * which it sends as `to` and its answers can repeat; LI.FI a Solana sender and recipient (chunk-G26GE46T.js:689/789),
 * which its checks name ("the Solana transaction is paid by …, not the sender …", :615) and so can its API's messages.
 */
const VENUE_SAMPLES: readonly string[] = [
  "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
  "TVjpchRyV9wdpj6kmwqVsBDWY1J8PaFtnb",
  "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
];

/** Each sample as a venue's text can spell it: EVM in any case, with or without 0x (inside calldata). */
const SAMPLE_TEXT = [
  ...Object.entries(PREVIEW_PLACEHOLDER).map(([family, sample]) => ({
    sample: sample!,
    evm: family === "evm",
    re: family === "evm" ? new RegExp(`(?:0x)?${sample!.slice(2)}`, "gi") : new RegExp(sample!, "g"),
  })),
  ...VENUE_SAMPLES.map((sample) => ({sample, evm: false, re: new RegExp(sample, "g")})),
];

/**
 * A preview round's venue text with every sample address replaced by SAMPLE_STANDIN, so a sample never reads as a
 * payee in the list: THORChain's "memo failed verification (=:BTC.BTC:bc1qar0…)" echoes the destination it was
 * quoted for, and NEAR fills an absent refund from the same table. `keep` = the user's own addresses, never replaced
 * even when one equals a sample.
 */
export function scrubSamples(text: string, keep: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const {sample, evm, re} of SAMPLE_TEXT) {
    if (keep.some((k) => k && (evm ? k.toLowerCase() === sample.toLowerCase() : k === sample))) continue;
    out = out.replace(re, SAMPLE_STANDIN);
  }
  return out;
}

/**
 * Venues a preview round may ask (every venue the page builds): their blank-address handling was read in the dists.
 * A venue not listed here (a new one, not read yet) is never asked for a preview.
 */
export const PREVIEW_VENUES: ReadonlySet<string> = new Set([
  "uniswap",
  "curve",
  "balancer",
  "wrap",
  "usdt0",
  "stargate",
  "cctp",
  "thorchain",
  "chainflip",
  "near_intents",
  "lifi",
  "relay",
  "symbiosis",
  "jupiter",
  "omniston",
  "fynd",
  "zeroex",
  "across",
  "cow",
]);

/**
 * Venues a preview round asks only while cp0x's proxy carries them with cp0x's key (read per round: a Standard page,
 * health "keyed", the slot not stopped). LI.FI's keyless /quote allows about 75 per 2 h per IP, too few to spend on
 * visitors who haven't connected; Fynd, 0x and Across have no keyless way in at all (D38). Through the proxy cp0x's
 * daily budgets cap the spend (LI.FI 5000, Fynd 3000 shared with the cp0x wallet; 0x's and Across's are the proxy's)
 * and D29's bucket paces each tab. Such a call never falls back to a keyless one beyond the routing's one retry after
 * a failure at the proxy, once per page (config keyedOnly); a proxy-only venue never falls back at all.
 */
export const KEYED_PREVIEW_VENUES: ReadonlySet<string> = new Set(["lifi", "fynd", "zeroex", "across"]);

/** Venues whose dry quote needs a destination it doesn't fill: a blank one gets the destination family's sample. */
export const FILLS_DESTINATION: ReadonlySet<string> = new Set(["uniswap", "curve", "balancer", "thorchain", "chainflip", "near_intents", "fynd"]);

/**
 * Venues whose dry quote fills a blank destination with its own placeholder of the SOURCE family (LI.FI: the sender's,
 * chunk-G26GE46T.js:961-962): the destination family's sample only when the two families differ, and never for a
 * Solana destination, which LI.FI fills with its own Solana placeholder (dryRecipient, :789).
 */
export const FILLS_OTHER_FAMILY: ReadonlySet<string> = new Set(["lifi"]);

/** Venues that pay only the signer: with "Send to another address" on they would refuse the live quote. */
export const SIGNER_ONLY: ReadonlySet<string> = new Set(["jupiter", "wrap"]);

/** The refusal a venue whose preview handling isn't read gets in a preview round; refusals.ts words it for the list. */
export const LIVE_ONLY_REFUSAL = "asked only for your live quote, not for previews";

/** The same for a KEYED_PREVIEW_VENUES venue while cp0x's proxy doesn't carry it (the row's "Technical reason"). */
export const KEYED_ONLY_REFUSAL = "asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key";

/** Both families have a sample address: a preview can be priced for this pair. */
export const canPreview = (fromFamily: Family, toFamily: Family): boolean => !!PREVIEW_PLACEHOLDER[fromFamily] && !!PREVIEW_PLACEHOLDER[toFamily];

/**
 * The router's params for a preview round: the real addresses or blank, never a placeholder (quoteParams, which
 * throws on a blank address, is for live requests only). dry: true — a preview is never a live quote.
 */
export function previewBaseParams(req: PreviewRequest): QuoteParams {
  return {
    sourceChain: req.from.caip2,
    // An imported source (D39): its contract and the decimals read on-chain, as in a live quote.
    ...sourceParams(req.from),
    destChain: req.to.caip2,
    destToken: destTokenId(req.to),
    amountIn: req.amountIn.toString(),
    slippageBps: req.slippageBps,
    destAddress: req.recipient ?? "",
    ...(req.refundAddress ? {refundAddress: req.refundAddress} : {}),
    dry: true,
  };
}

/**
 * Why `provider` sits out this preview round (a refusal in the router's "<provider>: …" form), or null to ask it.
 * `viaProxy(provider)`: cp0x's proxy carries it with cp0x's key right now (config proxyVenueLive), asked per round;
 * none = never (a page without Standard, tests).
 */
export function previewSkip(provider: string, req: PreviewRequest, viaProxy: (provider: string) => boolean = () => false): string | null {
  if (!PREVIEW_VENUES.has(provider)) return `${provider}: ${LIVE_ONLY_REFUSAL}`;
  if (KEYED_PREVIEW_VENUES.has(provider) && !viaProxy(provider)) return `${provider}: ${KEYED_ONLY_REFUSAL}`;
  if (req.toOther && SIGNER_ONLY.has(provider)) return `${provider}: ${SIGNER_ONLY_REFUSAL} (it pays only the wallet that signs)`;
  return null;
}

/** What one venue's preview quote changes on the round's params: a blank destination filled where it must be. */
export function previewAddressing(provider: string, req: PreviewRequest): Partial<QuoteParams> {
  if (req.recipient) return {};
  const fills = FILLS_DESTINATION.has(provider) || (FILLS_OTHER_FAMILY.has(provider) && req.from.family !== req.to.family && req.to.family !== "solana");
  if (!fills) return {};
  const sample = PREVIEW_PLACEHOLDER[req.to.family];
  return sample ? {destAddress: sample} : {};
}
