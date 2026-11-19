/**
 * The review → sign handshake (engine.md §7, ARCHITECTURE.md D10) — mobile
 * lib/swap/gate.ts (756b115) as ONE instance per execution instead of a
 * module singleton.
 *
 *   1. The review shows one route. After Confirm the engine fetches the live
 *      quote and hands its exact plan to `reviewExecution` before any
 *      approval or signature. `checkPlanBrowser` refuses a plan that is not
 *      the reviewed route; `planWrites` turns an accepted plan into the exact
 *      writes it will make, and only those are armed on this execution's gate.
 *   2. Every write the engine asks the account for must CONSUME one armed
 *      write (same method, target, calldata, value / amount) before anything
 *      reaches the wallet. A write nothing armed disarms the rest.
 *   3. The only standing permission is revoking an allowance THIS execution
 *      granted (approve(spender, 0)), the engine's cleanup after a failure.
 *   4. A Permit2 signature transfer (0x, D38) arms exactly two more: the
 *      signature of the plan's own rebuilt PermitTransferFrom (domain, types,
 *      message, all of it), and the swap call carrying exactly the signature
 *      the wallet returned for it (`data ++ uint256(len) ++ sig`) — nothing
 *      else typed is signed, and the call matches no other appended bytes.
 *
 * Pure (viem's ABI codec, and the catalog's address checks for TON) — unit-tested in tests/unit/execute/gate.test.ts.
 */
import {decodeFunctionData, encodeFunctionData, erc20Abi} from "viem";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {PERMIT2_ADDRESS, PERMIT2_TRANSFER_TYPES, appendPermit2Signature} from "@anywalletkit/protocol-swap2-core/util";
import type {ChainFamily} from "../contracts/domain";
import type {ReviewedSwap} from "../contracts/execution";
import {checkTonPlan, type TonBodyCheck} from "./tonPlan";

/** How a Tron memo becomes `raw_data.data` bytes: utf8 text (the default) or a 0x-hex binary note (Chainflip). */
export type MemoEncoding = "utf8" | "hex";

/** One write the reviewed plan makes, in the shape the engine hands the account. */
export type ArmedWrite =
  /**
   * sendTransaction: an EVM call / deposit, a native deposit elsewhere. `body` = TON text comment, `bodyBoc` = TON cell
   * body, `memo` = Tron / NEAR memo. `permit2Signed`: `data` is the swap's calldata BEFORE its Permit2 signature; the
   * call matches only with exactly the signature this execution's armed permit got from the wallet appended (D38).
   */
  | {kind: "call"; to: string; data?: string; value: bigint; body?: string; bodyBoc?: string; memo?: string; memoEncoding?: MemoEncoding; permit2Signed?: true}
  /** transfer: a token deposit (SPL, jetton, TRC-20, NEP-141). */
  | {kind: "transfer"; token: string; recipient: string; amount: bigint; memo?: string; memoEncoding?: MemoEncoding}
  /** sendSerialized: a provider-built Solana transaction (the account's own guard simulates it). */
  | {kind: "serialized"; tx: string}
  /** signTypedData: a gasless order; the message as stable JSON. */
  | {kind: "typed"; message: string}
  /** signTypedData: a Permit2 PermitTransferFrom (swap2-core 0.13.0, D38); the WHOLE payload (domain, types, primaryType, message) as stable JSON. */
  | {kind: "permit2"; typedData: string};

/** The engine account methods that write, as the gate names them. */
export type WriteMethod = "sendTransaction" | "transfer" | "sendSerialized" | "signTypedData";

/** One write the engine asked for: which chain the gate guards, which method, the engine's first argument. */
export interface WriteIntent {
  chain: string;
  method: WriteMethod;
  raw: unknown;
}

/**
 * Wallet prompts and mined approvals are human-paced in a browser (2-3 prompts), so the armed writes live
 * 15 minutes from each (re)arm — mobile's 5 minutes would expire under a user reading a prompt.
 */
export const ARM_TTL_MS = 15 * 60_000;

