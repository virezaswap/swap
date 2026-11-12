import { Buffer } from "buffer";

globalThis.Buffer = Buffer;

const [
  { StonApiClient },
  { dexFactory },
  { TonClient },
  { TonConnectUI }
] = await Promise.all([
  import("@ston-fi/api"),
  import("@ston-fi/sdk"),
  import("@ton/ton"),
  import("@tonconnect/ui")
]);

const $ = (id) => document.getElementById(id);

const api = new StonApiClient();
const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC"
});

const NATIVE =
  "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

const USDT =
  "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const ui = new TonConnectUI({
  manifestUrl: new URL(
    `${import.meta.env.BASE_URL}tonconnect-manifest.json`,
    location.origin
  ).href,
  buttonRootId: "wallet",
  language: "en"
});

let quote = null;
let busy = false;
let pending = null;

function status(message) {
  $("status").textContent = message;
}

// External error messages may use another language.
// Keep website-facing messages in English.
function reportError(error, fallback) {
  console.error(error);
  status(error instanceof AppError ? error.message : fallback);
}

class AppError extends Error {}

function units(text) {
  const normalized = text.trim().replace(",", ".");

  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new AppError(
      "Enter an amount with no more than 9 decimal places."
    );
  }

  const [whole, fraction = ""] = normalized.split(".");
  const value =
    BigInt(whole) * 1000000000n +
    BigInt(fraction.padEnd(9, "0"));

  if (value <= 0n) {
    throw new AppError("The amount must be greater than zero.");
  }

  return value.toString();
}

