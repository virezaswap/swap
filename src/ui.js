import { NATIVE_ASSET } from "./config.js";
import { sameToken, searchTokens } from "./tokens.js";

function required(id) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }

  return element;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function readSlippage(value) {
  const text = String(value).trim().replace(",", ".");

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Enter a percentage with up to 2 decimal places."
    );
  }

  const percentage = Number(text);

  // Website validation rule, matching quote.js.
  if (percentage <= 0 || percentage > 50) {
    throw new Error(
      "Enter a slippage tolerance above 0% and up to 50%."
    );
  }

  return String(percentage);
}

export function createSwapUI({
  onPairChange = () => {},
  onAmountChange = () => {},
  onSlippageChange = () => {},
  onQuote = () => {},
  onSwap = () => {}
} = {}) {
  const ids = [
    "swap-form",
    "pay-amount",
    "receive-amount",
    "pay-token-select",
    "receive-token-select",
    "pay-token-name",
    "receive-token-name",
    "pay-balance",
    "receive-balance",
    "pay-fiat",
    "receive-fiat",
    "reverse-pair",
    "quote-button",
    "swap-button",
    "swap-status",
    "quote-details",
    "quote-rate",
    "quote-minimum",
    "quote-price-impact",
    "quote-route",
    "token-dialog",
    "token-search",
    "token-list",
    "token-list-status",
    "settings-dialog",
    "settings-open",
    "slippage-open",
    "slippage-input",
    "slippage-value",
    "settings-form",
    "settings-save",
    "settings-error"
  ];

  const elements = Object.fromEntries(
    ids.map((id) => [id, required(id)])
  );

  const el = (id) => elements[id];

  let tokens = [];
  let payToken = { ...NATIVE_ASSET };
  let receiveToken = null;
  let selectedSide = "pay";
  let connected = false;
  let externalBusy = false;
  let actionRunning = false;
  let quoteReady = false;
  let slippage = "0.5";
  let revision = 0;
  let quoteTimer = null;

  function isBusy() {
    return externalBusy || actionRunning;
  }

  function getState() {
    return {
      payToken: { ...payToken },
      receiveToken: receiveToken
        ? { ...receiveToken }
        : null,
      amount: el("pay-amount").value,
      slippagePercent: slippage
    };
  }

  function setStatus(message) {
    el("swap-status").textContent = String(message);
  }

  function updateButtons() {
    const busy = isBusy();
    const validPair = Boolean(
      receiveToken && !sameToken(payToken, receiveToken)
    );

    el("pay-amount").disabled = busy;

    el("pay-token-select").disabled =
      busy || tokens.length === 0;

    el("receive-token-select").disabled =
      busy || tokens.length === 0;

    el("reverse-pair").disabled =
      busy || !receiveToken;

    el("quote-button").disabled =
      busy ||
      !validPair ||
      !el("pay-amount").value.trim();

    el("swap-button").disabled =
      busy ||
      !connected ||
      !quoteReady ||
      !validPair;

    el("settings-open").disabled = busy;
    el("slippage-open").disabled = busy;
    el("settings-save").disabled = busy;
    el("slippage-input").disabled = busy;

    el("swap-form").setAttribute(
      "aria-busy",
      String(busy)
    );

    for (const button of el("token-list").querySelectorAll(
      "button"
    )) {
      button.disabled = busy;
    }
  }

  function clearQuote() {
    if (quoteTimer !== null) {
      clearTimeout(quoteTimer);
      quoteTimer = null;
    }

    quoteReady = false;

    el("receive-amount").value = "";
    el("quote-details").hidden = true;
    el("pay-fiat").textContent = "—";
    el("receive-fiat").textContent = "—";

    for (const id of [
      "quote-rate",
      "quote-minimum",
      "quote-price-impact",
      "quote-route"
    ]) {
      el(id).textContent = "—";
    }

    updateButtons();
  }

  function invalidateTrade() {
    revision += 1;
    clearQuote();
  }

  function resetBalances() {
    el("pay-balance").textContent = "Balance: —";
    el("receive-balance").textContent = "Balance: —";
  }

  function renderSelector(side, token) {
    const button = el(`${side}-token-select`);

    const symbol = document.createElement("span");
    symbol.id = `${side}-token-symbol`;
    symbol.textContent = token?.symbol ?? "Select token";

    const arrow = document.createElement("span");
    arrow.textContent = "⌄";
    arrow.setAttribute("aria-hidden", "true");

    button.replaceChildren(symbol, arrow);
    button.title = token?.address ?? "Select token";

    el(`${side}-token-name`).textContent =
      token?.name ?? "Estimated output";
  }

  function renderPair() {
    renderSelector("pay", payToken);
    renderSelector("receive", receiveToken);
    resetBalances();
    updateButtons();
  }

  // Handles both synchronous and asynchronous callbacks.
  async function notify(callback, state, expectedRevision) {
    try {
      await callback(state);
    } catch (error) {
      console.error(error);

      // Do not replace a newer trade's status with an old error.
      if (expectedRevision !== revision) return;

      clearQuote();

      setStatus(
        error instanceof Error
          ? error.message
          : "The request could not be completed. Try again."
      );
    }
  }

  function notifyChange(callback) {
    void notify(callback, getState(), revision);
  }

  function chooseToken(token) {
    if (isBusy()) return;

    if (selectedSide === "pay") {
      if (sameToken(token, payToken)) {
        el("token-dialog").close();
        return;
      }

      if (sameToken(token, receiveToken)) {
        receiveToken = payToken;
      }

      payToken = token;
    } else {
      if (sameToken(token, receiveToken)) {
        el("token-dialog").close();
        return;
      }

      if (sameToken(token, payToken)) {
        if (!receiveToken) {
          el("token-list-status").textContent =
            "Choose a different token from the one you pay.";
          return;
        }

        payToken = receiveToken;
      }

      receiveToken = token;
    }

    // Avoid reusing an amount entered for a different token.
    el("pay-amount").value = "";

    invalidateTrade();
    el("token-dialog").close();
    renderPair();

    setStatus("Pair updated. Enter an amount.");
    notifyChange(onPairChange);
  }

  function renderTokenList() {
    const matches = searchTokens(
      tokens,
      el("token-search").value
    );

    const visible = matches.slice(0, 100);
    const fragment = document.createDocumentFragment();

    for (const token of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "token-list-item";
      button.disabled = isBusy();

      const info = document.createElement("span");
      info.className = "token-list-info";

      const symbol = document.createElement("span");
      symbol.className = "token-list-symbol";
      symbol.textContent = token.symbol;

      const name = document.createElement("span");
      name.className = "token-list-name";
      name.textContent =
        `${token.name} · ${shortAddress(token.address)}`;
      name.title = token.address;

      info.append(symbol, name);
      button.append(info);

      button.addEventListener("click", () => {
        chooseToken(token);
      });

      fragment.append(button);
    }

    el("token-list").replaceChildren(fragment);

    if (matches.length === 0) {
      el("token-list-status").textContent =
        "No matching tokens.";
    } else if (matches.length > visible.length) {
      el("token-list-status").textContent =
        `Showing ${visible.length} of ${matches.length} ` +
        "matches. Refine your search.";
    } else {
      el("token-list-status").textContent =
        `${matches.length} tokens. Route availability ` +
        "is checked when quoting.";
    }
  }

  function openPicker(side) {
    if (isBusy() || tokens.length === 0) return;

    selectedSide = side;
    el("token-search").value = "";
    renderTokenList();

    if (!el("token-dialog").open) {
      el("token-dialog").showModal();
    }

    el("token-search").focus();
  }

  function openSettings() {
    if (isBusy()) return;

    el("slippage-input").value = slippage;
    el("settings-error").textContent = "";

    if (!el("settings-dialog").open) {
      el("settings-dialog").showModal();
    }

    el("slippage-input").focus();
  }

  async function runAction(callback, { quoting = false } = {}) {
    if (isBusy()) return;

    const state = getState();
    const expectedRevision = revision;

    actionRunning = true;

    if (quoting) {
      clearQuote();
      setStatus("Getting quote…");
    }

    updateButtons();

    try {
      await notify(callback, state, expectedRevision);
    } finally {
      actionRunning = false;
      updateButtons();
    }
  }

  function showQuote(
    {
      receiveAmount,
      rate = "—",
      minimum = "—",
      priceImpact = "Unavailable",
      route = "STON.fi"
    },
    { expectedRevision, expiresAt } = {}
  ) {
    // main.js can pass the revision captured before its request.
    if (
      expectedRevision !== undefined &&
      expectedRevision !== revision
    ) {
      return false;
    }

    if (
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    ) {
      clearQuote();
      setStatus("Quote expired. Get a new quote.");
      return false;
    }

    if (
      receiveAmount === undefined ||
      receiveAmount === null ||
      String(receiveAmount).trim() === ""
    ) {
      throw new Error("The quote contains no output amount.");
    }

    clearQuote();

    el("receive-amount").value = String(receiveAmount);
    el("quote-rate").textContent = String(rate);
    el("quote-minimum").textContent = String(minimum);
    el("quote-price-impact").textContent = String(priceImpact);
    el("quote-route").textContent = String(route);
    el("quote-details").hidden = false;

    quoteReady = true;

    if (expiresAt !== undefined) {
      const quoteRevision = revision;

      quoteTimer = setTimeout(() => {
        if (quoteRevision !== revision) return;

        clearQuote();
        setStatus("Quote expired. Get a new quote.");
      }, expiresAt - Date.now());
    }

    setStatus(
      connected
        ? "Quote ready."
        : "Quote ready. Connect your wallet to continue."
    );

    updateButtons();
    return true;
  }

  el("pay-token-select").addEventListener("click", () => {
    openPicker("pay");
  });

  el("receive-token-select").addEventListener("click", () => {
    openPicker("receive");
  });

  el("token-search").addEventListener(
    "input",
    renderTokenList
  );

  el("reverse-pair").addEventListener("click", () => {
    if (isBusy() || !receiveToken) return;

    [payToken, receiveToken] = [receiveToken, payToken];
    el("pay-amount").value = "";

    invalidateTrade();
    renderPair();

    setStatus("Pair reversed. Enter an amount.");
    notifyChange(onPairChange);
  });

  el("pay-amount").addEventListener("input", () => {
    invalidateTrade();
    setStatus("Amount updated. Get a new quote.");
    notifyChange(onAmountChange);
  });

  el("settings-open").addEventListener(
    "click",
    openSettings
  );

  el("slippage-open").addEventListener(
    "click",
    openSettings
  );

  el("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();

    if (isBusy()) return;

    try {
      const nextSlippage = readSlippage(
        el("slippage-input").value
      );

      el("settings-error").textContent = "";
      el("settings-dialog").close();

      if (nextSlippage === slippage) return;

      slippage = nextSlippage;
      el("slippage-value").textContent = `${slippage}%`;

      invalidateTrade();
      setStatus("Settings updated. Get a new quote.");
      notifyChange(onSlippageChange);
    } catch (error) {
      el("settings-error").textContent =
        error instanceof Error
          ? error.message
          : "Invalid slippage tolerance.";
    }
  });

  el("quote-button").addEventListener("click", () => {
    if (el("quote-button").disabled) return;

    void runAction(onQuote, { quoting: true });
  });

  el("swap-form").addEventListener("submit", (event) => {
    event.preventDefault();

    if (el("swap-button").disabled) return;

    void runAction(onSwap);
  });

  // Prevent accidental form submission in the token picker.
  el("token-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });

  renderPair();

  return {
    getState,
    setStatus,
    clearQuote,
    showQuote,

    getRevision() {
      return revision;
    },

    setTokens(nextTokens) {
      tokens = [...nextTokens];
      renderTokenList();
      updateButtons();
    },

    // Call on every wallet/account change, not only connect.
    setConnected(value) {
      connected = Boolean(value);

      invalidateTrade();
      resetBalances();

      setStatus(
        connected
          ? "Wallet connected. Get a new quote."
          : "Wallet disconnected. You can still request a quote."
      );
    },

    setBusy(value) {
      externalBusy = Boolean(value);
      updateButtons();
    },

    setBalances({ pay = "—", receive = "—" } = {}) {
      el("pay-balance").textContent = `Balance: ${pay}`;
      el("receive-balance").textContent =
        `Balance: ${receive}`;
    }
  };
    }