/** A write reached the account that the reviewed plan did not arm: refused before the wallet saw it. `answered`: nothing was sent. */
export class SwapGateRefusal extends Error {
  readonly answered = true;
  constructor(message = "A transaction didn't match the reviewed route — it was refused before signing.") {
    super(message);
    this.name = "SwapGateRefusal";
  }
}

/** The live plan is not the reviewed route (thrown from reviewExecution): nothing was signed. `message` = the reason. */
export class SwapReviewMismatch extends Error {
  readonly answered = true;
  constructor(message: string) {
    super(message);
    this.name = "SwapReviewMismatch";
  }
}

/** EVM hex compares case-insensitively; everything else (base58, base64, TON friendly) verbatim. */
export const same = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const toBig = (v: unknown): bigint | undefined => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return v === undefined ? 0n : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** JSON with sorted keys and bigints as strings — two typed-data messages compare by content, not key order. */
export function stableJson(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** `data ++ uint256(len) ++ signature`, or undefined when either isn't usable (the engine's own appendPermit2Signature). */
function signedCalldata(data: string | undefined, signature: string | undefined): string | undefined {
  if (data === undefined || signature === undefined) return undefined;
  try {
    return appendPermit2Signature(data, signature);
  } catch {
    return undefined;
  }
}

/**
 * Does the engine's write (`method`, first argument `raw`) equal the armed one? `permitSignature`: what the wallet
 * returned for this execution's armed Permit2 permit, the only bytes a `permit2Signed` call may carry after its data.
 * Exported for the tests.
 */
export function matches(w: ArmedWrite, method: string, raw: unknown, permitSignature?: string): boolean {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  switch (w.kind) {
    case "call": {
      if (method !== "sendTransaction") return false;
      const data = str(r.data);
      const want = w.permit2Signed ? signedCalldata(w.data, permitSignature) : w.data;
      if (w.permit2Signed && want === undefined) return false;
      return (
        same(str(r.to), w.to) &&
        (data === undefined ? want === undefined : want !== undefined && data.toLowerCase() === want.toLowerCase()) &&
        toBig(r.value) === w.value &&
        // A TON text comment and a cell body are not interchangeable; neither is a memo that wasn't reviewed.
        (typeof r.body === "string" || r.body === undefined ? str(r.body) === w.body : false) &&
        str(r.bodyBoc) === w.bodyBoc &&
        str(r.memo) === w.memo &&
        // The same memo as hex or as text puts different bytes on chain.
        str(r.memoEncoding) === w.memoEncoding
      );
    }
    case "transfer":
      return (
        method === "transfer" &&
        same(str(r.token), w.token) &&
        same(str(r.recipient), w.recipient) &&
        toBig(r.amount) === w.amount &&
        str(r.memo) === w.memo &&
        str(r.memoEncoding) === w.memoEncoding
      );
    case "serialized":
      return method === "sendSerialized" && raw === w.tx;
    case "typed":
      return method === "signTypedData" && stableJson(r.message) === w.message;
    case "permit2":
      return method === "signTypedData" && stableJson(raw) === w.typedData;
  }
}

/** approve(spender, amount) calldata — byte-identical to the engine's own approveData. */
export const approveData = (spender: string, amount: bigint): `0x${string}` =>
  encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount]});

/** The spender and amount of approve(spender, amount) calldata, or null for anything else. */
export function readApprove(data: unknown): {spender: string; amount: bigint} | null {
  if (typeof data !== "string" || !data.toLowerCase().startsWith("0x095ea7b3")) return null;
  try {
    const d = decodeFunctionData({abi: erc20Abi, data: data as `0x${string}`});
    if (d.functionName !== "approve") return null;
    const [spender, amount] = d.args;
    return {spender, amount};
  } catch {
    return null;
  }
}

/**
 * The exact writes an accepted plan makes, in order, plus the allowances it may revoke. `tonBodyBoc`: the cell
 * body the engine decoded for a TON contract call (the plan only says there is one) — the BoC checkTonPlan read (D35).
 */
