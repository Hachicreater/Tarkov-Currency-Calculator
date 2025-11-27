const statusEl = document.getElementById('status');
const ratesTextEl = document.getElementById('ratesText');
const lastUpdatedEl = document.getElementById('lastUpdated');
const loadingOverlay = document.getElementById('loadingOverlay');

const rubInput = document.getElementById('rubInput');
const usdInput = document.getElementById('usdInput');
const eurInput = document.getElementById('eurInput');

const usdRateInput = document.getElementById('usdRateInput');
const eurRateInput = document.getElementById('eurRateInput');

const itemNameInput = document.getElementById('itemNameInput');
const itemSearchBtn = document.getElementById('itemSearchBtn');
const itemResultEl  = document.getElementById('itemResult');
const itemSuggestionsEl = document.getElementById('itemSuggestions');

let rubPerUsd = null;
let rubPerEur = null;
let isUpdating = false;

const RUB_ID = "5449016a4bdc2d6f028b456f";
const EUR_ID = "569668774bdc2da2298b4568";
const USD_ID = "5696686a4bdc2da3298b456a";

let rateConfig = {
  usd: { offset: 0, override: null },
  eur: { offset: 0, override: null }
};

let traderList = [];
let suggestTimer = null;
let lastSuggestQuery = "";
let lastSuggestions = [];

// ---------- 設定ファイル & トレーダー情報 ----------

async function loadRateConfig() {
  try {
    // ./config/rates-config.json から読み込む
    const res = await fetch('config/rates-config.json');
    if (!res.ok) {
      console.warn('rates-config.json not found, using defaults.');
      return;
    }
    const json = await res.json();
    rateConfig = {
      usd: { offset: 0, override: null, ...(json.usd || {}) },
      eur: { offset: 0, override: null, ...(json.eur || {}) },
    };
  } catch (e) {
    console.warn('Failed to load rates-config.json, using defaults.', e);
  }
}

