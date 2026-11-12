import { Address } from "@ton/core";
import {
  NATIVE_ASSET,
  NATIVE_ASSET_ADDRESS
} from "./config.js";

const ASSETS_URL = "api.ston.fi";
const REQUEST_TIMEOUT_MS = 20_000;

let cachedTokens = null;
let pendingRequest = null;

// Normalize TON addresses for comparisons.
export function tokenKey(address) {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("Invalid token address.");
  }

  return Address.parse(address.trim()).toRawString();
}

export function sameToken(a, b) {
  if (!a?.address || !b?.address) return false;

  try {
    return tokenKey(a.address) === tokenKey(b.address);
  } catch {
    return false;
  }
}

function copyTokens(tokens) {
  return tokens.map((token) => ({ ...token }));
}

function readDecimals(value) {
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }

  const text = String(value).trim();

  if (!/^\d+$/.test(text)) return null;

  const decimals = Number(text);

  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return null;
  }

  return decimals;
}

function getNativeToken() {
  if (!NATIVE_ASSET || typeof NATIVE_ASSET !== "object") {
    throw new Error("Missing native asset configuration.");
  }

  const configuredKey = tokenKey(NATIVE_ASSET_ADDRESS);
  const assetKey = tokenKey(NATIVE_ASSET.address);
  const decimals = readDecimals(NATIVE_ASSET.decimals);

  if (configuredKey !== assetKey || decimals === null) {
    throw new Error("Invalid native asset configuration.");
  }

  return {
    address: NATIVE_ASSET.address.trim(),
    symbol: "GRAM",
    name: "Gram",
    decimals
  };
}

function normalizeAsset(asset, nativeToken, nativeKey) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  // These checks do not establish whether a token is trustworthy.
  if (
    asset.blacklisted === true ||
    asset.deprecated === true
  ) {
    return null;
  }

  const address =
    asset.contract_address ?? asset.contractAddress;

  if (typeof address !== "string") {
    return null;
  }

  let key;

  try {
    key = tokenKey(address);
  } catch {
    return null;
  }

  if (key === nativeKey) {
    return { ...nativeToken };
  }

  const meta =
    asset.meta && typeof asset.meta === "object"
      ? asset.meta
      : {};

  const symbol = meta.symbol ?? asset.symbol;
  const decimals = readDecimals(
    meta.decimals ?? asset.decimals
  );

  if (
    typeof symbol !== "string" ||
    !symbol.trim() ||
    decimals === null
  ) {
    return null;
  }

  const rawName =
    meta.display_name ??
    meta.displayName ??
    meta.name ??
    asset.display_name ??
    asset.displayName ??
    asset.name ??
    symbol;

  const name =
    typeof rawName === "string" && rawName.trim()
      ? rawName.trim()
      : symbol.trim();

  return {
    address: address.trim(),
    symbol: symbol.trim(),
    name,
    decimals
  };
}

async function requestTokens() {
  const nativeToken = getNativeToken();
  const nativeKey = tokenKey(nativeToken.address);

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ASSETS_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Could not load tokens (HTTP ${response.status}).`
      );
    }

    const body = await response.json();

    const rows = Array.isArray(body)
      ? body
      : body?.asset_list;

    if (!Array.isArray(rows)) {
      throw new Error("Unsupported token API response.");
    }

    const unique = new Map([
      [nativeKey, nativeToken]
    ]);

    for (const row of rows) {
      const token = normalizeAsset(
        row,
        nativeToken,
        nativeKey
      );

      if (!token) continue;

      const key = tokenKey(token.address);

      if (!unique.has(key)) {
        unique.set(key, token);
      }
    }

    const otherTokens = [...unique.entries()]
      .filter(([key]) => key !== nativeKey)
      .map(([, token]) => token)
      .sort((a, b) => {
        return (
          a.symbol.localeCompare(b.symbol) ||
          a.name.localeCompare(b.name) ||
          a.address.localeCompare(b.address)
        );
      });

    return [nativeToken, ...otherTokens];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        "Token request timed out. Reload the page to retry.",
        { cause: error }
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadTokens({ refresh = false } = {}) {
  // Share an in-progress request instead of starting duplicates.
  if (pendingRequest) {
    return copyTokens(await pendingRequest);
  }

  if (cachedTokens && !refresh) {
    return copyTokens(cachedTokens);
  }

  pendingRequest = requestTokens()
    .then((tokens) => {
      cachedTokens = copyTokens(tokens);
      return cachedTokens;
    })
    .finally(() => {
      pendingRequest = null;
    });

  return copyTokens(await pendingRequest);
}

export function searchTokens(tokens, query = "") {
  if (!Array.isArray(tokens)) return [];

  const text = String(query ?? "").trim();

  if (!text) return [...tokens];

  // A complete address can match either raw or friendly form.
  try {
    const key = tokenKey(text);

    return tokens.filter((token) => {
      try {
        return tokenKey(token.address) === key;
      } catch {
        return false;
      }
    });
  } catch {
    // Not a complete address: search names, symbols and text.
  }

  const needle = text.toLowerCase();

  return tokens.filter((token) => {
    const searchable = [
      token.symbol,
      token.name,
      token.address
    ]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();

    return searchable.includes(needle);
  });
}