export function planWrites(
  plan: Swap2ExecutionPlan,
  tonBodyBoc?: string,
): {writes: ArmedWrite[]; revokes: {token: string; spender: string}[]} {
  const writes: ArmedWrite[] = plan.approvals.map((a) => ({
    kind: "call" as const,
    to: a.token,
    data: approveData(a.spender, a.amount),
    value: 0n,
  }));
  const revokes = plan.approvals.map((a) => ({token: a.token, spender: a.spender}));
  const s = plan.source;
  const ton = plan.fromChain.startsWith("ton:");
  switch (s.kind) {
    case "call":
      if (s.cellBody && !tonBodyBoc) throw new SwapReviewMismatch("the TON deposit body is missing");
      // A Permit2 transfer (D38): its permit, exactly as the plan carries it, before the call that spends it.
      if (s.permit2Transfer !== undefined) {
        let td: unknown;
        try {
          td = JSON.parse(s.permit2Transfer);
        } catch {
          throw new SwapReviewMismatch("the Permit2 transfer to sign is malformed");
        }
        writes.push({kind: "permit2", typedData: stableJson(td)});
      }
      writes.push({
        kind: "call",
        to: s.to,
        ...(s.data !== undefined ? {data: s.data} : {}),
        value: s.value,
        ...(s.cellBody ? {bodyBoc: tonBodyBoc!} : s.memo !== undefined ? (ton ? {body: s.memo} : {memo: s.memo}) : {}),
        ...(s.memoEncoding !== undefined ? {memoEncoding: s.memoEncoding} : {}),
        ...(s.permit2Transfer !== undefined ? {permit2Signed: true as const} : {}),
      });
      break;
    case "token-transfer":
      writes.push({
        kind: "transfer",
        token: s.token,
        recipient: s.recipient,
        amount: s.amount,
        ...(s.memo !== undefined ? {memo: s.memo} : {}),
        ...(s.memoEncoding !== undefined ? {memoEncoding: s.memoEncoding} : {}),
      });
      break;
    case "serialized":
      writes.push({kind: "serialized", tx: s.serializedTx});
      break;
    case "typed-order": {
      let td: {message?: unknown};
      try {
        td = JSON.parse(s.typedData) as {message?: unknown};
      } catch {
        throw new SwapReviewMismatch("the order to sign is malformed");
      }
      writes.push({kind: "typed", message: stableJson(td.message)});
      break;
    }
  }
  return {writes, revokes};
}

/**
 * What the live quote is held to: the reviewed floor, asked with the reviewed slippage. Without the slippage a
 * venue falls back to its own default (NEAR Intents: 1 %), its live minimum lands under the floor a 0.5 % review
 * promised even at an unchanged price, and the swap is refused.
 */
export const executionConstraints = (r: Pick<ReviewedSwap, "minOut" | "slippageBps">) => ({
  minAmountOut: r.minOut,
  slippage: r.slippageBps / 10_000,
});

/**
 * The most nanoTON a TON cell-body deposit may attach as gas (0.5 TON): checkPlan's allowance (the mobile one), the
 * engine's `tonGasCeiling` (execute.ts), and tonGate.ts checkTonCall's cap on a contract call (D35).
 */
export const TON_BODY_GAS = 500_000_000n;

