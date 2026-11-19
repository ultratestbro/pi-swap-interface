/**
 * A confirmed swap runs here, not in the review sheet, so the user can close the sheet while approvals are mined
 * (mobile lib/swap/runner.ts, ui-port.md §4.9 — same contract, no Activity feed of its own). The record is created
 * as `submitting` the moment the engine starts its first step (the live route held to the review), follows each
 * step, and becomes the tracked swap once broadcast — or `not-sent` with the reason when it stops before that.
 *
 * `startSwap` resolves with the record's id once that first step starts, and rejects when execution fails before
 * it (the wallet refused to switch, the route moved under the review): the review sheet shows those itself. A
 * maybe-sent broadcast becomes a tracked record that is never retried.
 */
import type {Hex} from "viem";
import type {ExecStage, SwapRecord} from "../contracts/activity";
import type {EvmSourceSigner, ExecutionPhase, ExecutionPhaseDetail, StartSwapInput, TronSourceSigner} from "../contracts/execution";
import {newRecord, recordSide, replaceSwap, saveSwap, setRunning, updateSwap, getSwaps, findSwap} from "../activity";
import {reportRefused} from "../activity/counter";
import {chainByCaip2Web, tronPost} from "../catalog";
import {usdOf} from "../swap/amount";
import {PERMIT2_VENUES} from "../swap/providerMeta";
import {executeSwap, type ExecuteDeps} from "./execute";
import {maybeSent, refusalReport, swapErrorText, swapFailureExpected} from "./errors";
import {decodeSwapId, encodeSwapId} from "./ids";

/** The native coin's symbol for error texts ("Not enough ETH…"). */
export const nativeSymbolOf = (caip2: string): string => chainByCaip2Web(caip2)?.native.symbol ?? "the native coin";

let seq = 0;
/** `local.<ms>` — unique even for two Confirms in the same millisecond. */
const localIdNow = () => {
  const now = Date.now();
  seq = (seq + 1) % 1000;
  return `local.${now}${seq ? `-${seq}` : ""}`;
};

/** Run the reviewed swap; resolves with the record id at the engine's first step (or the swap id if it had none). */
export function startSwap(input: StartSwapInput, deps: ExecuteDeps = {}): Promise<string> {
  const {from, to, reviewed, expectedOut, signer} = input;
  const localId = localIdNow();
  const accountId = `${signer.family}:${reviewed.refundAddress}`;
  const usdIn = usdOf(reviewed.amountIn, from.decimals, from.priceUsd);
  const base = {
    accountId,
    provider: reviewed.provider,
    ...(reviewed.routeId !== undefined ? {routeId: reviewed.routeId} : {}),
    from: recordSide(from),
    to: recordSide(to),
    amountIn: reviewed.amountIn,
    expectedOut,
    minOut: reviewed.minOut,
    recipient: reviewed.recipient,
    mode: "wallet" as const,
    // For the swap report (D41): its value by the page's prices and its slippage.
    ...(usdIn !== undefined ? {usdIn} : {}),
    slippageBps: reviewed.slippageBps,
  };
  let started = false;
  // A Permit2 venue's token sale (0x, D38; the gate takes a permit from nothing else) signs its one-time Permit2
  // transfer before any approval: the engine's first `signing`, and the first after a re-quote (a new quote, a new
  // permit), is that permit — off-chain, nothing sent yet — and every later one the swap's own.
  const permit = PERMIT2_VENUES.has(reviewed.provider) && reviewed.fromContract !== null;
  let last: ExecStage | undefined;

  return new Promise<string>((resolve, reject) => {
    const step = (phase: ExecutionPhase, detail?: ExecutionPhaseDetail) => {
      const stage: ExecStage = permit && phase === "signing" && (last === undefined || last === "requoting") ? "permit" : phase;
      last = stage;
      const total = stage === "approving" ? detail?.total : undefined;
      // The engine names the wallet's hash the moment it broadcasts. Kept at once: a tab that dies while the engine
      // still notifies the venue leaves a record with its source transaction, never "nothing was swapped".
      const hash = stage === "broadcast" && detail?.hash ? {sourceHash: detail.hash} : {};
      if (!started) {
        started = true;
        setRunning(localId, true);
        const now = Date.now();
        const record: SwapRecord = {
          ...newRecord({...base, id: localId}, now),
          status: "submitting",
          stage,
          approvals: total ?? (reviewed.approvalSpender ? 1 : 0),
          ...(permit ? {permit: true} : {}),
          localId,
          heartbeatAt: now,
          ...hash,
        };
        saveSwap(record);
        resolve(localId);
        return;
      }
      updateSwap(localId, (r) => ({
        ...r,
        stage,
        ...(total !== undefined ? {approvals: total} : {}),
        ...hash,
        // Past `approving` the allowance is in place (the engine re-quotes or signs next).
        approved: r.approved === true || (r.stage === "approving" && stage !== "approving"),
        updatedAt: Date.now(),
      }));
    };

    executeSwap(
      {from, to, reviewed, signer, onPhase: step},
      deps,
    )
      .then((res) => {
        const record: SwapRecord = {...newRecord({...base, id: res.id, ...(res.hash ? {hash: res.hash} : {})}), localId};
        if (started) replaceSwap(localId, record);
        else saveSwap(record);
        if (!started) resolve(res.id);
        if (res.hash && signer.family === "evm") void watchSourceTx(signer, res.id, res.hash);
        if (res.hash && signer.family === "tron") void watchTronTx(signer, res.id, res.hash);
      })
      .catch((e: unknown) => {
        // A failure after the `broadcast` step (the hash is on the record) is never "not sent" either.
        const sentHash = started ? findSwap(getSwaps(), localId)?.sourceHash : undefined;
        const maybe = maybeSent(e) ?? (sentHash ? {hash: sentHash} : null);
        if (maybe) {
          // The broadcast may be on its way: never offer a retry — track it.
          console.warn("swap broadcast unconfirmed (maybe sent)", {provider: reviewed.provider});
          const id = maybe.id ?? localId;
          const record: SwapRecord = {...newRecord({...base, id, ...(maybe.hash ? {hash: maybe.hash} : {}), maybeSent: true}), localId};
          if (started) replaceSwap(localId, record);
          else saveSwap(record);
          if (!started) resolve(id);
          return;
        }
        if (!swapFailureExpected(e)) console.warn("swap failed", {provider: reviewed.provider, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)});
        // A route the check refused, or the person declined, before anything was sent (D41).
        const refused = refusalReport(e);
        if (refused) reportRefused({venue: reviewed.provider, fromChain: from.caip2, toChain: to.caip2, ...refused});
        if (!started) {
          reject(e);
          return;
        }
        updateSwap(localId, (r) => ({...r, status: "not-sent", error: swapErrorText(e, nativeSymbolOf(from.caip2)), updatedAt: Date.now()}));
      })
      .finally(() => {
        setRunning(localId, false);
        if (started) input.onSettled?.();
      });
  });
}

