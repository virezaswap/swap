// Public configuration only.
// Never put private keys or recovery phrases in this project.

export const APP_NAME = "Vireza Swap";

export const TON_MAINNET = "-239";

export const TON_RPC_URL =
  "toncenter.com";

// STON.fi's identifier for the TON network's native coin.
// The website displays this asset as GRAM.
export const NATIVE_ASSET_ADDRESS =
  "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

export const NATIVE_ASSET = Object.freeze({
  address: NATIVE_ASSET_ADDRESS,
  symbol: "GRAM",
  name: "Gram",
  decimals: 9
});

export const DEFAULT_SLIPPAGE_PERCENT = "0.5";

export const QUOTE_MAX_AGE_MS = 30_000;

export const TRANSACTION_VALIDITY_SECONDS = 300;

// Resolve public files relative to the deployed application.
// Works with a repository subfolder on GitHub Pages.
export const APP_BASE_URL = new URL(
  import.meta.env.BASE_URL,
  document.baseURI
);

export const MANIFEST_URL = new URL(
  "tonconnect-manifest.json",
  APP_BASE_URL
).href;
