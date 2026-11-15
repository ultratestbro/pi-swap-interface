import {describe, expect, it} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {evmToTron} from "@anywalletkit/protocol-swap2-symbiosis/config";
import type {Family} from "../../../src/contracts/domain";
import type {PreviewRequest, QuoteRequest, RouteSnapshot} from "../../../src/contracts/routes";
import {isAddressFor} from "../../../src/catalog";
import {createQuoteEngine, quoteParams, type PreviewProxy} from "../../../src/swap/engine";
import {createVenueBackoff} from "../../../src/swap/limiter";
import {
  FILLS_DESTINATION,
  FILLS_OTHER_FAMILY,
  KEYED_ONLY_REFUSAL,
  KEYED_PREVIEW_VENUES,
  PREVIEW_PLACEHOLDER,
  PREVIEW_VENUES,
  SAMPLE_STANDIN,
  canPreview,
  previewAddressing,
  previewBaseParams,
  previewSkip,
  scrubSamples,
} from "../../../src/swap/preview";
import {DEFAULT_ON_PROVIDERS, STANDARD_ONLY_PROVIDERS} from "../../../src/swap/providers";
import {classifyRefusal} from "../../../src/swap/refusals";
import {ME, USDC_ARB, USDC_BASE, USDC_ETH, USDT_ETH, request, token, venue, type FakeVenue, type VenueOptions} from "./fixtures";

