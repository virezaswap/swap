import { TonConnectUI } from "@tonconnect/ui";
import { loadTokens } from "./tokens.js";
import { createSwapUI } from "./ui.js";
import { getQuote, isQuoteExpired } from "./quote.js";

let currentQuote = null;
let tonConnectUI = null;
let walletIdentity = null;

let requestVersion = 0;
let quoteExpiryTimer = null;
let unsubscribeWallet = null;

// Transaction execution has not been implemented yet.
// Keep the UI's Swap button disabled.
const EXECUTION_ENABLED = false;

function clearExpiryTimer() {
  if (quoteExpiryTimer !== null) {
    clearTimeout(quoteExpiryTimer);
    quoteExpiryTimer = null;
  }
}

function invalidateQuote() {
  requestVersion += 1;
  currentQuote = null;

  clearExpiryTimer();
  ui.clearQuote();
}

const ui = createSwapUI({
  onPairChange() {
    invalidateQuote();
  },

  onAmountChange() {
    invalidateQuote();
  },

  onSlippageChange() {
    invalidateQuote();
  },

  async onQuote(state) {
    invalidateQuote();

    const version = requestVersion;
    const revision = ui.getRevision();

    try {
      const quote = await getQuote(state);

      // Ignore responses for an older trade or wallet session.
      if (
        version !== requestVersion ||
        revision !== ui.getRevision()
      ) {
        return;
      }

      if (isQuoteExpired(quote)) {
        throw new Error("Quote expired. Get a new quote.");
      }

      const accepted = ui.showQuote(quote.display, {
        expectedRevision: revision,
        expiresAt: quote.expiresAt
      });

      if (!accepted) return;

      currentQuote = quote;

      // ui.js handles the display expiry.
      // This timer also discards the stored quote.
      quoteExpiryTimer = setTimeout(() => {
        if (currentQuote === quote) {
          currentQuote = null;
        }

        quoteExpiryTimer = null;
      }, Math.max(0, quote.expiresAt - Date.now()));

      ui.setStatus(
        "Quote ready. Swap execution is not connected yet."
      );
    } catch (error) {
      if (
        version !== requestVersion ||
        revision !== ui.getRevision()
      ) {
        return;
      }

      currentQuote = null;
      clearExpiryTimer();

      // ui.js catches this and shows the message.
      throw error;
    }
  },

  async onSwap() {
    // Additional guard even if the button is enabled by mistake.
    throw new Error(
      "Swap execution is not connected yet. No transaction was sent."
    );
  }
});

function getWalletIdentity(wallet) {
  const account = wallet?.account;

  if (!account) return null;

  return `${account.chain}:${account.address}`;
}

function handleWalletChange(wallet) {
  const identity = getWalletIdentity(wallet);

  if (identity === walletIdentity) return;

  walletIdentity = identity;
  invalidateQuote();

  const account = wallet?.account;

  // UI readiness also requires an implemented transaction module.
  ui.setConnected(
    EXECUTION_ENABLED &&
    Boolean(account) &&
    account.chain === "-239"
  );

  if (!account) {
    ui.setStatus(
      "Wallet disconnected. You can still request a quote."
    );
    return;
  }

  if (account.chain !== "-239") {
    ui.setStatus(
      "Wallet connected to a different network. " +
      "This page requests TON mainnet quotes."
    );
    return;
  }

  ui.setStatus(
    "Wallet connected. You can request a quote. " +
    "Swap execution is not connected yet."
  );
}

async function initializeWallet() {
  const root = document.getElementById("wallet-connect");

  if (!root) {
    throw new Error("Missing wallet-connect element.");
  }

  // Resolve relative to this page, including subfolder hosting.
  const manifestUrl = new URL(
    "./tonconnect-manifest.json",
    window.location.href
  ).href;

  // Remove the disabled placeholder from index.html.
  root.replaceChildren();

  tonConnectUI = new TonConnectUI({
    manifestUrl,
    buttonRootId: "wallet-connect"
  });

  unsubscribeWallet = tonConnectUI.onStatusChange(
    handleWalletChange,
    (error) => {
      console.error("Wallet connection error:", error);

      invalidateQuote();
      walletIdentity = null;
      ui.setConnected(false);

      ui.setStatus(
        "Wallet connection failed. You can retry " +
        "using the Connect Wallet button."
      );
    }
  );

  await tonConnectUI.connectionRestored;

  handleWalletChange(tonConnectUI.wallet);
}

async function initializeTokens() {
  const tokens = await loadTokens();

  if (tokens.length === 0) {
    throw new Error("The token list is empty.");
  }

  ui.setTokens(tokens);
}

async function start() {
  ui.setBusy(true);
  ui.setStatus("Loading tokens and wallet connection…");

  const [tokensResult, walletResult] =
    await Promise.allSettled([
      initializeTokens(),
      initializeWallet()
    ]);

  ui.setBusy(false);

  if (tokensResult.status === "rejected") {
    console.error(
      "Token loading failed:",
      tokensResult.reason
    );
  }

  if (walletResult.status === "rejected") {
    console.error(
      "Wallet initialization failed:",
      walletResult.reason
    );
  }

  if (
    tokensResult.status === "rejected" &&
    walletResult.status === "rejected"
  ) {
    ui.setStatus(
      "Could not load tokens or initialize the wallet. " +
      "Check the configuration and reload the page."
    );
    return;
  }

  if (tokensResult.status === "rejected") {
    ui.setStatus(
      "Could not load tokens. Check the token API " +
      "configuration and reload the page."
    );
    return;
  }

  if (walletResult.status === "rejected") {
    ui.setStatus(
      "Tokens loaded. Wallet connection is unavailable, " +
      "but you can still request a quote."
    );
    return;
  }

  ui.setStatus(
    "Choose a token and enter an amount to get a quote. " +
    "Swap execution is not connected yet."
  );
}

// Re-check expiry after returning from another app or tab.
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    currentQuote &&
    isQuoteExpired(currentQuote)
  ) {
    invalidateQuote();
    ui.setStatus("Quote expired. Get a new quote.");
  }
});

// Do not tear down a page stored in the browser's back/forward cache.
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;

  clearExpiryTimer();

  if (typeof unsubscribeWallet === "function") {
    unsubscribeWallet();
  }
});

void start().catch((error) => {
  console.error("Application initialization failed:", error);

  ui.setBusy(false);
  ui.setStatus(
    "Could not initialize the application. " +
    "Check the configuration and reload the page."
  );
});
