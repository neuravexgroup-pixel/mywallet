/* =========================================================
   MyWallet — fully offline, local-only personal finance app
   All data lives in this browser's localStorage. Nothing is
   ever sent over the network.
   ========================================================= */

const STORAGE_KEY = "mywallet_state_v1";
const $ = (id) => document.getElementById(id);

const WALLET_TYPES = {
  bank: { label: "Bank", icon: "🏦", color: "#7C3AED" },
  momo: { label: "Mobile Money", icon: "📱", color: "#EC4899" },
  cash: { label: "Cash", icon: "💵", color: "#16A34A" },
  other: { label: "Other", icon: "👛", color: "#6366F1" }
};

const DEFAULT_CATEGORIES = {
  expense: [
    { name: "Food", emoji: "🍲" }, { name: "Transport", emoji: "🚌" },
    { name: "Airtime & Data", emoji: "📶" }, { name: "Bills", emoji: "🧾" },
    { name: "Rent", emoji: "🏠" }, { name: "Shopping", emoji: "🛍️" },
    { name: "Health", emoji: "💊" }, { name: "Education", emoji: "📚" },
    { name: "Entertainment", emoji: "🎬" }, { name: "Other", emoji: "•••" }
  ],
  income: [
    { name: "Salary", emoji: "💼" }, { name: "Business", emoji: "📈" },
    { name: "Gift", emoji: "🎁" }, { name: "Transfer", emoji: "🔁" },
    { name: "Other", emoji: "•••" }
  ]
};

const CATEGORY_COLORS = ["#7C3AED", "#EC4899", "#F59E0B", "#16A34A", "#0EA5E9", "#EF4444", "#8B5CF6", "#14B8A6", "#F97316", "#6366F1"];

/* ---------------- state ---------------- */
function defaultState() {
  return {
    profile: { name: "" },
    pinHash: null,
    pinSalt: null,
    autoLock: "immediate", // immediate | 1min | 5min
    wallets: [
      { id: uid(), name: "BK Bank", type: "bank", balance: 0 },
      { id: uid(), name: "MoMo", type: "momo", balance: 0 },
      { id: uid(), name: "Cash", type: "cash", balance: 0 }
    ],
    transactions: [],
    goals: [],
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES))
  };
}

let state = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function formatMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString("en-US");
}
function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function formatDateGroup(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/* ---------------- PIN / security ---------------- */
async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSalt() {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPin(pin, salt) { return sha256Hex(salt + ":" + pin); }

/* ---------------- toast ---------------- */
function toast(msg) {
  const root = $("toastRoot");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

/* ---------------- boot ---------------- */
let currentTab = "home";
let statsMonthOffset = 0; // 0 = current month
let activityFilter = "all";
let activitySearchText = "";
let pendingTxType = "expense";

window.addEventListener("DOMContentLoaded", () => {
  registerSW();
  state = loadState();
  if (!state) {
    showSetup();
  } else {
    showLock(false);
  }
  bindStaticEvents();
});

function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

/* ---------------- SETUP FLOW ---------------- */
let setupStep = 1; // 1 = name+pin, 2 = confirm pin
function showSetup() {
  $("setupScreen").classList.remove("hidden");
  $("lockScreen").classList.add("hidden");
  $("mainApp").classList.add("hidden");
  $("pinConfirmField").classList.add("hidden");
  $("nameField").classList.remove("hidden");
  $("pinField").classList.remove("hidden");
  $("setupTitle").textContent = "Let's set you up";
  $("setupSub").textContent = "Your name, and a PIN to keep your money private.";
  $("setupContinueBtn").textContent = "Continue";
  $("setupError").textContent = "";
  setupStep = 1;
}

function bindStaticEvents() {
  $("setupContinueBtn").addEventListener("click", onSetupContinue);

  // tab bar
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("btnGoProfileFromHome").addEventListener("click", () => switchTab("profile"));
  $("btnSeeAllActivity").addEventListener("click", () => switchTab("activity"));
  $("btnGoWalletsManage").addEventListener("click", openManageWallets);
  $("btnQuickIncome").addEventListener("click", () => openTxSheet("income"));
  $("btnQuickExpense").addEventListener("click", () => openTxSheet("expense"));
  $("fabAdd").addEventListener("click", () => {
    if (currentTab === "goals") openGoalSheet();
    else openTxSheet(pendingTxType);
  });

  $("activitySearch").addEventListener("input", (e) => {
    activitySearchText = e.target.value.toLowerCase();
    renderActivity();
  });

  $("btnPrevMonth").addEventListener("click", () => { statsMonthOffset--; renderStats(); });
  $("btnNextMonth").addEventListener("click", () => { if (statsMonthOffset < 0) { statsMonthOffset++; renderStats(); } });

  $("rowEditName").addEventListener("click", openEditName);
  $("rowManageWallets").addEventListener("click", openManageWallets);
  $("rowManageCategories").addEventListener("click", openManageCategories);
  $("rowChangePin").addEventListener("click", openChangePin);
  $("rowAutoLock").addEventListener("click", openAutoLockPicker);
  $("rowExport").addEventListener("click", exportBackup);
  $("rowImport").addEventListener("click", importBackup);
  $("rowLockNow").addEventListener("click", () => showLock(false));
  $("rowResetData").addEventListener("click", eraseAllData);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.__hiddenAt = Date.now();
    } else if (state && window.__hiddenAt && !$("mainApp").classList.contains("hidden")) {
      const elapsed = Date.now() - window.__hiddenAt;
      const limit = state.autoLock === "5min" ? 300000 : state.autoLock === "1min" ? 60000 : 0;
      if (elapsed >= limit) showLock(false);
    }
  });
}

