/**
 * An imported token's logo (D39), found by its contract or mint — never by its symbol, and never at a URL its deployer
 * chose (a Metaplex `uri`, a token list): a copy named "USDC" has no logo there and keeps its monogram.
 *
 *   EVM    — DefiLlama's token icons by chain id, then Trust Wallet's assets repository on the networks it has.
 *   Solana — Trust Wallet's assets repository (DefiLlama's icons have no Solana).
 *
 * The bytes are fetched (connect-src) and shown as a `data:` URL, so the CSP's `img-src 'self' data: blob:` stays as it
 * is on every build (vercel.json, Docker, the IPFS meta tag). Only a raster image type of at most LOGO_MAX_BYTES is
 * kept; anything else falls through to the next source, then to the monogram.
 */
import {checksumAddress, type Address} from "viem";
import type {Token} from "../contracts/domain";
import {bytesToBase64} from "./bytes";
import {chainBySlugWeb} from "./network";
import {withTimeout} from "./prices";

const LLAMA_ICONS = "https://token-icons.llamao.fi/icons/tokens";
const TRUST_WALLET = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

/** Trust Wallet's directory per importable network that has one (checked 2026-11-16: `blockchains/<dir>/info/logo.png`). */
export const TRUST_WALLET_CHAINS: Readonly<Record<string, string>> = {
  ethereum: "ethereum", arbitrum: "arbitrum", optimism: "optimism", base: "base", solana: "solana", polygon: "polygon",
  bsc: "smartchain", avalanche: "avalanchec", zksync: "zksync", linea: "linea", scroll: "scroll", monad: "monad",
  hyperevm: "hyperevm", gnosis: "xdai", sonic: "sonic", celo: "celo", plasma: "plasma", megaeth: "megaeth", sei: "sei",
  mantle: "mantle",
};

/** Raster types only: an SVG is a document, and a logo needs none of what it can carry. */
const LOGO_TYPES = new Set(["image/png", "image/webp", "image/jpeg", "image/gif", "image/avif"]);
/** Trust Wallet's logos are 256 px PNGs of 30–60 KB; DefiLlama's, resized to 64 px, a few KB. */
export const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_TIMEOUT_MS = 8_000;

/** Where an imported token's logo may be, in the order asked; none for a catalog token or a network without a source. */
export function logoUrls(t: Pick<Token, "chain" | "contract" | "imported">): string[] {
  if (!t.imported || !t.contract) return [];
  const chain = chainBySlugWeb(t.chain);
  const tw = TRUST_WALLET_CHAINS[t.chain];
  if (chain?.family === "evm" && chain.chainId) {
    // Trust Wallet's paths are the checksummed address; DefiLlama takes either case.
    const a = checksumAddress(t.contract.toLowerCase() as Address);
    return [`${LLAMA_ICONS}/${chain.chainId}/${a}?h=64&w=64`, ...(tw ? [`${TRUST_WALLET}/${tw}/assets/${a}/logo.png`] : [])];
  }
  if (chain?.family === "solana" && tw) return [`${TRUST_WALLET}/${tw}/assets/${encodeURIComponent(t.contract)}/logo.png`];
  return [];
}

/**
 * The first source's logo as a `data:` URL, or null when no source has one. A source that couldn't be reached (offline,
 * timed out) while none answered with a logo throws, so react-query asks once more; a plain "not here" (404, another
 * type, too large) is the answer.
 */
export async function fetchTokenLogo(t: Pick<Token, "chain" | "contract" | "imported">, signal?: AbortSignal): Promise<string | null> {
  let unreachable = false;
  for (const url of logoUrls(t)) {
    let res: Response;
    try {
      res = await fetch(url, {signal: withTimeout(LOGO_TIMEOUT_MS, signal), credentials: "omit", referrerPolicy: "no-referrer"});
    } catch (e) {
      if (signal?.aborted) throw e;
      unreachable = true;
      continue;
    }
    if (!res.ok) continue;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_TYPES.has(type) || Number(res.headers.get("content-length") ?? 0) > LOGO_MAX_BYTES) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted) throw e;
      unreachable = true;
      continue;
    }
    if (bytes.length && bytes.length <= LOGO_MAX_BYTES) return `data:${type};base64,${bytesToBase64(bytes)}`;
  }
  if (unreachable) throw new Error("No logo source could be reached.");
  return null;
}