/** Why the live plan is not the reviewed route, or null (mobile checkPlan, verbatim). */
export function checkPlan(plan: Swap2ExecutionPlan, r: ReviewedSwap): string | null {
  if (plan.provider !== r.provider) return `the route moved to ${plan.provider}`;
  if (plan.fromChain !== r.fromChain || plan.destChain !== r.destChain || !same(plan.destToken, r.destToken))
    return "the networks or the token changed";
  if (!same(plan.recipient, r.recipient)) return "the recipient changed";
  if (!same(plan.refundAddress, r.refundAddress)) return "the refund address changed";
  if (plan.sourceAmount !== r.amountIn) return "the amount changed";
  if (plan.minDestAmount < r.minOut) return "the guaranteed output dropped below what you reviewed";
  for (const a of plan.approvals) {
    if (!r.fromContract || !same(a.token, r.fromContract)) return "an approval for another token";
    if (!r.approvalSpender || !same(a.spender, r.approvalSpender)) return "an approval for a spender you didn't review";
    if (a.amount !== r.amountIn && a.amount !== 0n) return "an approval for another amount";
  }
  const s = plan.source;
  // Bridge messaging fees move a little between quotes; twice the reviewed one is the ceiling.
  const extra = r.nativeFee * 2n;
  if (s.kind === "call") {
    const tonGas = plan.fromChain.startsWith("ton:") && s.cellBody ? TON_BODY_GAS : 0n;
    const ceiling = (r.fromContract ? 0n : r.amountIn) + extra + tonGas;
    if (s.value > ceiling) return "the transaction sends more than you reviewed";
  }
  if (s.kind === "token-transfer" && (!r.fromContract || !same(s.token, r.fromContract) || s.amount !== r.amountIn))
    return "the deposit is not the reviewed token or amount";
  return null;
}

/**
 * How a venue's EVM source may look, beyond checkPlan (engine.md §7.3, defence in depth):
 * - `pins`: the contracts its calldata may call and the spenders it may approve, from the provider package itself;
 *   such a venue always sends calldata, so a bare transfer is refused too. `permit2`: it may ask for a Permit2
 *   signature transfer (0x, D38) — held by permit2Problem to Permit2's own PermitTransferFrom for exactly this swap,
 *   its deadline no further than `maxSeconds` away (the package's own bound); a venue without it never gets one;
 * - `deposit`: it only pays a deposit address (NEAR Intents) — a bare value send or the engine's exact ERC-20
 *   `transfer(depositAddress, amountIn)`, never an approval or other calldata.
 */
export type VenueRule = {kind: "pins"; pins: Pick<RemotePins, "callTargets" | "spenders">; permit2?: {maxSeconds: number}} | {kind: "deposit"};

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const have = Object.keys(o);
  return have.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const UINT256_MAX = (1n << 256n) - 1n;
const decimalUint = (v: unknown): bigint | null => (typeof v === "string" && /^(?:0|[1-9]\d{0,77})$/.test(v) && BigInt(v) <= UINT256_MAX ? BigInt(v) : null);

/**
 * Why a plan's Permit2 signature transfer (swap2-core 0.13.0: `source.permit2Transfer`, 0x's Settler, D38) is not
 * exactly the one this reviewed swap may sign, or null. On top of the engine's own reader (`readPermit2Transfer`), the
 * gate holds it to: a venue whose rule takes one; a token sale of the reviewed token (never a native one), no native
 * value with it, calldata to spend it, approvals to canonical Permit2 only; and the payload itself to exactly
 * `{domain, types, primaryType, message}` with the Permit2 domain on the source chain (name "Permit2", that chain id,
 * the canonical contract), Permit2's PermitTransferFrom / TokenPermissions types and nothing else (no EIP712Domain,
 * no witness), the reviewed token and EXACTLY the reviewed input as `permitted`, the call's own target — a pinned
 * Settler (checkPlanBrowser) — as the spender, a uint256 nonce, and a deadline in the future and at most the venue's
 * `maxSeconds` away. No other typed data is ever armed for a Permit2 venue.
 */