async function onSetupContinue() {
  $("setupError").textContent = "";
  if (setupStep === 1) {
    const name = $("setupName").value.trim();
    const pin = $("setupPin").value.trim();
    if (!name) { $("setupError").textContent = "Please enter your name."; return; }
    if (!/^\d{4}$/.test(pin)) { $("setupError").textContent = "PIN must be exactly 4 digits."; return; }
    window.__setupName = name;
    window.__setupPin = pin;
    setupStep = 2;
    $("nameField").classList.add("hidden");
    $("pinField").classList.add("hidden");
    $("pinConfirmField").classList.remove("hidden");
    $("setupTitle").textContent = "Confirm your PIN";
    $("setupSub").textContent = "Enter it once more so we know it's right.";
    $("setupPinConfirm").focus();
    return;
  }
  // step 2
  const confirm = $("setupPinConfirm").value.trim();
  if (confirm !== window.__setupPin) {
    $("setupError").textContent = "PINs don't match. Try again.";
    $("setupPinConfirm").value = "";
    return;
  }
  const salt = randomSalt();
  const hash = await hashPin(window.__setupPin, salt);
  state = defaultState();
  state.profile.name = window.__setupName;
  state.pinSalt = salt;
  state.pinHash = hash;
  saveState();
  enterApp();
}

/* ---------------- LOCK SCREEN ---------------- */
let pinBuffer = "";
function showLock(isSetupJustFinished) {
  $("setupScreen").classList.add("hidden");
  $("mainApp").classList.add("hidden");
  $("lockScreen").classList.remove("hidden");
  $("lockGreeting").textContent = state && state.profile.name ? `Hi, ${state.profile.name}` : "Welcome back";
  pinBuffer = "";
  renderPinDots();
  $("lockError").textContent = "";
  buildKeypad();
}

function renderPinDots() {
  const wrap = $("pinDots");
  wrap.innerHTML = "";
  const target = 4;
  for (let i = 0; i < Math.max(target, pinBuffer.length); i++) {
    const dot = document.createElement("div");
    dot.className = "pin-dot" + (i < pinBuffer.length ? " filled" : "");
    wrap.appendChild(dot);
  }
}

function buildKeypad() {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  const wrap = $("keypad");
  wrap.innerHTML = "";
  keys.forEach((k) => {
    const btn = document.createElement("button");
    if (k === "") { btn.className = "ghost"; btn.disabled = true; }
    else {
      btn.textContent = k;
      btn.addEventListener("click", () => onKeypadPress(k));
    }
    wrap.appendChild(btn);
  });
}

async function onKeypadPress(k) {
  if (k === "⌫") { pinBuffer = pinBuffer.slice(0, -1); renderPinDots(); return; }
  if (pinBuffer.length >= 4) return;
  pinBuffer += k;
  renderPinDots();
  if (pinBuffer.length === 4) {
    const hash = await hashPin(pinBuffer, state.pinSalt);
    if (hash === state.pinHash) enterApp();
    else showLockError();
  }
}

