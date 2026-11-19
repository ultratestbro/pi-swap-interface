/**
 * Revoke one token approval (D46) — the Approvals section's only wallet write, here behind the signing choke point
 * (D10). It sends exactly the module's revoke of an approval its own scan found, and nothing else:
 *
 *   - the connected wallet is the scanned owner, on the approval's network (getSigner switched it; checked again);
 *   - the approval is one the same scan of that network returned (by id, token, spender and standard);
 *   - the transaction is the module's `buildRevokeTransaction` (ERC-20 approve(spender, 0), an NFT's approve(0x0, id) or
 *     setApprovalForAll(operator, false), Permit2 lockdown), value 0, sent to the approval's token — or for Permit2 to
 *     one of the network's Permit2 contracts — and `isRevokeTransaction` against every target the scan found agrees;
 *   - an ERC-20 approval's token is no ERC-721 by ERC-165, as the module's own revoke checks (F31): there
 *     approve(spender, 0) would APPROVE the spender for token #0; a token that can't be asked is refused too;
 *   - it doesn't revert in eth_call; then the wallet is asked, and the receipt waited for.
 *
 * An EIP-7702 delegation is never revoked from a page: it takes a signed type-4 authorization, which a browser wallet
 * gives only in its own settings.
 */
import ApprovalsProtocolEvm, {isRevokeTransaction, STANDARDS, type EvmApproval} from "@anywalletkit/protocol-approvals-evm";
import {getAddress, type Address, type Hex} from "viem";
import type {RevokeInput, ScannedApproval} from "../../contracts/approvals";
import type {EvmSourceSigner} from "../../contracts/execution";
import {refusal} from "../errors";
import {assertEvmWallet, evmReads, normalizeWalletError, waitForEvmTx, type EvmReads} from "./evm";

const NOT_SENT = "nothing was sent.";
const ERC721_INTERFACE = "0x80ac58cd";
const SUPPORTS_INTERFACE = [
  {type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{type: "bytes4"}], outputs: [{type: "bool"}]},
] as const;

/** Whether `token` says it is an ERC-721 (ERC-165): true; reverting or anything else: false (the ERC-20 it was found as). */
async function isErc721(pub: EvmSourceSigner["pub"], token: Address): Promise<boolean> {
  try {
    return (await pub.readContract({address: token, abi: SUPPORTS_INTERFACE, functionName: "supportsInterface", args: [ERC721_INTERFACE]})) === true;
  } catch (e) {
    // A revert answers "not an NFT"; a network that didn't answer proves nothing, so nothing is sent.
    if (/revert/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw refusal(`Couldn't check the token — try again; ${NOT_SENT}`, e);
  }
}

/** The module's approval, as its builder and checks take it. */
const moduleApproval = (a: ScannedApproval): EvmApproval =>
  ({
    id: a.id,
    standard: a.standard,
    chainId: a.chainId,
    token: a.token,
    spender: a.spender,
    amount: a.amount,
    unlimited: a.unlimited,
    risks: [...a.risks],
    ...(a.tokenId !== undefined ? {tokenId: a.tokenId} : {}),
    ...(a.expiration !== undefined ? {expiration: a.expiration} : {}),
    ...(a.permit2 !== undefined ? {permit2: a.permit2} : {}),
  }) as EvmApproval;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The same approval: one entry of the scan, unchanged. */
const sameApproval = (a: ScannedApproval, b: ScannedApproval): boolean =>
  a.id === b.id && a.chainId === b.chainId && a.standard === b.standard && same(a.token, b.token) && same(a.spender, b.spender) && a.tokenId === b.tokenId && (a.permit2 ?? "") === (b.permit2 ?? "");

/** buildRevokeTransaction needs no account or network. */
let builder: ApprovalsProtocolEvm | null = null;
const buildRevoke = (a: ScannedApproval) => {
  builder ??= new ApprovalsProtocolEvm({getAddress: async () => "0x0000000000000000000000000000000000000000"});
  return builder.buildRevokeTransaction(moduleApproval(a));
};

export interface RevokeDeps {
  /** EVM reads (the simulation); default the SDK's read-only account over the signer's RPCs. */
  reads?: EvmReads;
}

/** Revoke `input.approval` from `signer`; resolves with the hash once it is mined. Throws an answered Error when refused. */
export async function sendRevoke(signer: EvmSourceSigner, input: RevokeInput, deps: RevokeDeps = {}): Promise<{hash: Hex}> {
  const {owner, approval, scanned} = input;
  if (getAddress(signer.owner) !== getAddress(owner)) throw refusal(`Connect the wallet that gave this approval to revoke it — ${NOT_SENT}`);
  if (approval.chainId !== signer.chain.id) throw refusal(`Switch your wallet to ${signer.chain.name} to revoke this approval — ${NOT_SENT}`);
  if (approval.standard === "eip7702") throw refusal(`A delegation is removed in your wallet's own settings — ${NOT_SENT}`);
  const found = scanned.find((a) => a.id === approval.id);
  const onChain = scanned.filter((a) => a.chainId === approval.chainId);
  if (!found || !sameApproval(found, approval)) throw refusal(`This approval isn't in the last scan — scan again. ${NOT_SENT.replace(/^n/, "N")}`);

  const tx = buildRevoke(approval);
  const to = getAddress(tx.to);
  const target = approval.standard === "permit2" ? STANDARDS.permit2AddressesFor(approval.chainId).map((p) => getAddress(p)) : [getAddress(approval.token)];
  const isRevoke = isRevokeTransaction(tx, {targets: onChain.map((a) => ({token: a.token, standard: a.standard})), chainId: approval.chainId});
  if (!isRevoke || tx.value !== 0n || !target.includes(to)) throw refusal(`That isn't a revoke of the approval shown — ${NOT_SENT}`);

  if (approval.standard === "erc20" && (await isErc721(signer.pub, getAddress(approval.token))))
    throw refusal(`That token is an NFT collection: approve(spender, 0) there would approve token #0 — ${NOT_SENT}`);
  await assertEvmWallet(signer);
  const sim = await (deps.reads ?? evmReads(signer)).simulateTransaction({to, data: tx.data as Hex, value: 0n}).catch(() => null);
  if (sim && !sim.ok) throw refusal(`The revoke would fail on-chain (${sim.reason.slice(0, 120)}) — ${NOT_SENT}`);
  let hash: Hex;
  try {
    hash = await signer.wallet.sendTransaction({account: getAddress(owner) as Address, chain: signer.chain, to, data: tx.data as Hex, value: 0n});
  } catch (e) {
    throw normalizeWalletError(e, signer.transport);
  }
  await waitForEvmTx(signer.pub, hash);
  return {hash};
}