export function permit2Problem(plan: Swap2ExecutionPlan, r: ReviewedSwap, venue: VenueRule | undefined, nowMs = Date.now()): string | null {
  const s = plan.source;
  if (s.kind !== "call" || s.permit2Transfer === undefined) return null;
  if (venue?.kind !== "pins" || !venue.permit2) return `a Permit2 signature from a venue the app doesn't take one from (${plan.provider})`;
  if (!r.fromContract) return "a Permit2 signature on a native-coin sale";
  if (s.value !== 0n) return "native coin sent along with a Permit2 transfer";
  if (s.data === undefined) return "a Permit2 signature without the swap that spends it";
  for (const a of plan.approvals) if (!same(a.spender, PERMIT2_ADDRESS)) return "an approval to something other than Permit2";
  const id = evmChainId(plan.fromChain);
  let td: unknown;
  try {
    td = JSON.parse(s.permit2Transfer);
  } catch {
    return "the Permit2 transfer to sign is malformed";
  }
  if (!plainObject(td) || !exactKeys(td, ["domain", "types", "primaryType", "message"])) return "the Permit2 transfer to sign is malformed";
  const {domain, types, primaryType, message} = td;
  if (!plainObject(domain) || !exactKeys(domain, ["name", "chainId", "verifyingContract"]) || domain.name !== "Permit2") return "a signature for another contract than Permit2";
  if (domain.chainId !== id) return "a Permit2 signature for another network";
  if (typeof domain.verifyingContract !== "string" || !same(domain.verifyingContract, PERMIT2_ADDRESS)) return "a signature for another contract than Permit2";
  if (primaryType !== "PermitTransferFrom" || stableJson(types) !== stableJson(PERMIT2_TRANSFER_TYPES)) return "a Permit2 signature of another kind than a one-time transfer";
  if (!plainObject(message) || !exactKeys(message, ["permitted", "spender", "nonce", "deadline"])) return "a Permit2 signature of another kind than a one-time transfer";
  const permitted = message.permitted;
  if (!plainObject(permitted) || !exactKeys(permitted, ["token", "amount"])) return "a Permit2 signature of another kind than a one-time transfer";
  if (typeof permitted.token !== "string" || !same(permitted.token, r.fromContract)) return "a Permit2 signature for another token";
  if (decimalUint(permitted.amount) !== r.amountIn) return "a Permit2 signature for another amount";
  if (typeof message.spender !== "string" || !same(message.spender, s.to)) return "a Permit2 signature for a spender you didn't review";
  if (decimalUint(message.nonce) === null) return "the Permit2 transfer to sign is malformed";
  const deadline = decimalUint(message.deadline);
  const now = BigInt(Math.floor(nowMs / 1000));
  if (deadline === null || deadline <= now) return "a Permit2 signature that has already expired";
  if (deadline > now + BigInt(venue.permit2.maxSeconds)) return "a Permit2 signature that stays valid too long";
  return null;
}

/**
 * How a venue's Tron source may look (a TronLink payment): a TRX send or a TRC-20 transfer, never calldata, to
 * - `deposit`: the per-quote deposit address the venue named (NEAR Intents 1Click), with no memo;
 * - `vault`: one of the venue's pinned contracts (Chainflip's Tron Vault, from its package), with the hex note its SDK
 *   decoded and held to the request (destination, refund, minimum price) before the quote existed.
 * A venue with no Tron rule is never paid from a Tron wallet.
 */
export type TronRule = {kind: "deposit"} | {kind: "vault"; to: readonly string[]; memo: MemoEncoding};

/** A base58check Tron address (T…, 0x41 version byte); the checksum itself is verified by the account that builds the payment. */
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * A Tron source beyond checkPlan: no approval, no calldata or TON body, exactly the reviewed amount, sent to the
 * venue's deposit address or pinned contract and never back to the payer, a memo only where the venue's rule names
 * one (in its encoding). Returns why it is refused, or null.
 */
function checkTronPlan(plan: Swap2ExecutionPlan, r: ReviewedSwap, rule: TronRule | undefined): string | null {
  if (!rule) return `a Tron payment to a venue the app has no Tron rule for (${plan.provider})`;
  if (plan.approvals.length) return "an approval on a network that has none";
  const s = plan.source;
  if (s.kind !== "call" && s.kind !== "token-transfer") return "a payload this network doesn't carry";
  if (s.kind === "call" && (s.cellBody || s.chainId !== undefined || s.gasLimit !== undefined)) return "a payload this network doesn't carry";
  // Native: the exact input, nothing on top (checkPlan allows a bridge fee there); a token source never sends TRX.
  if (s.kind === "call" && (r.fromContract || s.value !== r.amountIn)) return "the transaction sends more than you reviewed";
  const to = s.kind === "call" ? s.to : s.recipient;
  if (!TRON_ADDRESS.test(to)) return "a deposit address that isn't a Tron address";
  if (same(to, r.refundAddress)) return "a deposit to your own address";
  if (rule.kind === "vault" && !rule.to.some((x) => same(x, to))) return "a payment to a contract the app doesn't trust";
  const memo = s.memo;
  // A Vault payment without its note can't be tied to a swap: it would sit at the Vault, never swapped or refunded.
  if (rule.kind === "vault" && memo === undefined) return "a payment to the venue's vault without its note";
  if (memo === undefined) return s.memoEncoding === undefined ? null : "a memo encoding without a memo";
  if (rule.kind !== "vault") return "a memo the review didn't show";
  if ((s.memoEncoding ?? "utf8") !== rule.memo) return "a memo in another encoding";
  if (rule.memo === "hex" && !/^0x(?:[0-9a-fA-F]{2}){1,512}$/.test(memo)) return "a malformed memo";
  return null;
}