function showLockError() {
  $("lockError").textContent = "Incorrect PIN. Try again.";
  document.querySelectorAll(".pin-dot").forEach((d) => d.classList.add("error"));
  setTimeout(() => { pinBuffer = ""; renderPinDots(); }, 400);
}

function enterApp() {
  $("setupScreen").classList.add("hidden");
  $("lockScreen").classList.add("hidden");
  $("mainApp").classList.remove("hidden");
  $("mainApp").style.display = "flex";
  switchTab("home");
  renderAll();
}

/* ---------------- TAB SWITCHING ---------------- */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("screen-" + tab).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const fab = $("fabAdd");
  if (tab === "home" || tab === "activity" || tab === "goals") {
    fab.classList.remove("hidden");
    pendingTxType = "expense";
  } else fab.classList.add("hidden");
  renderAll();
}

function renderAll() {
  if (!state) return;
  renderHome();
  renderActivity();
  renderStats();
  renderGoals();
  renderProfile();
}

/* ---------------- HOME ---------------- */
function totalBalance() {
  return state.wallets.reduce((s, w) => s + w.balance, 0);
}
function renderHome() {
  $("homeGreetingName").textContent = state.profile.name ? `Hi, ${state.profile.name}` : "Hi there";
  $("homeTotalBalance").textContent = formatMoney(totalBalance());

  const row = $("homeWalletRow");
  row.innerHTML = "";
  state.wallets.forEach((w) => {
    const t = WALLET_TYPES[w.type] || WALLET_TYPES.other;
    const chip = document.createElement("div");
    chip.className = "wallet-chip";
    chip.innerHTML = `
      <div class="w-icon" style="background:${t.color}">${t.icon}</div>
      <div class="w-name">${escapeHtml(w.name)}</div>
      <div class="w-bal">${formatMoney(w.balance)}</div>
    `;
    row.appendChild(chip);
  });
  const addChip = document.createElement("div");
  addChip.className = "wallet-chip add-wallet";
  addChip.textContent = "+ Add wallet";
  addChip.addEventListener("click", () => openWalletForm(null));
  row.appendChild(addChip);

  const recent = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  renderTxList($("homeRecentTx"), recent, "No transactions yet. Tap + to add your first one.");
}

function buildTxRowElement(tx) {
  const wallet = state.wallets.find((w) => w.id === tx.walletId);
  const cat = findCategory(tx.type, tx.category);
  const row = document.createElement("div");
  row.className = "tx-row";
  row.innerHTML = `
    <div class="tx-icon ${tx.type}">${cat ? cat.emoji : "•"}</div>
    <div class="tx-mid">
      <div class="tx-cat">${escapeHtml(tx.category)}</div>
      <div class="tx-sub">${wallet ? escapeHtml(wallet.name) : "—"} · ${formatDateShort(tx.date)}${tx.note ? " · " + escapeHtml(tx.note) : ""}</div>
    </div>
    <div class="tx-amt ${tx.type}">${tx.type === "income" ? "+" : "−"}${formatMoney(tx.amount)}</div>
  `;
  row.addEventListener("click", () => openTxDetail(tx.id));
  return row;
}
function renderTxList(container, list, emptyMsg) {
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="em-mark">🧾</div><p>${emptyMsg}</p></div>`;
    return;
  }
  list.forEach((tx) => container.appendChild(buildTxRowElement(tx)));
}

function findCategory(type, name) {
  return (state.categories[type] || []).find((c) => c.name === name);
}

/* ---------------- ACTIVITY ---------------- */
function renderActivity() {
  const filterWrap = $("activityFilters");
  filterWrap.innerHTML = "";
  ["all", "income", "expense"].forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "filter-chip" + (activityFilter === f ? " active" : "");
    chip.textContent = f === "all" ? "All" : f === "income" ? "Income" : "Expense";
    chip.addEventListener("click", () => { activityFilter = f; renderActivity(); });
    filterWrap.appendChild(chip);
  });

  let list = [...state.transactions];
  if (activityFilter !== "all") list = list.filter((t) => t.type === activityFilter);
  if (activitySearchText) {
    list = list.filter((t) => {
      const wallet = state.wallets.find((w) => w.id === t.walletId);
      return (t.category + " " + (t.note || "") + " " + (wallet ? wallet.name : "")).toLowerCase().includes(activitySearchText);
    });
  }
  list.sort((a, b) => new Date(b.date) - new Date(a.date));

  const container = $("activityList");
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="em-mark">🔍</div><p>No transactions match.</p></div>`;
    return;
  }
  let lastGroup = null;
  list.forEach((tx) => {
    const group = formatDateGroup(tx.date);
    if (group !== lastGroup) {
      const label = document.createElement("div");
      label.className = "date-group-label";
      label.textContent = group;
      container.appendChild(label);
      lastGroup = group;
    }
    container.appendChild(buildTxRowElement(tx));
  });
}

