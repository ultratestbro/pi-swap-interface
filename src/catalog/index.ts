/**
 * The catalog's public entry (contract: CatalogModule in src/contracts/modules.ts): networks, tokens, addresses,
 * prices, balances, viem chain definitions and public clients — no backend. Other modules import only from here.
 */
export {catalogPort, usePrices, useSwapTokens, useTokenLookup} from "./port";

// ── imported tokens (D39) ──
export {
  IMPORTED_TOKENS_CAP,
  IMPORTED_TOKENS_KEY,
  MAX_TOKEN_DECIMALS,
  TokenReadError,
  UNKNOWN_TOKEN_TEXT,
  addImportedToken,
  cleanTokenText,
  decodeTokenString,
  decodeUint,
  detectTokenAddress,
  importKey,
  importable,
  importedToken,
  importedTokens,
  listedToken,
  lookalikeOf,
  metaplexMetadata,
  parseImportedTokens,
  parseMint,
  parseTokenKey,
  readEvmToken,
  readSolanaToken,
  readTokenForImport,
  readsAs,
  removeImportedToken,
  resetImportedTokens,
  token2022Metadata,
  useImportedTokens,
  type TokenMeta,
  type TokenReadClient,
} from "./imported";

// ── networks ──
export {CHAIN_LIST, QR_FALLBACK_FAMILIES, SIGNING_FAMILIES, chainByCaip2Web, chainBySlugWeb, webChains} from "./network";
export {EXTRA_CHAINS, type ExtraChain} from "./extraChains";

// ── tokens ──
export {
  TOKENS,
  TOKEN_BY_KEY,
  ZERO_ADDRESS,
  PINNED_NETWORKS,
  catalogTokens,
  defaultPair,
  destTokenId,
  flipPair,
  matchesToken,
  payModeOf,
  pickSide,
  pickerNetworks,
  swapTokens,
  tokenKey,
  tokenPrice,
  tokensOf,
} from "./tokens";

// ── addresses ──
export {
  checkRecipient,
  detectAddressFamily,
  isAddressFor,
  sameTonAddress,
  shortAddress,
  toFriendlyAddress,
  toRawAddress,
} from "./address";
export {base58ToBytes, base64ToBytes, bytesToBase58, bytesToBase64, bytesToHex, hexToBytes} from "./bytes";
export {addressUrl, txUrl} from "./explorer";

// ── EVM ──
export {MULTICALL3, VIEM_CHAINS, isContractAddress, multicallAddress, publicClient, readTransport, toViemChain} from "./evm";
export {evmRpcUrls, nearRpcUrls, solanaRpcUrls, tronApiUrls} from "./rpc";

// ── Tron ──
export {TronApiError, tronAddressBytes, tronAddressFromBytes, tronPost, tronPostTo} from "./tron";

// ── NEAR ──
export {isNearAccountId, nearAccount, nearView} from "./near";

// ── prices ──
export {PRICE_IDS, fetchPrices, priceFor} from "./prices";

// ── balances ──
export {
  TOKEN_2022_MINTS,
  ataOf,
  balanceKey,
  balanceSpecs,
  mergeBalances,
  readEvmBalances,
  readNearBalances,
  readSolanaBalances,
  readTronBalances,
  readTonBalances,
  useBalances,
  type BalanceRead,
  type BalanceSpec,
} from "./balances";

// ── formatting (@cp0x/shared) ──
export {formatAmount, formatPct, formatUsd, formatUsdDelta, splitUsd, unitsToDecimal} from "../shared";