const evmChainId = (caip2: string): number | null => (caip2.startsWith("eip155:") ? Number(caip2.slice("eip155:".length)) : null);

/**
 * checkPlan plus the browser's own checks: the payload kind must suit the chain family, chain ids must be the
 * source chain's, on EVM the venue's rule applies (`venue` undefined = a venue the app has no rule for: its
 * calldata is refused, a plain send passes on checkPlan alone), on Tron its Tron rule (`tron` undefined: refused), on
 * TON checkTonPlan (`tonBody`: the TON chunk's reader of the cell body the engine was handed; without it a contract
 * call is refused), and on NEAR only a deposit venue's payment. Returns why it is refused, or null.
 */
export function checkPlanBrowser(plan: Swap2ExecutionPlan, r: ReviewedSwap, venue?: VenueRule, tron?: TronRule, tonBody?: TonBodyCheck): string | null {
  const base = checkPlan(plan, r);
  if (base) return base;
  // The venue's route the review showed (D47): CCTP's Standard for Fast (or back) is another delivery and fee.
  if (plan.routeId !== r.routeId) return `the route moved to ${plan.routeId ?? "the venue's default"} from ${r.routeId ?? "the venue's default"}`;
  const ns = plan.fromChain.split(":")[0];
  const s = plan.source;
  if (s.kind === "serialized" && ns !== "solana") return "a provider-built transaction on a network that doesn't take one";
  if (s.kind === "typed-order" && ns !== "eip155") return "an order signature on a network that doesn't take one";
  if (s.kind === "token-transfer" && ns === "eip155") return "an unexpected token transfer";
  if (s.kind === "call" && s.data !== undefined && ns !== "eip155") return "contract calldata on a network that doesn't take it";
  if (ns === "solana") {
    if (plan.approvals.length) return "an approval on a network that has none";
    if (s.kind === "call" && (s.memo !== undefined || s.cellBody)) return "a payload this network doesn't carry";
    if (s.kind === "token-transfer" && s.memo !== undefined) return "a memo the review didn't show";
  }
  if (ns === "tron") return checkTronPlan(plan, r, tron);
  if (ns === "ton") return checkTonPlan(plan, r, tonBody);
  if (ns === "near") {
    // Only a deposit venue's payment is signed on NEAR: the exact input, as NEAR or the reviewed NEP-141, to the
    // quote's deposit address, with no memo (the review shows none). accounts/near.ts holds the transaction to it.
    if (venue?.kind !== "deposit") return `a NEAR payment from a venue the app has no deposit rule for (${plan.provider})`;
    if (plan.approvals.length) return "an approval on a network that has none";
    if ((s.kind === "call" && (s.memo !== undefined || s.cellBody)) || (s.kind === "token-transfer" && s.memo !== undefined))
      return "a memo the review didn't show";
    if (s.kind === "call" && (r.fromContract !== null || s.value !== r.amountIn)) return "the deposit is not the reviewed token or amount";
    const to = s.kind === "call" ? s.to : s.kind === "token-transfer" ? s.recipient : undefined;
    if (!to) return "a payment NEAR deposits never make";
    if (to === r.refundAddress) return "the deposit address is your own account";
    return null;
  }
  if (ns !== "eip155") return null;

  const id = evmChainId(plan.fromChain);
  for (const a of plan.approvals) if (a.chainId !== undefined && a.chainId !== id) return "an approval on another network";
  if (s.kind === "call") {
    if (s.chainId !== undefined && s.chainId !== id) return "a transaction for another network";
    if (s.memo !== undefined || s.cellBody) return "a payload this network doesn't carry";
  }
  const inList = (list: readonly string[], a: string) => list.some((x) => same(x, a));
  // A Permit2 signature transfer (D38) only from a venue whose rule takes one, held to exactly this swap.
  const permit = permit2Problem(plan, r, venue);
  if (permit) return permit;
  if (venue?.kind === "pins") {
    for (const a of plan.approvals)
      if (a.amount !== 0n && !inList(venue.pins.spenders(plan.fromChain), a.spender)) return "an approval for a contract the app doesn't trust";
    if (s.kind === "call") {
      if (s.data === undefined) return "a plain transfer this venue never makes";
      if (!inList(venue.pins.callTargets(plan.fromChain), s.to)) return "a call to a contract the app doesn't trust";
    }
    // A Permit2 venue signs nothing typed but its permit (checked above): no gasless order.
    if (venue.permit2 && s.kind === "typed-order") return "an order signature this venue never asks for";
    return null;
  }
  if (venue?.kind === "deposit") {
    if (plan.approvals.length) return "an approval this venue never needs";
    if (s.kind === "typed-order") return "an order signature this venue never asks for";
    if (s.kind === "call" && s.data !== undefined) {
      const t = readTransfer(s.data);
      if (!r.fromContract || !same(s.to, r.fromContract) || !t || t.amount !== r.amountIn || s.value !== 0n)
        return "a contract call where a deposit was expected";
    }
    return null;
  }
  if (s.kind === "call" && s.data !== undefined) return `a contract call from a venue the app has no pins for (${plan.provider})`;
  if (s.kind === "typed-order") return `an order signature from a venue the app has no pins for (${plan.provider})`;
  return null;
}