/* ---------------- STATS ---------------- */
function monthBounds(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset, 1);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start, end, label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) };
}

function renderStats() {
  const { start, end, label } = monthBounds(statsMonthOffset);
  $("statsMonthLabel").textContent = label;
  $("btnNextMonth").disabled = statsMonthOffset >= 0;

  const inRange = state.transactions.filter((t) => {
    const d = new Date(t.date);
    return d >= start && d < end;
  });
  const income = inRange.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = inRange.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  $("statIncome").textContent = "RWF " + formatMoney(income);
  $("statExpense").textContent = "RWF " + formatMoney(expense);

  // category breakdown for expenses
  const byCat = {};
  inRange.filter((t) => t.type === "expense").forEach((t) => {
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  });
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = catEntries.reduce((s, [, v]) => s + v, 0);

  const donutWrap = $("donutWrap");
  const barList = $("statsBarList");
  donutWrap.innerHTML = "";
  barList.innerHTML = "";

  if (catEntries.length === 0) {
    donutWrap.innerHTML = `<div class="empty-state" style="padding:10px 0;"><div class="em-mark">📊</div><p>No expenses recorded this month.</p></div>`;
    return;
  }

  let gradientParts = [];
  let cursor = 0;
  const legend = document.createElement("div");
  legend.className = "donut-legend";
  catEntries.slice(0, 6).forEach(([name, amt], i) => {
    const pct = total ? (amt / total) * 100 : 0;
    const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
    gradientParts.push(`${color} ${cursor}% ${cursor + pct}%`);
    cursor += pct;
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `<div class="legend-dot" style="background:${color}"></div><div class="legend-name">${escapeHtml(name)}</div><div class="legend-pct">${pct.toFixed(0)}%</div>`;
    legend.appendChild(row);
  });
  const donutOuter = document.createElement("div");
  donutOuter.className = "donut-outer";
  const donut = document.createElement("div");
  donut.className = "donut-ring";
  donut.style.background = `conic-gradient(${gradientParts.join(",")})`;
  const hole = document.createElement("div");
  hole.className = "donut-hole";
  donutOuter.appendChild(donut);
  donutOuter.appendChild(hole);
  donutWrap.appendChild(donutOuter);
  donutWrap.appendChild(legend);

  catEntries.forEach(([name, amt], i) => {
    const pct = total ? (amt / total) * 100 : 0;
    const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
    const item = document.createElement("div");
    item.className = "bar-item";
    item.innerHTML = `
      <div class="bar-top"><span class="b-name">${escapeHtml(name)}</span><span class="b-val">RWF ${formatMoney(amt)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    `;
    barList.appendChild(item);
  });
}

/* ---------------- GOALS ---------------- */
function renderGoals() {
  const wrap = $("goalsList");
  wrap.innerHTML = "";
  if (state.goals.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="em-mark">🎯</div><p>No goals yet. Tap + to start saving toward something.</p></div>`;
    return;
  }
  state.goals.forEach((g) => {
    const pct = g.target ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const card = document.createElement("div");
    card.className = "goal-card";
    card.innerHTML = `
      <div class="goal-top">
        <div>
          <div class="goal-name">${escapeHtml(g.name)}</div>
          <div class="goal-date">${g.date ? "Target: " + new Date(g.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No target date"}</div>
        </div>
        <button class="icon-btn" style="width:32px;height:32px;font-size:13px;" data-del="${g.id}">🗑️</button>
      </div>
      <div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div>
      <div class="goal-bottom">
        <div class="goal-nums"><b>RWF ${formatMoney(g.saved)}</b> of ${formatMoney(g.target)}</div>
        <button class="goal-add-btn" data-add="${g.id}">Add funds</button>
      </div>
    `;
    card.querySelector("[data-add]").addEventListener("click", () => openAddFundsSheet(g.id));
    card.querySelector("[data-del]").addEventListener("click", () => {
      if (confirm(`Delete goal "${g.name}"? This won't refund saved money to a wallet.`)) {
        state.goals = state.goals.filter((x) => x.id !== g.id);
        saveState(); renderGoals();
      }
    });
    wrap.appendChild(card);
  });
}