function displayUnits(value, decimals) {
  const n = BigInt(value);
  const scale = 10n ** BigInt(decimals);

  const fraction = (n % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return `${n / scale}${fraction ? "." + fraction : ""}`;
}

function updateButtons() {
  $("estimate").disabled = busy;
  $("swap").disabled = busy || !quote || !ui.account;
  $("amount").disabled = busy;
}

function invalidateQuote() {
  quote = null;
  $("quote").textContent = "";
  updateButtons();
}

function requireMainnet() {
  if (!ui.account) {
    throw new AppError("Connect your wallet first.");
  }

  if (String(ui.account.chain) !== "-239") {
    throw new AppError("Switch your wallet to TON mainnet.");
  }
}

function renderQuote(q) {
  $("quote").textContent =
    `You pay: ${displayUnits(q.offerUnits, 9)} GRAM\n` +
    `Estimated receive: ${displayUnits(q.askUnits, 6)} USDT\n` +
    `Minimum received: ${displayUnits(q.minAskUnits, 6)} USDT\n` +
    "Network fees are paid separately in GRAM.";
}

async function simulate() {
  const offered = units($("amount").value);

  const q = await api.simulateSwap({
    offerAddress: NATIVE,
    offerUnits: offered,
    askAddress: USDT,
    slippageTolerance: "0.005"
  });

  if (
    !q.router ||
    q.askUnits == null ||
    q.minAskUnits == null ||
    q.offerUnits == null
  ) {
    throw new AppError("The quote response is incomplete.");
  }

  if (BigInt(q.offerUnits) !== BigInt(offered)) {
    throw new AppError(
      "The quoted amount does not match your entered amount."
    );
  }

  if (BigInt(q.minAskUnits) <= 0n) {
    throw new AppError("The minimum received amount is invalid.");
  }

  return { ...q, capturedAt: Date.now() };
}

$("amount").addEventListener("input", invalidateQuote);

ui.onStatusChange(() => {
  invalidateQuote();

  status(
    ui.account
      ? "Wallet connected. Get a quote to continue."
      : "Connect your wallet to swap."
  );
});

$("estimate").addEventListener("click", async () => {
  if (busy) return;

  busy = true;
  invalidateQuote();
  status("Getting a quote from STON.fi…");

  try {
    quote = await simulate();
    renderQuote(quote);

    status(
      ui.account
        ? "Quote ready. You can now request the swap."
        : "Quote ready. Connect your wallet to continue."
    );
  } catch (error) {
    reportError(
      error,
      "Could not get a quote. Check your connection and try again."
    );
  } finally {
    busy = false;
    updateButtons();
  }
});

$("swap").addEventListener("click", async () => {
  if (busy) return;

  busy = true;
  updateButtons();

  let walletRequestStarted = false;

  try {
    requireMainnet();

    if (!quote || Date.now() - quote.capturedAt > 30000) {
      invalidateQuote();
      throw new AppError("Your quote expired. Get a new quote.");
    }

    if (
      BigInt(units($("amount").value)) !==
      BigInt(quote.offerUnits)
    ) {
      invalidateQuote();
      throw new AppError("The amount changed. Get a new quote.");
    }

    const walletAddress = ui.account.address;
    const q = quote;
    const queryId = BigInt(Date.now());

    status("Preparing your STON.fi transaction…");

    const dex = dexFactory(q.router);

    const router = client.open(
      dex.Router.create(q.router.address)
    );

    const proxyTon = dex.pTON.create(
      q.router.ptonMasterAddress
    );

    const tx = await router.getSwapTonToJettonTxParams({
      userWalletAddress: walletAddress,
      proxyTon,
      offerAmount: q.offerUnits,
      askJettonAddress: USDT,
      minAskAmount: q.minAskUnits,
      queryId
    });

    requireMainnet();

    if (ui.account.address !== walletAddress) {
      invalidateQuote();
      throw new AppError("Your wallet changed. Get a new quote.");
    }

    if (Date.now() - q.capturedAt > 30000) {
      invalidateQuote();
      throw new AppError("Your quote expired. Get a new quote.");
    }

    const attached = displayUnits(tx.value.toString(), 9);

    const proceed = window.confirm(
      `Swap ${displayUnits(q.offerUnits, 9)} GRAM to USDT?\n` +
      `Minimum received: ${displayUnits(q.minAskUnits, 6)} USDT\n` +
      `Attached amount: ${attached} GRAM.\n\n` +
      "The attached amount includes the swap amount and " +
      "funds for execution. It is not the final fee."
    );

    if (!proceed) {
      status("Cancelled before requesting approval from your wallet.");
      return;
    }

    // Recheck after the confirmation dialog.
    requireMainnet();

    if (ui.account.address !== walletAddress) {
      invalidateQuote();
      throw new AppError("Your wallet changed. Get a new quote.");
    }

    if (Date.now() - q.capturedAt > 30000) {
      invalidateQuote();
      throw new AppError("Your quote expired. Get a new quote.");
    }

    const operation = {
      walletAddress,
      queryId: queryId.toString()
    };

    // Save the operation before opening the wallet.
    // A connection error does not prove the transaction failed.
    pending = operation;

    try {
      localStorage.setItem(
        "vireza:last-operation",
        JSON.stringify(operation)
      );
    } catch (error) {
      console.warn("Could not save the operation locally.", error);
    }

    $("records").textContent = "";
    $("check").hidden = false;
    walletRequestStarted = true;

    status("Approve or reject the transaction in your wallet.");

    await ui.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      network: "-239",
      from: walletAddress,
      messages: [{
        address: tx.to.toString(),
        amount: tx.value.toString(),
        payload: tx.body?.toBoc().toString("base64")
      }]
    });

    invalidateQuote();

    status(
      "Your wallet returned a transaction response. " +
      "This does not confirm that the swap completed. " +
      "Select Check transaction to look for indexed records."
    );
  } catch (error) {
    console.error(error);

    const message =
      error instanceof AppError
        ? error.message
        : "The swap request could not be completed.";

    status(
      message +
      (walletRequestStarted
        ? " If you approved it in your wallet, check the transaction " +
          "before trying again."
        : "")
    );
  } finally {
    busy = false;
    updateButtons();
  }
});

$("check").addEventListener("click", async () => {
  if (!pending) return;

  $("check").disabled = true;

  try {
    status("Looking for transaction records on STON.fi…");

    const result = await api.queryTransactions({
      walletAddress: pending.walletAddress,
      queryId: pending.queryId
    });

    $("records").textContent = JSON.stringify(result, null, 2);

    status(
      "Raw API records are shown below. Empty results may mean " +
      "the transaction has not been indexed yet. " +
      "Do not resend based only on empty results. " +
      "This view does not interpret the final swap status."
    );
  } catch (error) {
    console.error(error);

    status(
      "Could not check transaction records. " +
      "Do not resend just because this check failed."
    );
  } finally {
    $("check").disabled = false;
  }
});

try {
  const stored = localStorage.getItem("vireza:last-operation");

  if (stored) {
    const parsed = JSON.parse(stored);

    if (
      typeof parsed.walletAddress === "string" &&
      typeof parsed.queryId === "string"
    ) {
      pending = parsed;
      $("check").hidden = false;
    }
  }
} catch (error) {
  console.warn("Could not restore the previous operation.", error);
}

updateButtons();
