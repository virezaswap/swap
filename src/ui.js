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

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error("Enter a percentage with up to 2 decimal places.");
  }

  const percentage = Number(text);

  if (percentage <= 0 || percentage > 50) {
    throw new Error("Enter a slippage tolerance above 0% and up to 50%.");
  }

  // This is a website validation limit, not a protocol limit.
  return String(percentage);
}

export function createSwapUI({
  onPairChange = () => {},
  onAmountChange = () => {},
  onSlippageChange = () => {},
  onQuote = () => {},
  onSwap = () => {}
} = {}) {
  const elements = Object.fromEntries([
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
  ].map((id) => [id, required(id)]));

  const el = (id) => elements[id];

  let tokens = [];
  let payToken = { ...NATIVE_ASSET };
  let receiveToken = null;
  let selectedSide = "pay";
  let connected = false;
  let busy = false;
  let quoteReady = false;
  let slippage = "0.5";

  function getState() {
    return {
      payToken: { ...payToken },
      receiveToken: receiveToken ? { ...receiveToken } : null,
      amount: el("pay-amount").value,
      slippagePercent: slippage
    };
  }

  function setStatus(message) {
    el("swap-status").textContent = message;
  }

  function updateButtons() {
    const validPair =
      receiveToken && !sameToken(payToken, receiveToken);

    el("pay-amount").disabled = busy;
    el("pay-token-select").disabled = busy || tokens.length === 0;
    el("receive-token-select").disabled = busy || tokens.length === 0;
    el("reverse-pair").disabled = busy || !receiveToken;
    el("quote-button").disabled =
      busy || !validPair || !el("pay-amount").value.trim();

    el("swap-button").disabled =
      busy || !connected || !quoteReady || !validPair;

    el("settings-open").disabled = busy;
    el("slippage-open").disabled = busy;
    el("settings-save").disabled = busy;
  }

  function clearQuote() {
    quoteReady = false;
    el("receive-amount").value = "";
    el("quote-details").hidden = true;
    el("pay-fiat").textContent = "—";
    el("receive-fiat").textContent = "—";
    updateButtons();
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

    el(`${side}-token-name`).textContent =
      token?.name ?? "Estimated output";

    button.title = token?.address ?? "Select token";
  }

  function renderPair() {
    renderSelector("pay", payToken);
    renderSelector("receive", receiveToken);

    // Balances are unknown until the wallet integration supplies them.
    el("pay-balance").textContent = "Balance: —";
    el("receive-balance").textContent = "Balance: —";

    clearQuote();
  }

  function chooseToken(token) {
    if (busy) return;

    if (selectedSide === "pay") {
      if (sameToken(token, receiveToken)) {
        receiveToken = payToken;
      }

      payToken = token;
    } else {
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

    el("token-dialog").close();
    renderPair();
    setStatus("Pair updated. Get a new quote.");
    onPairChange(getState());
  }

  function renderTokenList() {
    const matches = searchTokens(
      tokens,
      el("token-search").value
    );

    // Limit rendered rows to keep the picker responsive.
    const visible = matches.slice(0, 100);
    const fragment = document.createDocumentFragment();

    for (const token of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "token-list-item";

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
      button.addEventListener("click", () => chooseToken(token));
      fragment.append(button);
    }

    el("token-list").replaceChildren(fragment);

    el("token-list-status").textContent =
      matches.length === 0
        ? "No matching tokens."
        : matches.length > visible.length
          ? `Showing ${visible.length} of ${matches.length} matches. Refine your search.`
          : `${matches.length} tokens. Route availability is checked when quoting.`;
  }

  function openPicker(side) {
    selectedSide = side;
    el("token-search").value = "";
    renderTokenList();
    el("token-dialog").showModal();
    el("token-search").focus();
  }

  function openSettings() {
    el("slippage-input").value = slippage;
    el("settings-error").textContent = "";
    el("settings-dialog").showModal();
    el("slippage-input").focus();
  }

  // Async callback failures are handled without leaving an
  // unhandled promise rejection in the browser.
  async function run(callback) {
    try {
      await callback(getState());
    } catch (error) {
      console.error(error);
      setStatus("The request could not be completed. Try again.");
    }
  }

  el("pay-token-select").addEventListener(
    "click",
    () => openPicker("pay")
  );

  el("receive-token-select").addEventListener(
    "click",
    () => openPicker("receive")
  );

  el("token-search").addEventListener("input", renderTokenList);

  el("reverse-pair").addEventListener("click", () => {
    if (busy || !receiveToken) return;

    [payToken, receiveToken] = [receiveToken, payToken];
    el("pay-amount").value = "";

    renderPair();
    setStatus("Pair reversed. Enter an amount.");
    onPairChange(getState());
  });

  el("pay-amount").addEventListener("input", () => {
    clearQuote();
    onAmountChange(getState());
  });

  el("settings-open").addEventListener("click", openSettings);
  el("slippage-open").addEventListener("click", openSettings);

  el("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;

    try {
      slippage = readSlippage(el("slippage-input").value);
      el("slippage-value").textContent = `${slippage}%`;
      el("settings-error").textContent = "";
      el("settings-dialog").close();

      clearQuote();
      setStatus("Settings updated. Get a new quote.");
      onSlippageChange(getState());
    } catch (error) {
      el("settings-error").textContent = error.message;
    }
  });

  el("quote-button").addEventListener("click", () => {
    if (!el("quote-button").disabled) void run(onQuote);
  });

  el("swap-form").addEventListener("submit", (event) => {
    event.preventDefault();

    if (!el("swap-button").disabled) void run(onSwap);
  });

  renderPair();

  return {
    getState,
    setStatus,
    clearQuote,

    setTokens(nextTokens) {
      tokens = [...nextTokens];
      renderTokenList();
      updateButtons();
    },

    setConnected(value) {
      connected = Boolean(value);
      clearQuote();

      el("pay-balance").textContent = "Balance: —";
      el("receive-balance").textContent = "Balance: —";
    },

    setBusy(value) {
      busy = Boolean(value);
      updateButtons();
    },

    setBalances({ pay = "—", receive = "—" } = {}) {
      el("pay-balance").textContent = `Balance: ${pay}`;
      el("receive-balance").textContent = `Balance: ${receive}`;
    },

    showQuote({
      receiveAmount,
      rate = "—",
      minimum = "—",
      priceImpact = "—",
      route = "—"
    }) {
      el("receive-amount").value = String(receiveAmount);
      el("quote-rate").textContent = rate;
      el("quote-minimum").textContent = minimum;
      el("quote-price-impact").textContent = priceImpact;
      el("quote-route").textContent = route;
      el("quote-details").hidden = false;

      quoteReady = true;
      updateButtons();
    }
  };
    }