/* ---------------- PROFILE ---------------- */
function renderProfile() {
  $("profileNameDisplay").textContent = state.profile.name || "—";
  $("profileAvatarInitial").textContent = (state.profile.name || "?").trim().charAt(0).toUpperCase();
  $("autoLockVal").textContent = state.autoLock === "5min" ? "After 5 min" : state.autoLock === "1min" ? "After 1 min" : "Immediately";
}

/* ================= SHEETS / MODALS ================= */
function openSheet(title, bodyHtml, onMount) {
  const root = $("sheetRoot");
  root.innerHTML = `
    <div class="sheet-backdrop" id="sheetBackdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header"><h3>${title}</h3><button id="sheetCloseBtn">✕</button></div>
        <div id="sheetBody">${bodyHtml}</div>
      </div>
    </div>
  `;
  $("sheetCloseBtn").addEventListener("click", closeSheet);
  $("sheetBackdrop").addEventListener("click", (e) => { if (e.target.id === "sheetBackdrop") closeSheet(); });
  if (onMount) onMount();
}
function closeSheet() { $("sheetRoot").innerHTML = ""; }

/* ---- Add / Edit transaction ---- */
function openTxSheet(type, existingTx) {
  pendingTxType = type;
  const cats = state.categories[type];
  const walletsHtml = state.wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  const body = `
    <div class="toggle-row" id="txTypeToggle">
      <button data-t="expense" class="${type === "expense" ? "active" : ""}">Expense</button>
      <button data-t="income" class="${type === "income" ? "active" : ""}">Income</button>
    </div>
    <div class="field"><label>Amount (RWF)</label><input type="number" inputmode="numeric" id="txAmount" placeholder="0" value="${existingTx ? existingTx.amount : ""}"></div>
    <div class="field"><label>Wallet</label><select id="txWallet">${walletsHtml}</select></div>
    <div class="field"><label>Category</label><div class="cat-grid" id="txCatGrid"></div></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="txNote" placeholder="e.g. Lunch with friends" value="${existingTx ? escapeHtml(existingTx.note || "") : ""}"></div>
    <div class="field"><label>Date</label><input type="datetime-local" id="txDate" value="${existingTx ? existingTx.date.slice(0,16) : todayISO()}"></div>
    <button class="btn-primary" id="txSaveBtn" style="margin-top:8px;">${existingTx ? "Save changes" : "Add transaction"}</button>
    ${existingTx ? `<button class="btn-secondary" id="txDeleteBtn" style="margin-top:10px;color:#E11D48;border-color:#F3D6DC;">Delete</button>` : ""}
  `;
  openSheet(existingTx ? "Edit transaction" : "Add transaction", body, () => {
    let selectedCat = existingTx ? existingTx.category : cats[0].name;
    let selectedType = type;

    function renderCatGrid() {
      const grid = $("txCatGrid");
      grid.innerHTML = "";
      state.categories[selectedType].forEach((c) => {
        const el = document.createElement("div");
        el.className = "cat-pick" + (c.name === selectedCat ? " active" : "");
        el.innerHTML = `<span class="c-emoji">${c.emoji}</span><span class="c-name">${escapeHtml(c.name)}</span>`;
        el.addEventListener("click", () => { selectedCat = c.name; renderCatGrid(); });
        grid.appendChild(el);
      });
    }
    renderCatGrid();

    document.querySelectorAll("#txTypeToggle button").forEach((b) => {
      b.addEventListener("click", () => {
        selectedType = b.dataset.t;
        document.querySelectorAll("#txTypeToggle button").forEach((x) => x.classList.toggle("active", x === b));
        selectedCat = state.categories[selectedType][0].name;
        renderCatGrid();
      });
    });

    if (existingTx) $("txWallet").value = existingTx.walletId;

    $("txSaveBtn").addEventListener("click", () => {
      const amount = parseFloat($("txAmount").value);
      const walletId = $("txWallet").value;
      const note = $("txNote").value.trim();
      const date = new Date($("txDate").value).toISOString();
      if (!amount || amount <= 0) { toast("Enter a valid amount"); return; }
      if (!walletId) { toast("Choose a wallet"); return; }

      if (existingTx) {
        // reverse old effect
        applyWalletDelta(existingTx.walletId, existingTx.type === "income" ? -existingTx.amount : existingTx.amount);
        existingTx.type = selectedType; existingTx.amount = amount; existingTx.walletId = walletId;
        existingTx.category = selectedCat; existingTx.note = note; existingTx.date = date;
        applyWalletDelta(walletId, selectedType === "income" ? amount : -amount);
      } else {
        const tx = { id: uid(), type: selectedType, amount, walletId, category: selectedCat, note, date };
        state.transactions.push(tx);
        applyWalletDelta(walletId, selectedType === "income" ? amount : -amount);
      }
      saveState();
      closeSheet();
      renderAll();
      toast(existingTx ? "Transaction updated" : "Transaction added");
    });

    if (existingTx) {
      $("txDeleteBtn").addEventListener("click", () => {
        if (!confirm("Delete this transaction?")) return;
        applyWalletDelta(existingTx.walletId, existingTx.type === "income" ? -existingTx.amount : existingTx.amount);
        state.transactions = state.transactions.filter((t) => t.id !== existingTx.id);
        saveState(); closeSheet(); renderAll();
        toast("Transaction deleted");
      });
    }
  });
}
function applyWalletDelta(walletId, delta) {
  const w = state.wallets.find((x) => x.id === walletId);
  if (w) w.balance += delta;
}
function openTxDetail(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (tx) openTxSheet(tx.type, tx);
}