const BTC = token({chain: "bitcoin", caip2: "bip122:000000000019d6689c085ae165831e93", chainName: "Bitcoin", symbol: "BTC", decimals: 8, family: "btc", owner: null, payMode: "deposit"});
const SOL = token({chain: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", chainName: "Solana", symbol: "SOL", decimals: 9, family: "solana", owner: null, payMode: "connect"});
/** LI.FI's own Solana placeholder for a dry quote, sender or recipient (protocol-swap2-lifi 0.8.3 chunk-G26GE46T.js:689). */
const LIFI_SOLANA_SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

/** cp0x's proxy as a preview round reads it: `live` per venue, switchable between rounds; the signals it marked. */
function proxyOver(live: Record<string, boolean> = {}, settled: Promise<void> = Promise.resolve()) {
  const marked: AbortSignal[] = [];
  const proxy: PreviewProxy & {state: Record<string, boolean>; marked: AbortSignal[]} = {
    state: {...live},
    marked,
    settled: () => settled,
    live: (v) => proxy.state[v] ?? false,
    keyedOnly: (s) => (marked.push(s), s),
  };
  return proxy;
}

const previewReq = (over: Partial<PreviewRequest> = {}): PreviewRequest => ({
  preview: true,
  from: {...USDC_ARB, owner: null, payMode: "connect"},
  to: {...USDC_BASE, owner: null},
  amountIn: 5_000_000n,
  slippageBps: 30,
  toOther: false,
  ...over,
});

/** A fake venue that records the params it was asked with. */
function seen(name: string, o: VenueOptions = {}): FakeVenue & {params: QuoteParams[]} {
  const v = venue(name, o);
  const params: QuoteParams[] = [];
  const getQuote = v.getQuote;
  return Object.assign(v, {params, getQuote: (p: QuoteParams, s?: AbortSignal) => (params.push(p), getQuote(p, s))});
}

describe("preview samples", () => {
  it("each is a valid address of its family (catalog isAddressFor), and NEAR has none", () => {
    for (const [family, address] of Object.entries(PREVIEW_PLACEHOLDER)) expect(isAddressFor(family as Family, address!), family).toBe(true);
    expect(Object.keys(PREVIEW_PLACEHOLDER).sort()).toEqual(["btc", "evm", "solana", "ton", "tron", "zcash"]);
    expect(canPreview("evm", "btc")).toBe(true);
    expect(canPreview("btc", "solana")).toBe(true);
    expect(canPreview("evm", "near")).toBe(false);
    expect(canPreview("near", "evm")).toBe(false);
  });
});

describe("preview params (D7: placeholders only inside the engine's preview round)", () => {
  it("the round's params: the real addresses or blank, the refund absent rather than '', dry", () => {
    const p = previewBaseParams(previewReq());
    expect(p).toEqual({sourceChain: "eip155:42161", sourceToken: "USDC", destChain: "eip155:8453", destToken: USDC_BASE.contract, amountIn: "5000000", slippageBps: 30, destAddress: "", dry: true});
    expect("refundAddress" in p).toBe(false);
    expect(previewBaseParams(previewReq({recipient: ME, refundAddress: ME}))).toMatchObject({destAddress: ME, refundAddress: ME});
  });

  it("a blank destination is filled with the destination family's sample only where the venue can't quote without one", () => {
    expect([...FILLS_DESTINATION].sort()).toEqual(["balancer", "chainflip", "curve", "fynd", "near_intents", "thorchain", "uniswap"]);
    for (const p of FILLS_DESTINATION) expect(previewAddressing(p, previewReq())).toEqual({destAddress: PREVIEW_PLACEHOLDER.evm});
    expect(previewAddressing("thorchain", previewReq({to: BTC}))).toEqual({destAddress: PREVIEW_PLACEHOLDER.btc});
    // Relay flags a blank-address quote as a placeholder itself and never issues it: a value here would bypass that.
    // Symbiosis fills its own (both sides); Omniston's RFQ carries no address at all.
    for (const p of ["relay", "usdt0", "cctp", "wrap", "jupiter", "symbiosis", "omniston"]) expect(previewAddressing(p, previewReq())).toEqual({});
    // A real recipient is never replaced.
    expect(previewAddressing("uniswap", previewReq({recipient: ME}))).toEqual({});
    expect(previewAddressing("balancer", previewReq({recipient: ME}))).toEqual({});
    expect(previewAddressing("fynd", previewReq({recipient: ME}))).toEqual({});
  });

  it("Fynd (same-network EVM) gets the EVM sample: it refuses a blank recipient, and the sample is its sender too", () => {
    // protocol-swap2-fynd 0.2.12 chunk-6AQCGGUZ.js:168 refuses a non-EVM recipient; :170 sender = an EVM refund, else the
    // recipient. Its native-input simulation gives that sender the input plus 1 ETH by state override (:230-232).
    const same = previewReq({from: {...USDC_ETH, owner: null, payMode: "connect"}, to: {...USDT_ETH, owner: null}});
    expect(previewAddressing("fynd", same)).toEqual({destAddress: PREVIEW_PLACEHOLDER.evm});
    // A connected payer (another address still to type): the payer stays the sender, the sample only the recipient.
    expect(previewAddressing("fynd", {...same, refundAddress: ME, toOther: true})).toEqual({destAddress: PREVIEW_PLACEHOLDER.evm});
  });

  it("LI.FI keeps its own handling where the families match or the destination is Solana, and gets the EVM sample from Solana", () => {
    // chunk-G26GE46T.js:961-962: a blank destination becomes the SENDER's placeholder (its EVM one = our EVM sample,
    // its Solana one for a Solana source) — right for EVM → EVM and Solana → Solana, an EVM chain paid to a Solana
    // address for Solana → EVM. EVM → Solana: its own Solana placeholder (dryRecipient, :789), priced without a
    // transaction, so a sample of ours would only put a stand-in where LI.FI already has one.
    expect([...FILLS_OTHER_FAMILY]).toEqual(["lifi"]);
    expect(previewAddressing("lifi", previewReq())).toEqual({});
    expect(previewAddressing("lifi", previewReq({from: SOL, to: {...SOL, symbol: "USDC"}}))).toEqual({});
    expect(previewAddressing("lifi", previewReq({from: SOL}))).toEqual({destAddress: PREVIEW_PLACEHOLDER.evm});
    expect(previewAddressing("lifi", previewReq({from: SOL, recipient: ME}))).toEqual({});
    expect(previewAddressing("lifi", previewReq({to: SOL}))).toEqual({});
    expect(previewAddressing("lifi", previewReq({to: SOL, refundAddress: ME}))).toEqual({});
  });

  it("every venue the page builds is decided for previews: Symbiosis, Balancer and Omniston are asked (2026-11-12)", () => {
    expect([...PREVIEW_VENUES].sort()).toEqual([...DEFAULT_ON_PROVIDERS, ...STANDARD_ONLY_PROVIDERS].sort());
    for (const p of [...FILLS_DESTINATION, ...FILLS_OTHER_FAMILY, ...KEYED_PREVIEW_VENUES]) expect(PREVIEW_VENUES.has(p)).toBe(true);
    for (const p of ["symbiosis", "balancer", "omniston"]) {
      expect(previewSkip(p, previewReq()), p).toBeNull();
      // None pays only the signer: "Send to another address" keeps them in.
      expect(previewSkip(p, previewReq({toOther: true})), p).toBeNull();
    }
    // A venue whose blank-address handling hasn't been read is never asked for a preview.
    expect(previewSkip("newvenue", previewReq(), () => true)).toBe("newvenue: asked only for your live quote, not for previews");
  });

  it("LI.FI and Fynd only while cp0x's proxy carries them, read on each call; signer-only venues sit out 'another address'", () => {
    expect([...KEYED_PREVIEW_VENUES].sort()).toEqual(["fynd", "lifi"]);
    // No proxy (Public, Custom, a build without the API, health anonymous or unreachable, a stopped slot): left for
    // the live quote.
    expect(previewSkip("lifi", previewReq())).toBe(`lifi: ${KEYED_ONLY_REFUSAL}`);
    expect(previewSkip("fynd", previewReq())).toBe(`fynd: ${KEYED_ONLY_REFUSAL}`);
    expect(previewSkip("lifi", previewReq(), () => false)).toBe(`lifi: ${KEYED_ONLY_REFUSAL}`);
    // Through the proxy with cp0x's key: asked, each venue by its own slot.
    expect(previewSkip("lifi", previewReq(), (p) => p === "lifi")).toBeNull();
    expect(previewSkip("fynd", previewReq(), (p) => p === "lifi")).toBe(`fynd: ${KEYED_ONLY_REFUSAL}`);
    expect(previewSkip("fynd", previewReq(), () => true)).toBeNull();
    // The proxy decides only for these two: every other venue is asked whatever it says.
    for (const p of ["curve", "relay", "jupiter", "near_intents", "symbiosis"]) expect(previewSkip(p, previewReq(), () => false), p).toBeNull();
    expect(previewSkip("jupiter", previewReq({toOther: true}))).toMatch(/recipient must be the signing wallet/);
    expect(previewSkip("wrap", previewReq({toOther: true}))).toMatch(/recipient must be the signing wallet/);
  });

  it("live entry points refuse a preview: quoteParams (re-quote, deposit) throws on its brand and on blank addresses", () => {
    expect(() => quoteParams(previewReq() as unknown as QuoteRequest)).toThrow(/preview/);
    expect(() => quoteParams(previewReq({recipient: ME, refundAddress: ME}) as unknown as QuoteRequest)).toThrow(/preview/);
    expect(() => quoteParams(request({recipient: ""}))).toThrow(/recipient and a refund address/);
  });
});

describe("engine preview round", () => {
  const engineOver = (providers: FakeVenue[], backoff = createVenueBackoff(), proxy?: PreviewProxy) =>
    createQuoteEngine({providers: () => providers, gasPrice: async () => null, backoff, ...(proxy ? {proxy} : {})});

  it("asks the preview venues as the table says, marks the snapshot preview, and without cp0x's proxy never sends LI.FI a request", async () => {
    const uniswap = seen("uniswap", {min: "4990000"});
    const relay = seen("relay", {min: "4980000"});
    const cctp = seen("cctp", {min: "4999000"});
    const near = seen("near_intents", {min: "4995000"});
    const lifi = seen("lifi", {min: "4999999"});
    const updates: RouteSnapshot[] = [];
    const final = await engineOver([uniswap, relay, cctp, near, lifi]).quoteRoutes({mode: "preview", req: previewReq()}, (s) => void updates.push(s));

    expect(updates[0]!.mode).toBe("preview");
    expect(final!.mode).toBe("preview");
    expect(final!.routes.map((r) => r.provider).sort()).toEqual(["cctp", "near_intents", "relay", "uniswap"]);
    expect(lifi.params).toEqual([]);
    expect(final!.rejections).toEqual([
      {
        provider: "lifi",
        reason: "Connect a wallet to get this quote",
        category: "deferred",
        detail: "Preview prices skip it here to save its request limit for your own quote — it's asked as soon as your wallet is connected or your address is entered.",
        raw: KEYED_ONLY_REFUSAL,
        skipped: true,
      },
    ]);
    expect(uniswap.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.evm, dry: true});
    expect(near.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.evm});
    for (const v of [relay, cctp]) expect(v.params[0]!.destAddress).toBe("");
    for (const v of [uniswap, relay, cctp, near]) expect("refundAddress" in v.params[0]!).toBe(false);
  });

  it("LI.FI and Fynd are asked while cp0x's proxy carries them, decided per round; their preview signal is marked keyed-only", async () => {
    const lifi = seen("lifi", {min: "4999999", sameChain: true});
    const fynd = seen("fynd", {min: "4999000", sameChain: true});
    const relay = seen("relay", {min: "4980000", sameChain: true});
    const proxy = proxyOver({lifi: true, fynd: true});
    const engine = engineOver([lifi, fynd, relay], createVenueBackoff(), proxy);
    const same = previewReq({from: {...USDC_ETH, owner: null, payMode: "connect"}, to: {...USDT_ETH, owner: null}});

    // Round 1 (same network, so Fynd serves it): both through the proxy. LI.FI's blank EVM → EVM destination is left
    // to its own handling; Fynd gets the EVM sample as its recipient (and so its sender). No refund key for either.
    const first = await engine.quoteRoutes({mode: "preview", req: same}, () => {});
    expect(first!.routes.map((r) => r.provider).sort()).toEqual(["fynd", "lifi", "relay"]);
    expect(lifi.params[0]).toMatchObject({destAddress: "", dry: true});
    expect(fynd.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.evm, dry: true});
    for (const v of [lifi, fynd]) expect("refundAddress" in v.params[0]!).toBe(false);
    // Only their calls are marked, each on a signal of its own: Relay's (anonymous at cp0x, asked direct) never is.
    expect(new Set(proxy.marked)).toEqual(new Set([lifi.signals[0], fynd.signals[0]]));
    expect(proxy.marked).not.toContain(relay.signals[0]);
    expect(lifi.signals[0]).not.toBe(fynd.signals[0]);

    // Round 2: LI.FI's slot stopped after a failure at cp0x (or its daily budget): left for the live quote, nothing
    // sent; Fynd, still carried, is asked.
    proxy.state.lifi = false;
    const second = await engine.quoteRoutes({mode: "preview", req: same}, () => {});
    expect(lifi.params).toHaveLength(1);
    expect(fynd.params).toHaveLength(2);
    expect(second!.rejections).toEqual([expect.objectContaining({provider: "lifi", category: "deferred", reason: "Connect a wallet to get this quote", skipped: true})]);

    // Round 3: carried again (a Retry-After ran out, 00:00 UTC): asked again.
    proxy.state.lifi = true;
    await engine.quoteRoutes({mode: "preview", req: same}, () => {});
    expect(lifi.params).toHaveLength(2);
  });

  it("a preview round waits for cp0x's health answer before it decides; a live round neither waits nor marks anything", async () => {
    let answer!: () => void;
    const health = new Promise<void>((r) => (answer = r));
    const lifi = seen("lifi", {min: "4999999"});
    const proxy = proxyOver({}, health);
    const engine = engineOver([lifi], createVenueBackoff(), proxy);
    const round = engine.quoteRoutes({mode: "preview", req: previewReq()}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(lifi.params).toEqual([]);
    // Health lands with LI.FI keyed: this same round asks it.
    proxy.state.lifi = true;
    answer();
    expect((await round)!.routes.map((r) => r.provider)).toEqual(["lifi"]);
    expect(lifi.params).toHaveLength(1);

    // A live round asks LI.FI as before (its routing decides proxy or direct per request), unmarked.
    proxy.state.lifi = false;
    const marked = proxy.marked.length;
    const live = await engine.quoteRoutes({mode: "live", req: request()}, () => {});
    expect(live!.routes.map((r) => r.provider)).toEqual(["lifi"]);
    expect(proxy.marked).toHaveLength(marked);
  });

  it("Balancer gets the EVM sample; Symbiosis and Omniston keep the blank destination and no refund", async () => {
    const balancer = seen("balancer", {min: "4990000"});
    const symbiosis = seen("symbiosis", {min: "4985000"});
    const omniston = seen("omniston", {min: "4995000"});
    const final = await engineOver([balancer, symbiosis, omniston]).quoteRoutes({mode: "preview", req: previewReq()}, () => {});
    expect(final!.routes.map((r) => r.provider).sort()).toEqual(["balancer", "omniston", "symbiosis"]);
    expect(final!.rejections).toEqual([]);
    expect(balancer.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.evm, dry: true});
    for (const v of [symbiosis, omniston]) expect(v.params[0]).toMatchObject({destAddress: "", dry: true});
    for (const v of [balancer, symbiosis, omniston]) expect("refundAddress" in v.params[0]!).toBe(false);
  });

  it("a Symbiosis text that repeats its own Tron placeholder shows the stand-in", async () => {
    // chunk-K3EPNDVO.js:33/213: its EVM placeholder (= the EVM sample) in Tron form, sent as `to` for a blank one.
    const tron = evmToTron(PREVIEW_PLACEHOLDER.evm!);
    const symbiosis = seen("symbiosis", {refuse: `symbiosis: Symbiosis: the receiver ${tron} cannot receive this token`});
    const final = await engineOver([symbiosis]).quoteRoutes({mode: "preview", req: previewReq()}, () => {});
    expect(JSON.stringify(final!.rejections)).not.toContain(tron);
    expect(final!.rejections[0]!.raw).toContain(SAMPLE_STANDIN);
  });

  it("keeps the user's real addresses where it has them", async () => {
    const uniswap = seen("uniswap", {min: "1"});
    const relay = seen("relay", {min: "1"});
    await engineOver([uniswap, relay]).quoteRoutes({mode: "preview", req: previewReq({refundAddress: ME})}, () => {});
    expect(relay.params[0]).toMatchObject({destAddress: "", refundAddress: ME});
    expect(uniswap.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.evm, refundAddress: ME});
  });

  it("with 'another address' on, Jupiter and Wrap sit out as they would live", async () => {
    const jupiter = seen("jupiter", {min: "1", sameChain: true});
    const final = await engineOver([jupiter]).quoteRoutes({mode: "preview", req: previewReq({to: {...USDC_ARB, owner: null}, toOther: true})}, () => {});
    expect(jupiter.params).toEqual([]);
    expect(final!.rejections[0]).toMatchObject({provider: "jupiter", reason: "Pays only the wallet that signs", category: "setup", skipped: true});
  });

  it("a live round is unchanged: the user's addresses, mode live", async () => {
    const relay = seen("relay", {min: "1"});
    const final = await engineOver([relay]).quoteRoutes({mode: "live", req: request()}, () => {});
    expect(final!.mode).toBe("live");
    expect(relay.params[0]).toMatchObject({destAddress: ME, refundAddress: ME});
  });

  it("a venue's text that repeats the sample shows the stand-in: THORChain's memo check stays a safety skip", async () => {
    // protocol-swap2-thorchain 0.4.3 chunk-EIAXGWNG.js:793: `thorchain: memo failed verification (${String(q.memo).slice(0, 80)})`.
    const memo = `=:BTC.BTC:${PREVIEW_PLACEHOLDER.btc}:27000/1/0:cp0x:0`;
    const thorchain = seen("thorchain", {refuse: `thorchain: memo failed verification (${memo.slice(0, 80)})`});
    const final = await engineOver([thorchain]).quoteRoutes({mode: "preview", req: previewReq({to: BTC})}, () => {});
    expect(thorchain.params[0]).toMatchObject({destAddress: PREVIEW_PLACEHOLDER.btc});
    const row = final!.rejections[0]!;
    expect(row).toMatchObject({provider: "thorchain", category: "safety", reason: "Can't confirm it pays you"});
    expect(row.raw).toBe(`memo failed verification (=:BTC.BTC:${SAMPLE_STANDIN}:27000/1/0:cp0x:0)`);
    expect(row.skipped).toBeUndefined();
    expect(JSON.stringify(final!.rejections)).not.toContain(PREVIEW_PLACEHOLDER.btc);
  });

  it("a live round's texts are left as the venue wrote them", async () => {
    const relay = seen("relay", {refuse: `relay: the transaction does not match the quote: pays ${PREVIEW_PLACEHOLDER.evm}, not ${ME}`});
    const final = await engineOver([relay]).quoteRoutes({mode: "live", req: request()}, () => {});
    expect(final!.rejections[0]!.raw).toContain(PREVIEW_PLACEHOLDER.evm);
  });
});

