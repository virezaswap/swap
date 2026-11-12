import { Address } from "@ton/core";
import {
  NATIVE_ASSET,
  NATIVE_ASSET_ADDRESS
} from "./config.js";

const ASSETS_URL = "api.ston.fi";

let cachedTokens = null;
let pendingRequest = null;

// Normalize friendly and raw TON addresses for comparisons.
export function tokenKey(address) {
  return Address.parse(address).toRawString();
}

export function sameToken(a, b) {
  return Boolean(a && b && tokenKey(a.address) === tokenKey(b.address));
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== "object") return null;

  const meta = asset.meta ?? {};
  const address = asset.contract_address ?? asset.contractAddress;

  if (typeof address !== "string") return null;

  let key;

  try {
    key = tokenKey(address);
  } catch {
    return null;
  }

  if (key === tokenKey(NATIVE_ASSET_ADDRESS)) {
    return { ...NATIVE_ASSET };
  }

  // Support metadata nested under meta or on the asset itself.
  const symbol = meta.symbol ?? asset.symbol;
  const decimals = Number(meta.decimals ?? asset.decimals);

  if (
    typeof symbol !== "string" ||
    !symbol.trim() ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return null;
  }

  // Do not offer explicitly blocked or deprecated assets.
  if (asset.blacklisted === true || asset.deprecated === true) {
    return null;
  }

  const name =
    meta.display_name ??
    meta.displayName ??
    meta.name ??
    asset.display_name ??
    asset.displayName ??
    symbol;

  return {
    address,
    symbol: symbol.trim(),
    name: typeof name === "string" ? name : symbol,
    decimals
  };
}

async function requestTokens() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(ASSETS_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Asset request failed: ${response.status}`);
    }

    const body = await response.json();
    const rows = Array.isArray(body) ? body : body?.asset_list;

    if (!Array.isArray(rows)) {
      throw new Error("Unsupported asset response.");
    }

    const unique = new Map([
      [tokenKey(NATIVE_ASSET.address), { ...NATIVE_ASSET }]
    ]);

    for (const row of rows) {
      const token = normalizeAsset(row);

      if (token) {
        unique.set(tokenKey(token.address), token);
      }
    }

    const nativeKey = tokenKey(NATIVE_ASSET.address);

    return [...unique.values()].sort((a, b) => {
      if (tokenKey(a.address) === nativeKey) return -1;
      if (tokenKey(b.address) === nativeKey) return 1;

      return (
        a.symbol.localeCompare(b.symbol) ||
        a.address.localeCompare(b.address)
      );
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadTokens({ refresh = false } = {}) {
  if (cachedTokens && !refresh) return [...cachedTokens];

  if (!pendingRequest) {
    pendingRequest = requestTokens()
      .then((tokens) => {
        cachedTokens = tokens;
        return tokens;
      })
      .finally(() => {
        pendingRequest = null;
      });
  }

  return [...await pendingRequest];
}

export function searchTokens(tokens, query = "") {
  const text = query.trim();

  if (!text) return tokens;

  // Match pasted addresses even when their representation differs.
  try {
    const key = tokenKey(text);
    return tokens.filter((token) => tokenKey(token.address) === key);
  } catch {
    const needle = text.toLowerCase();

    return tokens.filter((token) =>
      `${token.symbol} ${token.name} ${token.address}`
        .toLowerCase()
        .includes(needle)
    );
  }
}