/* ---- Wallet management ---- */
function openManageWallets() {
  const body = `<div class="settings-group" id="walletManageList"></div>
    <button class="btn-secondary" id="addWalletBtn" style="margin-top:4px;">+ Add wallet</button>`;
  openSheet("Manage wallets", body, () => {
    renderWalletManageList();
    $("addWalletBtn").addEventListener("click", () => openWalletForm(null));
  });
}
function renderWalletManageList() {
  const list = $("walletManageList");
  if (!list) return;
  list.innerHTML = "";
  state.wallets.forEach((w) => {
    const t = WALLET_TYPES[w.type] || WALLET_TYPES.other;
    const row = document.createElement("div");
    row.className = "wallet-manage-row";
    row.innerHTML = `
      <div class="w-icon" style="width:34px;height:34px;background:${t.color};border-radius:9px;display:flex;align-items:center;justify-content:center;color:white;">${t.icon}</div>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:14px;">${escapeHtml(w.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">RWF ${formatMoney(w.balance)}</div>
      </div>
      <button class="icon-btn" style="width:32px;height:32px;font-size:13px;" data-edit="${w.id}">✎</button>
      <button class="icon-btn" style="width:32px;height:32px;font-size:13px;" data-del="${w.id}">🗑️</button>
    `;
    row.querySelector("[data-edit]").addEventListener("click", () => openWalletForm(w.id));
    row.querySelector("[data-del]").addEventListener("click", () => deleteWallet(w.id));
    list.appendChild(row);
  });
}
function deleteWallet(id) {
  if (state.wallets.length <= 1) { toast("You need at least one wallet"); return; }
  const hasTx = state.transactions.some((t) => t.walletId === id);
  const msg = hasTx ? "This wallet has transactions. Delete it and all its transactions?" : "Delete this wallet?";
  if (!confirm(msg)) return;
  state.transactions = state.transactions.filter((t) => t.walletId !== id);
  state.wallets = state.wallets.filter((w) => w.id !== id);
  saveState();
  renderWalletManageList();
  renderAll();
}
function openWalletForm(walletId) {
  const w = walletId ? state.wallets.find((x) => x.id === walletId) : null;
  const typeOptions = Object.entries(WALLET_TYPES).map(([k, v]) => `<option value="${k}" ${w && w.type === k ? "selected" : ""}>${v.icon} ${v.label}</option>`).join("");
  const body = `
    <div class="field"><label>Wallet name</label><input type="text" id="wfName" value="${w ? escapeHtml(w.name) : ""}" placeholder="e.g. BK Bank"></div>
    <div class="field"><label>Type</label><select id="wfType">${typeOptions}</select></div>
    ${!w ? `<div class="field"><label>Starting balance (RWF)</label><input type="number" id="wfBalance" value="0"></div>` : ""}
    <button class="btn-primary" id="wfSaveBtn" style="margin-top:8px;">${w ? "Save changes" : "Add wallet"}</button>
  `;
  openSheet(w ? "Edit wallet" : "Add wallet", body, () => {
    $("wfSaveBtn").addEventListener("click", () => {
      const name = $("wfName").value.trim();
      const type = $("wfType").value;
      if (!name) { toast("Enter a wallet name"); return; }
      if (w) { w.name = name; w.type = type; }
      else {
        const balance = parseFloat($("wfBalance").value) || 0;
        state.wallets.push({ id: uid(), name, type, balance });
      }
      saveState();
      closeSheet();
      openManageWallets();
      renderAll();
      toast(w ? "Wallet updated" : "Wallet added");
    });
  });
}