describe("scrubSamples", () => {
  it("replaces every family's sample, EVM in any case and inside calldata", () => {
    for (const sample of Object.values(PREVIEW_PLACEHOLDER)) expect(scrubSamples(`to ${sample}.`)).toBe(`to ${SAMPLE_STANDIN}.`);
    expect(scrubSamples(`pays ${PREVIEW_PLACEHOLDER.evm!.toLowerCase()}, not 0x1111`)).toBe(`pays ${SAMPLE_STANDIN}, not 0x1111`);
    const word = `000000000000000000000000${PREVIEW_PLACEHOLDER.evm!.slice(2).toLowerCase()}`;
    expect(scrubSamples(`calldata is 0xa9059cbb${word}`)).toBe(`calldata is 0xa9059cbb000000000000000000000000${SAMPLE_STANDIN}`);
    expect(scrubSamples("nothing to replace")).toBe("nothing to replace");
  });

  it("replaces the placeholders Symbiosis fills in itself: its TON one and the EVM sample in Tron form", () => {
    const tron = evmToTron(PREVIEW_PLACEHOLDER.evm!);
    expect(tron).toBe("TVjpchRyV9wdpj6kmwqVsBDWY1J8PaFtnb");
    expect(scrubSamples(`to ${tron}.`)).toBe(`to ${SAMPLE_STANDIN}.`);
    expect(scrubSamples("to EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N.")).toBe(`to ${SAMPLE_STANDIN}.`);
    expect(scrubSamples(`to ${tron}.`, [tron])).toBe(`to ${tron}.`);
  });

  it("replaces LI.FI's own Solana sender (its checks and API messages can name it) and its EVM one, the EVM sample", () => {
    // protocol-swap2-lifi 0.8.3 chunk-G26GE46T.js:615: "the Solana transaction is paid by …, not the sender <its Solana placeholder>".
    expect(scrubSamples(`the Solana transaction is paid by 11111111111111111111111111111111, not the sender ${LIFI_SOLANA_SENDER}`)).toBe(
      `the Solana transaction is paid by 11111111111111111111111111111111, not the sender ${SAMPLE_STANDIN}`,
    );
    // chunk-G26GE46T.js:544: "pays …, not <receiver>" with LI.FI's EVM placeholder (= the EVM sample) as the receiver.
    expect(scrubSamples("pays 0x1111111111111111111111111111111111111111, not 0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(
      `pays 0x1111111111111111111111111111111111111111, not ${SAMPLE_STANDIN}`,
    );
    expect(scrubSamples(`paid by ${LIFI_SOLANA_SENDER}`, [LIFI_SOLANA_SENDER])).toBe(`paid by ${LIFI_SOLANA_SENDER}`);
  });

  it("keeps the user's own address even when it equals a sample", () => {
    const text = `refund ${PREVIEW_PLACEHOLDER.evm} to ${PREVIEW_PLACEHOLDER.btc}`;
    expect(scrubSamples(text, [PREVIEW_PLACEHOLDER.evm!.toLowerCase(), undefined])).toBe(`refund ${PREVIEW_PLACEHOLDER.evm} to ${SAMPLE_STANDIN}`);
  });

  it("the refusal table reads a scrubbed text as it reads the original (the stand-in has no space, for `\\S+`)", () => {
    const read = (text: string) => {
      const {reason, category, detail} = classifyRefusal("x", text);
      return {reason, category, detail};
    };
    for (const [raw, category] of [
      [`the transaction does not match the quote: pays ${PREVIEW_PLACEHOLDER.evm}, not ${ME}`, "safety"],
      [`memo failed verification (=:BTC.BTC:${PREVIEW_PLACEHOLDER.btc}:1/1/0)`, "safety"],
      [`the approval targets ${PREVIEW_PLACEHOLDER.evm}, not the pinned router`, "safety"],
      [`moves ${PREVIEW_PLACEHOLDER.tron}, not the quoted token`, "safety"],
      [`1Click 400: recipient ${PREVIEW_PLACEHOLDER.solana} is not valid`, "other"],
    ] as const) {
      expect(read(raw).category, raw).toBe(category);
      expect(read(scrubSamples(raw)), raw).toEqual(read(raw));
    }
  });
});

describe("venue back-off (D29)", () => {
  it("a venue that answers with a rate limit sits out until its named wait is over, then is asked again", async () => {
    let t = 1_000_000;
    const backoff = createVenueBackoff(() => t);
    const limited = seen("relay", {refuse: "Too many requests, retry in 2 minutes"});
    const engine = createQuoteEngine({providers: () => [limited], gasPrice: async () => null, backoff});
    await engine.quoteRoutes({mode: "live", req: request()}, () => {});
    expect(limited.params).toHaveLength(1);
    const second = await engine.quoteRoutes({mode: "preview", req: previewReq()}, () => {});
    expect(limited.params).toHaveLength(1);
    expect(second!.rejections[0]).toMatchObject({provider: "relay", category: "busy", reason: "Request limit hit — back in about 2 minutes", skipped: true});
    t += 2 * 60_000 + 1;
    await engine.quoteRoutes({mode: "live", req: request()}, () => {});
    expect(limited.params).toHaveLength(2);
  });

  it("without a named wait: 60 s, doubling per repeat up to 15 min; a quote clears it; a named wait is capped at 3 h", () => {
    let t = 0;
    const b = createVenueBackoff(() => t);
    b.limited("jupiter", "jupiter: HTTP 429");
    expect(b.refusal("jupiter")).toBe("jupiter: rate limit exceeded, retry in ~1 min");
    t = 60_001;
    expect(b.refusal("jupiter")).toBeNull();
    b.limited("jupiter", "jupiter: HTTP 429");
    expect(b.refusal("jupiter")).toBe("jupiter: rate limit exceeded, retry in ~2 min");
    for (let i = 0; i < 10; i++) b.limited("jupiter", "jupiter: HTTP 429");
    expect(b.refusal("jupiter")).toBe("jupiter: rate limit exceeded, retry in ~15 min");
    b.quoted("jupiter");
    expect(b.refusal("jupiter")).toBeNull();
    b.limited("lifi", "lifi: Rate limit exceeded, retry in 9 hours");
    expect(b.refusal("lifi")).toBe("lifi: rate limit exceeded, retry in ~180 min");
  });

  it("reads the wait the list reads: 'retry after' as well as 'retry in'", () => {
    const b = createVenueBackoff(() => 0);
    b.limited("x", "x: too many requests, retry after 2 hours");
    expect(b.refusal("x")).toBe("x: rate limit exceeded, retry in ~120 min");
    expect(classifyRefusal("x", "too many requests, retry after 2 hours").reason).toBe("Request limit hit — back in about 2 hours");
  });
});