/** transfer(to, amount) calldata, decoded, or null. */
function readTransfer(data: string): {to: string; amount: bigint} | null {
  if (!data.toLowerCase().startsWith("0xa9059cbb")) return null;
  try {
    const d = decodeFunctionData({abi: erc20Abi, data: data as `0x${string}`});
    if (d.functionName !== "transfer") return null;
    const [to, amount] = d.args;
    return {to, amount};
  } catch {
    return null;
  }
}

interface Armed {
  writes: {w: ArmedWrite; used: boolean}[];
  revokes: {token: string; spender: string}[];
  until: number;
}

/**
 * This execution's gate on `chain`. `arm` from reviewExecution (or the claim preview); every write consumes one
 * armed entry; `recordGrant` after an approve(>0) may have landed, so its revoke (approve 0) becomes allowed;
 * `recordSignature` after the wallet signed the armed Permit2 permit: the only bytes the armed swap call may then carry
 * after its data (D38).
 */
export function createSwapGate(chain: string) {
  let armed: Armed | null = null;
  const grants = new Set<string>();
  /** The armed Permit2 permit was consumed and its signature not recorded yet. */
  let awaitingSignature = false;
  /** What the wallet returned for this arm's Permit2 permit. */
  let permitSignature: string | undefined;
  const key = (token: string, spender: string) => `${token.toLowerCase()}|${spender.toLowerCase()}`;
  return {
    chain,
    arm(writes: readonly ArmedWrite[], revokes: readonly {token: string; spender: string}[] = [], now = Date.now()): void {
      armed = {writes: writes.map((w) => ({w, used: false})), revokes: [...revokes], until: now + ARM_TTL_MS};
      // A re-armed plan (the engine's re-quote pass) carries a new permit: the old signature spends nothing here.
      awaitingSignature = false;
      permitSignature = undefined;
    },
    disarm(): void {
      armed = null;
      awaitingSignature = false;
      permitSignature = undefined;
    },
    /** Port of mobile consumeSwapWrite without the kit `revoke` intent. */
    consume(intent: WriteIntent, now = Date.now()): boolean {
      const a = armed;
      if (!a || intent.chain !== chain) return false;
      // The engine's cleanup: approve(spender, 0) on an allowance this run granted — allowed until disarm (no TTL).
      if (
        a.revokes.some(
          (x) => grants.has(key(x.token, x.spender)) && matches({kind: "call", to: x.token, data: approveData(x.spender, 0n), value: 0n}, intent.method, intent.raw),
        )
      )
        return true;
      if (a.until < now) {
        for (const e of a.writes) e.used = true;
        return false;
      }
      const hit = a.writes.find((e) => !e.used && matches(e.w, intent.method, intent.raw, permitSignature));
      if (!hit) {
        // One stray write disarms the rest (revokes stay possible).
        for (const e of a.writes) e.used = true;
        return false;
      }
      hit.used = true;
      if (hit.w.kind === "permit2") awaitingSignature = true;
      return true;
    },
    /**
     * The wallet's answer to a signTypedData the gate let through: kept only when that write was this arm's Permit2
     * permit (once), as the signature its armed swap call must carry. Anything else is ignored.
     */
    recordSignature(signature: unknown): void {
      if (!awaitingSignature) return;
      awaitingSignature = false;
      if (typeof signature === "string") permitSignature = signature;
    },
    /** An approve(token → spender, > 0) went to the wallet and may have landed: its revoke is now allowed. */
    recordGrant(token: string, spender: string): void {
      grants.add(key(token, spender));
    },
    /** Armed writes not consumed yet (tests, diagnostics). */
    remaining(): number {
      return armed ? armed.writes.filter((e) => !e.used).length : 0;
    },
  };
}