/* ---- Category management ---- */
function openManageCategories() {
  const body = `
    <div class="toggle-row" id="catTypeToggle">
      <button data-t="expense" class="active">Expense</button>
      <button data-t="income">Income</button>
    </div>
    <div class="settings-group" id="catManageList"></div>
    <div class="field"><label>New category name</label><input type="text" id="newCatName" placeholder="e.g. Pharmacy supplies"></div>
    <button class="btn-secondary" id="addCatBtn" style="margin-top:4px;">+ Add category</button>
  `;
  openSheet("Manage categories", body, () => {
    let activeType = "expense";
    function renderList() {
      const list = $("catManageList");
      list.innerHTML = "";
      state.categories[activeType].forEach((c) => {
        const row = document.createElement("div");
        row.className = "wallet-manage-row";
        row.innerHTML = `<span style="font-size:16px;">${c.emoji}</span><div style="flex:1;font-weight:700;font-size:14px;">${escapeHtml(c.name)}</div><button class="icon-btn" style="width:30px;height:30px;font-size:12px;" data-del="${escapeHtml(c.name)}">🗑️</button>`;
        row.querySelector("[data-del]").addEventListener("click", () => {
          if (state.categories[activeType].length <= 1) { toast("Keep at least one category"); return; }
          if (!confirm(`Delete category "${c.name}"?`)) return;
          state.categories[activeType] = state.categories[activeType].filter((x) => x.name !== c.name);
          saveState(); renderList();
        });
        list.appendChild(row);
      });
    }
    renderList();
    document.querySelectorAll("#catTypeToggle button").forEach((b) => {
      b.addEventListener("click", () => {
        activeType = b.dataset.t;
        document.querySelectorAll("#catTypeToggle button").forEach((x) => x.classList.toggle("active", x === b));
        renderList();
      });
    });
    $("addCatBtn").addEventListener("click", () => {
      const name = $("newCatName").value.trim();
      if (!name) { toast("Enter a category name"); return; }
      if (state.categories[activeType].some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast("That category already exists"); return; }
      state.categories[activeType].push({ name, emoji: "🏷️" });
      saveState();
      $("newCatName").value = "";
      renderList();
      toast("Category added");
    });
  });
}

/* ---- Edit name ---- */
function openEditName() {
  const body = `
    <div class="field"><label>Your name</label><input type="text" id="editNameInput" value="${escapeHtml(state.profile.name || "")}"></div>
    <button class="btn-primary" id="editNameSave" style="margin-top:8px;">Save</button>
  `;
  openSheet("Edit name", body, () => {
    $("editNameSave").addEventListener("click", () => {
      const val = $("editNameInput").value.trim();
      if (!val) { toast("Enter a name"); return; }
      state.profile.name = val;
      saveState();
      closeSheet();
      renderAll();
      toast("Name updated");
    });
  });
}

/* ---- Change PIN ---- */
function openChangePin() {
  const body = `
    <div class="field"><label>Current PIN</label><input type="password" inputmode="numeric" maxlength="4" id="curPin"></div>
    <div class="field"><label>New PIN (4 digits)</label><input type="password" inputmode="numeric" maxlength="4" id="newPin"></div>
    <div class="field"><label>Confirm new PIN</label><input type="password" inputmode="numeric" maxlength="4" id="confirmPin"></div>
    <p id="pinChangeError" style="color:#E11D48;font-size:13px;margin:0;"></p>
    <button class="btn-primary" id="pinChangeSave" style="margin-top:8px;">Update PIN</button>
  `;
  openSheet("Change PIN", body, () => {
    $("pinChangeSave").addEventListener("click", async () => {
      const cur = $("curPin").value.trim();
      const next = $("newPin").value.trim();
      const conf = $("confirmPin").value.trim();
      const err = $("pinChangeError");
      const curHash = await hashPin(cur, state.pinSalt);
      if (curHash !== state.pinHash) { err.textContent = "Current PIN is incorrect."; return; }
      if (!/^\d{4}$/.test(next)) { err.textContent = "New PIN must be exactly 4 digits."; return; }
      if (next !== conf) { err.textContent = "New PINs don't match."; return; }
      const salt = randomSalt();
      state.pinSalt = salt;
      state.pinHash = await hashPin(next, salt);
      saveState();
      closeSheet();
      toast("PIN updated");
    });
  });
}