/**
 * After an EVM swap is broadcast, follow its source transaction once (engine.md §8.2): a speed-up in the wallet
 * changes the hash, and venues that track by source hash (LI.FI) would not find the old one — the record moves to
 * the replacement's id. A cancelled / replaced or reverted transaction swapped nothing: the record says so.
 */
export function watchSourceTx(signer: Pick<EvmSourceSigner, "pub">, id: string, hash: string, timeoutMs = 30 * 60_000): Promise<void> {
  const ref = decodeSwapId(id);
  if (!ref) return Promise.resolve();
  const outcome: {reason: string | null; hash: string | null} = {reason: null, hash: null};
  return Promise.resolve()
    .then(() =>
      signer.pub.waitForTransactionReceipt({
        hash: hash as Hex,
        timeout: timeoutMs,
        onReplaced: (r) => {
          outcome.reason = r.reason;
          outcome.hash = r.transaction.hash;
        },
      }),
    )
    .then((receipt) => {
      const r = findSwap(getSwaps(), id);
      if (!r || r.id !== id) return;
      if (outcome.reason === "repriced" && outcome.hash && outcome.hash.toLowerCase() !== hash.toLowerCase()) {
        const nextId = encodeSwapId(ref.provider, ref.intentId, outcome.hash);
        replaceSwap(id, {...r, id: nextId, sourceHash: outcome.hash, updatedAt: Date.now()});
        if (receipt.status !== "success") updateSwap(nextId, (x) => notSwapped(x, "The swap transaction failed on-chain — nothing was swapped (only the network fee was paid)."));
        return;
      }
      if (outcome.reason === "cancelled" || outcome.reason === "replaced") {
        updateSwap(id, (x) => notSwapped(x, "The swap transaction was cancelled in your wallet — nothing was swapped."));
        return;
      }
      if (receipt.status !== "success") updateSwap(id, (x) => notSwapped(x, "The swap transaction failed on-chain — nothing was swapped (only the network fee was paid)."));
    })
    .catch(() => {
      // Not mined within the window, or the RPC failed: the venue's status keeps the record honest.
    });
}

/** How often, and for how long, a Tron source transaction's receipt is looked for (blocks are 3 s). */
export const TRON_RECEIPT_POLL_MS = 6_000;
export const TRON_RECEIPT_TIMEOUT_MS = 15 * 60_000;

/**
 * After a Tron swap is broadcast, read its receipt once it is in a block (`gettransactioninfobyid` on the runtime
 * Tron API): a TRC-20 transfer that ran out of energy or reverted moved nothing but its fee — the record says so.
 * No receipt in time, or the API failing, changes nothing: the venue's status keeps the record honest.
 */
export async function watchTronTx(
  signer: Pick<TronSourceSigner, "apiUrls">,
  id: string,
  txId: string,
  o: {pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>} = {},
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? TRON_RECEIPT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(o.pollMs ?? TRON_RECEIPT_POLL_MS);
    let info: {id?: unknown; blockNumber?: unknown; result?: unknown; receipt?: {result?: unknown}};
    try {
      info = await tronPost("/wallet/gettransactioninfobyid", {value: txId}, signer.apiUrls);
    } catch {
      continue;
    }
    if (info.id !== txId || typeof info.blockNumber !== "number") continue;
    const receipt = info.receipt?.result;
    if (info.result === "FAILED" || (receipt !== undefined && receipt !== "SUCCESS"))
      updateSwap(id, (x) => notSwapped(x, "The swap transaction failed on-chain — nothing was swapped (only the network fee was paid)."));
    return;
  }
}

const notSwapped = (r: SwapRecord, error: string): SwapRecord =>
  r.status === "pending" ? {...r, status: "not-sent", error, maybeSent: false, updatedAt: Date.now()} : r;