/** One execution's gate (createSwapGate). */
export type SwapGate = ReturnType<typeof createSwapGate>;

/**
 * Network-fee ceilings per non-EVM family, native base units (mobile lib/send/gate.ts FEE_CEILING) — generous; a
 * real fee under normal load is far below. Solana's is enforced by the SDK account; EVM has none (the wallet sets gas).
 */
export const FEE_CEILING: Readonly<Partial<Record<ChainFamily, bigint>>> = {
  solana: 50_000_000n, // 0.05 SOL
  ton: 500_000_000n, // 0.5 TON
  tron: 60_000_000n, // 60 TRX (TRC-20 energy burn)
  btc: 200_000n, // 200k sats
  near: 100_000_000_000_000_000_000_000n, // 0.1 NEAR
  zcash: 1_000_000n, // 0.01 ZEC
};

/**
 * The review's fee budget. Non-EVM: the family ceilings. EVM natives differ per chain, so the cap is a USD budget
 * at the native's price (Ethereum $80, elsewhere $20); unpriced ETH chains fall back to 0.03 ETH on L1 / 0.005 ETH
 * on L2s. Another unpriced native gets none: the review blocks Confirm (on the web the EVM figure is advisory —
 * the wallet picks the gas).
 */
export function swapFeeCap(
  family: ChainFamily,
  opts: {chainId?: number; nativeSymbol: string; decimals: number; nativePriceUsd?: number},
): bigint | undefined {
  if (family !== "evm") return FEE_CEILING[family];
  const l1 = opts.chainId === 1;
  if (opts.nativePriceUsd && opts.nativePriceUsd > 0) {
    const coins = (l1 ? 80 : 20) / opts.nativePriceUsd;
    return BigInt(Math.ceil(coins * 1e6)) * 10n ** BigInt(Math.max(0, opts.decimals - 6));
  }
  if (opts.nativeSymbol === "ETH") return (l1 ? 30n : 5n) * 10n ** BigInt(opts.decimals - 3);
  return undefined;
}

/** Why an EVM swap with no fee budget (unpriced native) isn't signed — the review's Confirm block. */
export const uncappedFeeText = (nativeSymbol: string): string =>
  `Couldn't price ${nativeSymbol} to cap the network fee, so the swap can't be signed. Try again in a moment.`;