/* ---- Auto-lock picker ---- */
function openAutoLockPicker() {
  const opts = [["immediate", "Immediately"], ["1min", "After 1 minute"], ["5min", "After 5 minutes"]];
  const body = `<div class="settings-group">${opts.map(([k, l]) => `
    <div class="settings-row" data-k="${k}"><div class="sr-icon">⏱️</div><div class="sr-label">${l}</div><div class="sr-chev">${state.autoLock === k ? "✓" : ""}</div></div>
  `).join("")}</div>`;
  openSheet("Auto-lock", body, () => {
    document.querySelectorAll("[data-k]").forEach((row) => {
      row.addEventListener("click", () => {
        state.autoLock = row.dataset.k;
        saveState();
        closeSheet();
        renderProfile();
      });
    });
  });
}

/* ---- Goals ---- */
function openGoalSheet() {
  const body = `
    <div class="field"><label>Goal name</label><input type="text" id="goalName" placeholder="e.g. New laptop"></div>
    <div class="field"><label>Target amount (RWF)</label><input type="number" id="goalTarget" placeholder="0"></div>
    <div class="field"><label>Target date (optional)</label><input type="date" id="goalDate"></div>
    <button class="btn-primary" id="goalSaveBtn" style="margin-top:8px;">Create goal</button>
  `;
  openSheet("New goal", body, () => {
    $("goalSaveBtn").addEventListener("click", () => {
      const name = $("goalName").value.trim();
      const target = parseFloat($("goalTarget").value);
      const date = $("goalDate").value;
      if (!name) { toast("Enter a goal name"); return; }
      if (!target || target <= 0) { toast("Enter a valid target amount"); return; }
      state.goals.push({ id: uid(), name, target, saved: 0, date: date || null });
      saveState();
      closeSheet();
      renderGoals();
      toast("Goal created");
    });
  });
}
function openAddFundsSheet(goalId) {
  const g = state.goals.find((x) => x.id === goalId);
  const walletsHtml = state.wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} — RWF ${formatMoney(w.balance)}</option>`).join("");
  const body = `
    <div class="field"><label>From wallet</label><select id="fundWallet">${walletsHtml}</select></div>
    <div class="field"><label>Amount (RWF)</label><input type="number" id="fundAmount" placeholder="0"></div>
    <button class="btn-primary" id="fundSaveBtn" style="margin-top:8px;">Add to goal</button>
  `;
  openSheet(`Add funds — ${g.name}`, body, () => {
    $("fundSaveBtn").addEventListener("click", () => {
      const walletId = $("fundWallet").value;
      const amount = parseFloat($("fundAmount").value);
      const wallet = state.wallets.find((w) => w.id === walletId);
      if (!amount || amount <= 0) { toast("Enter a valid amount"); return; }
      if (wallet.balance < amount) { toast("Not enough balance in that wallet"); return; }
      wallet.balance -= amount;
      g.saved += amount;
      if (!state.categories.expense.some((c) => c.name === "Savings")) {
        state.categories.expense.push({ name: "Savings", emoji: "🎯" });
      }
      state.transactions.push({ id: uid(), type: "expense", amount, walletId, category: "Savings", note: `Goal: ${g.name}`, date: new Date().toISOString() });
      saveState();
      closeSheet();
      renderAll();
      toast("Funds added to goal");
    });
  });
}

/* ---- Backup / restore / reset ---- */
function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mywallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Backup downloaded");
}
function importBackup() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.wallets || !data.transactions) throw new Error("bad shape");
        if (!confirm("Restore this backup? It will replace all current data.")) return;
        state = data;
        saveState();
        renderAll();
        toast("Backup restored");
      } catch (e) {
        toast("That file doesn't look like a valid backup");
      }
    };
    reader.readAsText(file);
  });
  input.click();
}
function eraseAllData() {
  if (!confirm("Erase everything? This deletes all wallets, transactions and goals from this device and can't be undone.")) return;
  if (!confirm("Are you absolutely sure? This is permanent.")) return;
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  showSetup();
}

/* ---------------- util ---------------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
