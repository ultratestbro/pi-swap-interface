/**
 * The execute port (contracts/ports.ts ExecutePort) — the only way the screens reach a signature. The claim also
 * moves the record on (mobile status.tsx): the claim hash, the new id to poll, pending again; a claim handed over
 * with no definitive answer is tracked as sent and never re-sent from here.
 */
import type {CancelResult, ClaimResult, SourceSigner} from "../contracts/execution";
import type {ExecutePort} from "../contracts/ports";
import {findSwap, getSwaps, updateSwap} from "../activity";
import {cancelOrder, previewCancel} from "./cancel";
import {claimSwap, previewClaim} from "./claim";
import {issueDeposit} from "./deposit";
import {decodeSwapId} from "./ids";
import {startSwap} from "./runner";
import {refusal} from "./errors";

async function claimAndRecord(id: string, signer: SourceSigner): Promise<ClaimResult> {
  try {
    const res = await claimSwap(id, signer);
    const r = findSwap(getSwaps(), id);
    if (r) updateSwap(r.id, (x) => ({...x, claimHash: res.hash, trackId: res.id, status: "pending", updatedAt: Date.now()}));
    return res;
  } catch (e) {
    const unsure = e as {maybeSent?: unknown; hash?: unknown} | null;
    const r = findSwap(getSwaps(), id);
    if (r && unsure?.maybeSent === true)
      updateSwap(r.id, (x) => ({
        ...x,
        ...(typeof unsure.hash === "string" && unsure.hash ? {claimHash: unsure.hash} : {}),
        status: "pending",
        maybeSent: true,
        updatedAt: Date.now(),
      }));
    throw e;
  }
}

/**
 * A CoW order's cancellation (D49) moves the record on: off-chain, when the orderbook took it (the order may still
 * fill — tracking settles it); on-chain, its hash. A cancellation handed over with no definitive answer keeps its
 * hash when there is one and is never re-sent from here.
 */
async function cancelAndRecord(id: string, signer: SourceSigner): Promise<CancelResult> {
  try {
    const res = await cancelOrder(id, signer);
    const r = findSwap(getSwaps(), id);
    if (r)
      updateSwap(r.id, (x) => ({
        ...x,
        ...(res.mode === "onchain" ? {cancelHash: res.hash} : {cancelRequestedAt: Date.now()}),
        updatedAt: Date.now(),
      }));
    return res;
  } catch (e) {
    const unsure = e as {maybeSent?: unknown; hash?: unknown} | null;
    const r = findSwap(getSwaps(), id);
    // An on-chain cancel (eth-flow) the wallet may have broadcast: record it so the page never offers a second one
    // (it would revert, gas only). Off-chain, registerCancel never ran — asking again is safe.
    const onchain = decodeSwapId(id)?.intentId.startsWith("e:") === true;
    if (r && unsure?.maybeSent === true && onchain)
      updateSwap(r.id, (x) => ({
        ...x,
        ...(typeof unsure.hash === "string" && unsure.hash ? {cancelHash: unsure.hash} : {cancelRequestedAt: Date.now()}),
        updatedAt: Date.now(),
      }));
    throw e;
  }
}

/** The real execute port (App picks it unless demo mode is on). */
export const executePort: ExecutePort = {
  startSwap: (input) => startSwap(input),
  issueDeposit: (input) => issueDeposit(input),
  previewClaim: (id) => previewClaim(id),
  claimSwap: claimAndRecord,
  previewCancel: (id, owner) => previewCancel(id, owner),
  cancelOrder: cancelAndRecord,
  revoke: async (input, signer) => {
    if (signer.family !== "evm") throw refusal("Approvals are revoked from an EVM wallet — nothing was sent.");
    // With the approvals SDK, loaded only when the Approvals section revokes something.
    const {sendRevoke} = await import("./accounts/revoke");
    return sendRevoke(signer, input);
  },
};
