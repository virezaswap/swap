import { StonApiClient } from "@ston-fi/api";
import { QUOTE_MAX_AGE_MS } from "./config.js";
import { sameToken, tokenKey } from "./tokens.js";

const api = new StonApiClient();

function validateDecimals(decimals) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    throw new Error("Invalid token decimals.");
  }
}

// Convert a user-entered amount into integer token units.
// Never use floating-point multiplication for token amounts.
export function toUnits(value, decimals) {
  validateDecimals(decimals);

  const text = String(value).trim().replace(",", ".");

  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error("Enter a valid amount, such as 1 or 0.5.");
  }

  const [whole, fraction = ""] = text.split(".");

  if (fraction.length > decimals) {
    throw new Error(
      `This token supports up to ${decimals} decimal places.`
    );
  }

  const units = BigInt(
    whole + fraction.padEnd(decimals, "0")
  );

  if (units <= 0n) {
    throw new Error("Enter an amount greater than zero.");
  }

  return units.toString();
}

function parseUnits(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("The quote contains an invalid token amount.");
  }

  return BigInt(value);
}

export function fromUnits(value, decimals) {
  validateDecimals(decimals);

  const units = parseUnits(value);
  const digits = units.toString();

  if (decimals === 0) return digits;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

// The UI uses percentages; the API uses a fraction.
// Example: "0.5" (%) becomes "0.005".
export function slippageToFraction(value) {
  const text = String(value).trim().replace(",", ".");

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("Enter slippage with up to 2 decimal places.");
  }

  const [whole, fraction = ""] = text.split(".");
  const hundredths =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, "0"));

  // Website validation rule, matching ui.js.
  if (hundredths <= 0n || hundredths > 5000n) {
    throw new Error("Slippage must be above 0% and up to 50%.");
  }

  const digits = hundredths.toString().padStart(5, "0");
  const integerPart = digits.slice(0, -4);
  const fractionalPart = digits.slice(-4).replace(/0+$/, "");

  return `${integerPart}.${fractionalPart}`;
}

function snapshotToken(token) {
  if (!token) {
    throw new Error("Choose both tokens.");
  }

  tokenKey(token.address);
  validateDecimals(token.decimals);

  if (typeof token.symbol !== "string" || !token.symbol) {
    throw new Error("Invalid token symbol.");
  }

  return Object.freeze({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals
  });
}

// Compute the displayed rate using integer arithmetic.
function formatRate(
  offerUnits,
  askUnits,
  offerDecimals,
  askDecimals
) {
  const precision = 12;
  const numerator =
    BigInt(askUnits) *
    10n ** BigInt(offerDecimals + precision);

  const denominator =
    BigInt(offerUnits) *
    10n ** BigInt(askDecimals);

  const scaled = numerator / denominator;

  if (scaled === 0n) return "<0.000000000001";

  return fromUnits(scaled.toString(), precision);
}

export async function getQuote({
  payToken,
  receiveToken,
  amount,
  slippagePercent
}) {
  const offer = snapshotToken(payToken);
  const ask = snapshotToken(receiveToken);

  if (sameToken(offer, ask)) {
    throw new Error("Choose two different tokens.");
  }

  const offerUnits = toUnits(amount, offer.decimals);
  const slippageTolerance = slippageToFraction(slippagePercent);

  let simulation;

  try {
    simulation = await api.simulateSwap({
      offerAddress: offer.address,
      askAddress: ask.address,
      offerUnits,
      slippageTolerance
    });
  } catch (cause) {
    // A failed request is not proof that no route exists.
    throw new Error(
      "Could not get a quote. The service may be unavailable, " +
      "or this pair and amount may not have a supported route.",
      { cause }
    );
  }

  if (!simulation || typeof simulation !== "object") {
    throw new Error("The quote response is incomplete.");
  }

  const quotedOffer = parseUnits(simulation.offerUnits);
  const quotedAsk = parseUnits(simulation.askUnits);
  const minimumAsk = parseUnits(simulation.minAskUnits);

  if (
    tokenKey(simulation.offerAddress) !== tokenKey(offer.address) ||
    tokenKey(simulation.askAddress) !== tokenKey(ask.address) ||
    quotedOffer !== BigInt(offerUnits)
  ) {
    throw new Error("The quote does not match the selected trade.");
  }

  if (
    quotedAsk <= 0n ||
    minimumAsk <= 0n ||
    minimumAsk > quotedAsk
  ) {
    throw new Error("The quote has an invalid output amount.");
  }

  // Validate the router address before retaining the quote.
  tokenKey(simulation.routerAddress);

  const createdAt = Date.now();

  return Object.freeze({
    payToken: offer,
    receiveToken: ask,
    offerUnits,
    askUnits: simulation.askUnits,
    minAskUnits: simulation.minAskUnits,
    slippageTolerance,
    routerAddress: simulation.routerAddress,
    createdAt,
    expiresAt: createdAt + QUOTE_MAX_AGE_MS,

    // Retain router and protocol details for the transaction module.
    simulation,

    display: Object.freeze({
      receiveAmount: fromUnits(simulation.askUnits, ask.decimals),
      minimum:
        `${fromUnits(simulation.minAskUnits, ask.decimals)} ` +
        ask.symbol,
      rate:
        `1 ${offer.symbol} ≈ ` +
        `${formatRate(
          offerUnits,
          simulation.askUnits,
          offer.decimals,
          ask.decimals
        )} ${ask.symbol}`,

      // Do not guess whether an undocumented value is a
      // fraction or a percentage.
      priceImpact: "Unavailable",
      route: "STON.fi"
    })
  });
}

export function isQuoteExpired(quote) {
  return (
    !quote ||
    !Number.isFinite(quote.expiresAt) ||
    Date.now() >= quote.expiresAt
  );
}

// Call immediately before building a transaction.
// Also re-check after any asynchronous preparation.
export function assertQuoteMatches(quote, state) {
  if (isQuoteExpired(quote)) {
    throw new Error("Quote expired. Get a new quote.");
  }

  if (
    !sameToken(quote.payToken, state.payToken) ||
    !sameToken(quote.receiveToken, state.receiveToken) ||
    quote.payToken.decimals !== state.payToken.decimals ||
    quote.receiveToken.decimals !== state.receiveToken.decimals ||
    quote.offerUnits !== toUnits(
      state.amount,
      state.payToken.decimals
    ) ||
    quote.slippageTolerance !== slippageToFraction(
      state.slippagePercent
    )
  ) {
    throw new Error("Trade details changed. Get a new quote.");
  }

  return quote;
}