async function loadTraders() {
  try {
    const query = `
      query Traders {
        traders {
          name
          normalizedName
          imageLink
        }
      }
    `;
    const res = await fetch("https://api.tarkov.dev/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error("GraphQL error (traders)");
    traderList = json.data.traders || [];
  } catch (e) {
    console.warn("Failed to load traders.", e);
    traderList = [];
  }
}

// ---------- 通貨レート取得 ----------

function getRubPriceFromBuyFor(item, preferredSource) {
  if (!item.buyFor || !Array.isArray(item.buyFor)) {
    throw new Error("buyFor not found for item " + (item.name || item.id));
  }

  let offer = null;
  if (preferredSource) {
    const p = preferredSource.toLowerCase();
    offer = item.buyFor.find(
      o =>
        o.currency === "RUB" &&
        typeof o.source === "string" &&
        o.source.toLowerCase().includes(p)
    );
  }
  if (!offer) {
    offer = item.buyFor.find(
      o =>
        o.currency === "RUB" &&
        o.source &&
        !/flea/i.test(o.source)
    );
  }
  if (!offer) offer = item.buyFor.find(o => o.currency === "RUB");
  if (!offer) offer = item.buyFor[0];
  if (!offer) throw new Error("No buy offer found for " + (item.name || item.id));

  const price = offer.priceRUB ?? offer.price;
  if (!price || price <= 0) throw new Error("Invalid price for " + (item.name || item.id));
  return price;
}

function applyConfigToRate(rawRate, cfg) {
  if (!cfg) return rawRate;
  if (cfg.override !== null && cfg.override !== undefined) {
    return Number(cfg.override);
  }
  const offset = Number(cfg.offset || 0);
  return rawRate + offset;
}

function renderRatesText() {
  if (rubPerUsd == null || rubPerEur == null) {
    ratesTextEl.textContent = "Loading...";
    return;
  }
  const usdDisplay = rubPerUsd.toLocaleString();
  const eurDisplay = rubPerEur.toLocaleString();
  ratesTextEl.innerHTML =
    `1 USD ≒ ${usdDisplay} RUB<br>` +
    `1 EUR ≒ ${eurDisplay} RUB<br><br>` +
    `<span style="font-size:12px;">(Peacekeeper = USD, Skier = EUR の買取価格を基準に、オフセット/手動設定を反映しています)</span>`;
}

function onRateChanged() {
  renderRatesText();
  if (rubInput.value !== "")      updateFrom("RUB");
  else if (usdInput.value !== "") updateFrom("USD");
  else if (eurInput.value !== "") updateFrom("EUR");
}

async function fetchRates() {
  await loadRateConfig();
  await loadTraders();

  const query = `
    query MoneyTraderPrices {
      items(ids: [
        "${USD_ID}",
        "${EUR_ID}"
      ]) {
        id
        name
        buyFor {
          source
          price
          priceRUB
          currency
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.tarkov.dev/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });

    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json();
    if (json.errors) throw new Error("GraphQL error");

    const items = json.data.items || [];
    const usdItem = items.find(i => i.id === USD_ID);
    const eurItem = items.find(i => i.id === EUR_ID);
    if (!usdItem || !eurItem) throw new Error("Currency items not found.");

    const rawUsd = getRubPriceFromBuyFor(usdItem, "peacekeeper");
    const rawEur = getRubPriceFromBuyFor(eurItem, "skier");

    rubPerUsd = applyConfigToRate(rawUsd, rateConfig.usd);
    rubPerEur = applyConfigToRate(rawEur, rateConfig.eur);

    usdRateInput.value = rubPerUsd.toFixed(2);
    eurRateInput.value = rubPerEur.toFixed(2);
    usdRateInput.disabled = false;
    eurRateInput.disabled = false;

    statusEl.textContent = "API から最新レートを取得しました。";
    statusEl.classList.remove("error");
    statusEl.classList.add("success");

    renderRatesText();

    const now = new Date();
    lastUpdatedEl.textContent =
      "更新日時：" + now.toLocaleString() + "（お使いの端末時刻）";

    rubInput.disabled = false;
    usdInput.disabled = false;
    eurInput.disabled = false;

  } catch (err) {
    console.error(err);
    statusEl.textContent = "レートの取得に失敗しました。";
    statusEl.classList.add("error");
    ratesTextEl.textContent =
      "レートを読み込めませんでした。時間をおいて再度アクセスしてください。\n" +
      (err.message ? " (" + err.message + ")" : "");

    lastUpdatedEl.textContent = "";
    rubInput.disabled = true;
    usdInput.disabled = true;
    eurInput.disabled = true;
    usdRateInput.disabled = true;
    eurRateInput.disabled = true;
  }
}

// ---------- 通貨計算 ----------

function parseValue(value) {
  if (value === "" || value === null) return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

function format(value) {
  if (value === null) return "";
  return value.toFixed(2);
}

function updateFrom(source) {
  if (rubPerUsd == null || rubPerEur == null) return;
  if (isUpdating) return;
  isUpdating = true;

  const rubVal = parseValue(rubInput.value);
  const usdVal = parseValue(usdInput.value);
  const eurVal = parseValue(eurInput.value);

  let rub, usd, eur;

  if (source === "RUB" && rubVal !== null) {
    rub = rubVal;
    usd = rub / rubPerUsd;
    eur = rub / rubPerEur;
  } else if (source === "USD" && usdVal !== null) {
    usd = usdVal;
    rub = usd * rubPerUsd;
    eur = rub / rubPerEur;
  } else if (source === "EUR" && eurVal !== null) {
    eur = eurVal;
    rub = eur * rubPerEur;
    usd = rub / rubPerUsd;
  } else {
    rub = usd = eur = null;
  }

  if (source !== "RUB") rubInput.value = format(rub);
  if (source !== "USD") usdInput.value = format(usd);
  if (source !== "EUR") eurInput.value = format(eur);

  isUpdating = false;
}

// ---------- アイテム価格検索 ----------

function findBestTraderOffer(item) {
  if (!item.sellFor || !Array.isArray(item.sellFor) || item.sellFor.length === 0) {
    return null;
  }

  const offers = item.sellFor
    .filter(o =>
      o.currency === "RUB" &&
      o.source &&
      !/flea/i.test(o.source)
    )
    .map(o => ({
      source: o.source,
      priceRUB: o.priceRUB ?? o.price
    }))
    .filter(o => o.priceRUB && o.priceRUB > 0);

  if (offers.length === 0) return null;

  let best = offers[0];
  for (const o of offers) {
    if (o.priceRUB > best.priceRUB) best = o;
  }
  return best;
}

async function searchItemPrice() {
  const name = itemNameInput.value.trim();
  if (!name) {
    itemResultEl.innerHTML = "アイテム名を英語で入力してください。";
    return;
  }

  clearSuggestions();
  itemResultEl.innerHTML = "検索中です…";

  const query = `
    query ItemPrice($name: String!) {
      items(name: $name) {
        id
        name
        shortName
        iconLink
        sellFor {
          source
          price
          priceRUB
          currency
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.tarkov.dev/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { name } })
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error("GraphQL error (items)");

    const items = json.data.items || [];
    if (items.length === 0) {
      itemResultEl.innerHTML =
        `「${name}」に該当するアイテムが見つかりませんでした。<br>` +
        `英語表記で入力されているか確認してください。`;
      return;
    }

    const item = items[0];
    const best = findBestTraderOffer(item);

    if (!best) {
      itemResultEl.innerHTML =
        `アイテム：${item.name}<br>トレーダー買取情報が見つかりませんでした。`;
      return;
    }

    const trader =
      traderList.find(t => t.name === best.source) ||
      traderList.find(t =>
        t.normalizedName &&
        t.normalizedName.toLowerCase() === best.source.toLowerCase()
      );

    const traderName = trader ? trader.name : best.source;
    const traderImg  = trader && trader.imageLink ? trader.imageLink : null;

    let usdLine = "";
    let eurLine = "";
    if (rubPerUsd && rubPerUsd > 0) {
      const usd = best.priceRUB / rubPerUsd;
      usdLine = `約 ${usd.toFixed(2)} USD`;
    }
    if (rubPerEur && rubPerEur > 0) {
      const eur = best.priceRUB / rubPerEur;
      eurLine = `約 ${eur.toFixed(2)} EUR`;
    }

    const priceRub = `${best.priceRUB.toLocaleString()} RUB`;
    let priceText = priceRub;
    if (usdLine || eurLine) {
      priceText += `<br><span style="font-size:12px;">${[
        usdLine, eurLine
      ].filter(Boolean).join(" / ")}</span>`;
    }

    itemResultEl.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:8px;">
        ${item.iconLink
          ? `<img src="${item.iconLink}" alt="" style="width:48px;height:48px;border-radius:8px;object-fit:cover;">`
          : ""}
        <div>
          <div style="font-size:14px;color:#e5e7eb;">${item.name}</div>
          <div style="font-size:12px;color:#9ca3af;">ID: ${item.id}</div>
        </div>
      </div>

      <div style="display:flex; gap:10px; align-items:center; margin-bottom:6px;">
        ${traderImg
          ? `<img src="${traderImg}" alt="${traderName}"
               style="width:40px;height:40px;border-radius:999px;object-fit:cover;">`
          : ""}
        <div>
          <div style="font-size:13px;color:#a7f3d0;">最も高く買い取るトレーダー</div>
          <div style="font-size:15px;color:#e5e7eb;font-weight:600;">${traderName}</div>
        </div>
      </div>

      <div style="font-size:13px;color:#9ca3af;margin-top:4px;">
        買取価格：<span style="font-size:15px;color:#f9fafb;font-weight:600;">${priceText}</span>
      </div>
    `;
  } catch (e) {
    console.error(e);
    itemResultEl.innerHTML =
      "アイテム情報の取得に失敗しました。時間をおいて再度お試しください。";
  }
}

// ---------- サジェスト ----------

function clearSuggestions() {
  itemSuggestionsEl.style.display = "none";
  itemSuggestionsEl.innerHTML = "";
}

function showSuggestions(items) {
  itemSuggestionsEl.innerHTML = "";
  if (!items || items.length === 0) {
    const helper = document.createElement("div");
    helper.className = "suggestion-item helper";
    helper.innerHTML = `<span class="short">候補が見つかりません。英語表記で入力してください。</span>`;
    itemSuggestionsEl.appendChild(helper);
    itemSuggestionsEl.style.display = "block";
    return;
  }
  items.slice(0, 10).forEach(it => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.innerHTML = `
      <span class="name">${it.name}</span>
      ${it.shortName && it.shortName !== it.name
        ? `<span class="short">${it.shortName}</span>`
        : ""}
    `;
    div.addEventListener("click", () => {
      itemNameInput.value = it.shortName || it.name;
      clearSuggestions();
      searchItemPrice();
    });
    itemSuggestionsEl.appendChild(div);
  });
  itemSuggestionsEl.style.display = "block";
}

async function fetchItemSuggestions(queryText) {
  const query = `
    query ItemSuggest($name: String!) {
      items(name: $name) {
        id
        name
        shortName
      }
    }
  `;
  try {
    const res = await fetch("https://api.tarkov.dev/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { name: queryText } })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error("GraphQL error (suggest)");
    const items = json.data.items || [];
    lastSuggestions = items;
    showSuggestions(items);
  } catch (e) {
    console.warn("Failed to fetch suggestions", e);
    clearSuggestions();
  }
}

// ---------- イベント設定 ----------

rubInput.addEventListener("input", () => updateFrom("RUB"));
usdInput.addEventListener("input", () => updateFrom("USD"));
eurInput.addEventListener("input", () => updateFrom("EUR"));

usdRateInput.addEventListener("input", () => {
  const v = parseFloat(usdRateInput.value);
  if (!isNaN(v) && v > 0) {
    rubPerUsd = v;
    onRateChanged();
  }
});

eurRateInput.addEventListener("input", () => {
  const v = parseFloat(eurRateInput.value);
  if (!isNaN(v) && v > 0) {
    rubPerEur = v;
    onRateChanged();
  }
});

itemSearchBtn.addEventListener("click", searchItemPrice);

itemNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchItemPrice();
});

itemNameInput.addEventListener("input", () => {
  const q = itemNameInput.value.trim();
  if (q.length < 2) {
    itemSuggestionsEl.innerHTML = "";
    const helper = document.createElement("div");
    helper.className = "suggestion-item helper";
    helper.innerHTML = `<span class="short">2文字以上入力すると候補が表示されます。（英語表記）</span>`;
    itemSuggestionsEl.appendChild(helper);
    itemSuggestionsEl.style.display = "block";
    return;
  }
  if (q === lastSuggestQuery) return;
  lastSuggestQuery = q;
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => {
    fetchItemSuggestions(q);
  }, 300);
});

itemNameInput.addEventListener("focus", () => {
  const q = itemNameInput.value.trim();
  if (q.length >= 2) {
    if (lastSuggestions.length > 0 && q === lastSuggestQuery) {
      showSuggestions(lastSuggestions);
    } else {
      fetchItemSuggestions(q);
    }
  } else {
    itemSuggestionsEl.innerHTML = "";
    const helper = document.createElement("div");
    helper.className = "suggestion-item helper";
    helper.innerHTML = `<span class="short">2文字以上入力すると候補が表示されます。（英語表記）</span>`;
    itemSuggestionsEl.appendChild(helper);
    itemSuggestionsEl.style.display = "block";
  }
});

itemNameInput.addEventListener("blur", () => {
  setTimeout(clearSuggestions, 200);
});

// ---------- 初期化 ----------

(async () => {
  await fetchRates();
  if (loadingOverlay) loadingOverlay.style.display = "none";
})();
