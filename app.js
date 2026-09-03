/* =========================================================
   MyWallet — fully offline, local-only personal finance app
   All data lives in this browser's localStorage. Nothing is
   ever sent over the network.
   ========================================================= */

const STORAGE_KEY = "mywallet_state_v1";
const $ = (id) => document.getElementById(id);
const GOOGLE_CLIENT_ID = "914831071773-cj6ed81s89drtsb8l4nneiophp9sidsl.apps.googleusercontent.com";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

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
    fingerprintCredId: null,
    gdriveEnabled: false,
    gdriveFileId: null,
    gdriveLastBackup: null,
    wallets: [
      { id: uid(), name: "BK Bank", type: "bank", balance: 0 },
      { id: uid(), name: "MoMo", type: "momo", balance: 0 },
      { id: uid(), name: "Cash", type: "cash", balance: 0 }
    ],
    transactions: [],
    goals: [],
    recurringRules: [],
    debts: [],
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES))
  };
}

let state = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // migrate older saves so new features don't crash on existing data
    if (parsed.recurringRules === undefined) parsed.recurringRules = [];
    if (parsed.debts === undefined) parsed.debts = [];
    if (parsed.fingerprintCredId === undefined) parsed.fingerprintCredId = null;
    if (parsed.gdriveEnabled === undefined) parsed.gdriveEnabled = false;
    if (parsed.gdriveFileId === undefined) parsed.gdriveFileId = null;
    if (parsed.gdriveLastBackup === undefined) parsed.gdriveLastBackup = null;
    return parsed;
  } catch (e) { return null; }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleGDriveBackup();
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

/* ---------------- fingerprint (WebAuthn platform authenticator) ---------------- */
function bufToBase64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function base64ToBuf(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer; }

async function platformAuthAvailable() {
  if (!window.PublicKeyCredential || !navigator.credentials) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch (e) { return false; }
}

async function registerFingerprint() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "MyWallet" },
        user: { id: userId, name: state.profile.name || "user", displayName: state.profile.name || "MyWallet user" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000
      }
    });
    if (!cred) return false;
    state.fingerprintCredId = bufToBase64(cred.rawId);
    saveState();
    return true;
  } catch (e) { return false; }
}

async function authenticateFingerprint() {
  if (!state.fingerprintCredId) return false;
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: base64ToBuf(state.fingerprintCredId), type: "public-key" }],
        userVerification: "required",
        timeout: 60000
      }
    });
    return !!assertion;
  } catch (e) { return false; }
}

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
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      reg.update().catch(() => {});
    }).catch(() => {});

    let refreshedOnce = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshedOnce) return;
      // don't yank the page out from under someone mid-entry in a sheet
      if ($("sheetRoot") && $("sheetRoot").innerHTML.trim() !== "") return;
      refreshedOnce = true;
      window.location.reload();
    });
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
  $("rowFingerprint").addEventListener("click", openFingerprintSettings);
  $("rowAutoLock").addEventListener("click", openAutoLockPicker);
  $("rowRecurring").addEventListener("click", openRecurringList);
  $("rowLending").addEventListener("click", openLendingList);
  $("rowGoogleDrive").addEventListener("click", openGoogleDriveInfo);
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

  const fpBtn = $("fingerprintBtn");
  if (state && state.fingerprintCredId) {
    fpBtn.hidden = false;
    fpBtn.onclick = tryFingerprintUnlock;
    // auto-prompt once when the lock screen appears
    setTimeout(tryFingerprintUnlock, 250);
  } else {
    fpBtn.hidden = true;
  }
}
async function tryFingerprintUnlock() {
  const ok = await authenticateFingerprint();
  if (ok) enterApp();
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
  processRecurring();
  switchTab("home");
  renderAll();
  if (state.gdriveEnabled) ensureGDriveToken(true).catch(() => {});
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
  $("fingerprintVal").textContent = state.fingerprintCredId ? "On" : "Off";
  $("gdriveVal").textContent = state.gdriveEnabled ? "On" : "Off";
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
function openTxSheet(type, existingTx, prefill) {
  pendingTxType = type;
  const cats = state.categories[type];
  const walletsHtml = state.wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  const body = `
    <div class="toggle-row" id="txTypeToggle">
      <button data-t="expense" class="${type === "expense" ? "active" : ""}">Expense</button>
      <button data-t="income" class="${type === "income" ? "active" : ""}">Income</button>
    </div>
    <div class="field"><label>Amount (RWF)</label><input type="number" inputmode="numeric" id="txAmount" placeholder="0" value="${existingTx ? existingTx.amount : (prefill && prefill.amount) || ""}"></div>
    <div class="field"><label>Wallet</label><select id="txWallet">${walletsHtml}</select></div>
    <div class="field"><label>Category</label><div class="cat-grid" id="txCatGrid"></div></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="txNote" placeholder="e.g. Lunch with friends" value="${existingTx ? escapeHtml(existingTx.note || "") : escapeHtml((prefill && prefill.note) || "")}"></div>
    <div class="field"><label>Date</label><input type="datetime-local" id="txDate" value="${existingTx ? existingTx.date.slice(0,16) : todayISO()}"></div>
    ${!existingTx ? `
    <div class="field"><label>Repeat</label>
      <div class="toggle-row" id="txRepeatToggle">
        <button data-r="" class="active">None</button>
        <button data-r="weekly">Weekly</button>
        <button data-r="monthly">Monthly</button>
      </div>
    </div>` : ""}
    <button class="btn-primary" id="txSaveBtn" style="margin-top:8px;">${existingTx ? "Save changes" : "Add transaction"}</button>
    ${existingTx ? `<button class="btn-secondary" id="txDeleteBtn" style="margin-top:10px;color:#E11D48;border-color:#F3D6DC;">Delete</button>` : ""}
  `;
  openSheet(existingTx ? "Edit transaction" : "Add transaction", body, () => {
    let selectedCat = existingTx ? existingTx.category : (prefill && prefill.category) || cats[0].name;
    let selectedType = type;
    let selectedRepeat = "";

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

    if (!existingTx) {
      document.querySelectorAll("#txRepeatToggle button").forEach((b) => {
        b.addEventListener("click", () => {
          selectedRepeat = b.dataset.r;
          document.querySelectorAll("#txRepeatToggle button").forEach((x) => x.classList.toggle("active", x === b));
        });
      });
    }

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
        if (selectedRepeat) {
          const next = selectedRepeat === "weekly" ? addWeeks(new Date(date), 1) : addMonths(new Date(date), 1);
          state.recurringRules.push({ id: uid(), type: selectedType, amount, walletId, category: selectedCat, note, frequency: selectedRepeat, nextDate: next.toISOString() });
        }
      }
      saveState();
      closeSheet();
      renderAll();
      toast(existingTx ? "Transaction updated" : selectedRepeat ? "Transaction added — it'll repeat automatically" : "Transaction added");
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

/* ---- Fingerprint settings ---- */
async function openFingerprintSettings() {
  const available = await platformAuthAvailable();
  if (!available) {
    openSheet("Fingerprint unlock", `<p style="color:var(--text-muted);font-size:14px;">This device or browser doesn't support fingerprint/face unlock. You can still use your PIN — it's just as secure.</p>`);
    return;
  }
  if (state.fingerprintCredId) {
    const body = `
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px;">Fingerprint unlock is <b style="color:var(--success)">ON</b>. You'll be asked for your fingerprint each time you open the app, with your PIN as a backup.</p>
      <button class="btn-secondary" id="fpOffBtn" style="color:#E11D48;border-color:#F3D6DC;">Turn off fingerprint unlock</button>
    `;
    openSheet("Fingerprint unlock", body, () => {
      $("fpOffBtn").addEventListener("click", () => {
        state.fingerprintCredId = null;
        saveState();
        closeSheet();
        renderProfile();
        toast("Fingerprint unlock turned off");
      });
    });
  } else {
    const body = `
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px;">Unlock MyWallet with your fingerprint or face instead of typing your PIN every time. Your PIN still works as a backup.</p>
      <button class="btn-primary" id="fpOnBtn">Enable fingerprint unlock</button>
    `;
    openSheet("Fingerprint unlock", body, () => {
      $("fpOnBtn").addEventListener("click", async () => {
        toast("Follow the prompt on your screen...");
        const ok = await registerFingerprint();
        if (ok) { closeSheet(); renderProfile(); toast("Fingerprint unlock enabled"); }
        else toast("Couldn't set that up — try again");
      });
    });
  }
}

/* ---- Recurring transactions ---- */
function frequencyLabel(f) { return f === "weekly" ? "Every week" : "Every month"; }
function openRecurringList() {
  const body = `<div class="settings-group" id="recurringList"></div>
    <p style="color:var(--text-muted);font-size:13px;margin-top:10px;">To add a new one, turn on "Repeat" when creating a transaction.</p>`;
  openSheet("Recurring transactions", body, renderRecurringList);
}
function renderRecurringList() {
  const list = $("recurringList");
  if (!list) return;
  list.innerHTML = "";
  if (state.recurringRules.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:20px 0;"><div class="em-mark">🔁</div><p>No recurring transactions yet.</p></div>`;
    return;
  }
  state.recurringRules.forEach((r) => {
    const wallet = state.wallets.find((w) => w.id === r.walletId);
    const cat = findCategory(r.type, r.category);
    const row = document.createElement("div");
    row.className = "wallet-manage-row";
    row.innerHTML = `
      <span style="font-size:16px;">${cat ? cat.emoji : "🔁"}</span>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:14px;">${escapeHtml(r.category)} · ${r.type === "income" ? "+" : "−"}${formatMoney(r.amount)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${frequencyLabel(r.frequency)} · ${wallet ? escapeHtml(wallet.name) : "—"} · next ${new Date(r.nextDate).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</div>
      </div>
      <button class="icon-btn" style="width:32px;height:32px;font-size:13px;" data-del="${r.id}">🗑️</button>
    `;
    row.querySelector("[data-del]").addEventListener("click", () => {
      if (!confirm(`Stop "${r.category}" from repeating? Past transactions it already created will stay.`)) return;
      state.recurringRules = state.recurringRules.filter((x) => x.id !== r.id);
      saveState();
      renderRecurringList();
    });
    list.appendChild(row);
  });
}
function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + n); return d; }
function addWeeks(date, n) { const d = new Date(date); d.setDate(d.getDate() + n * 7); return d; }
function processRecurring() {
  if (!state.recurringRules.length) return;
  const today = new Date();
  let changed = false;
  state.recurringRules.forEach((r) => {
    let next = new Date(r.nextDate);
    let guard = 0;
    while (next <= today && guard < 24) {
      const tx = { id: uid(), type: r.type, amount: r.amount, walletId: r.walletId, category: r.category, note: r.note, date: next.toISOString() };
      state.transactions.push(tx);
      applyWalletDelta(r.walletId, r.type === "income" ? r.amount : -r.amount);
      next = r.frequency === "weekly" ? addWeeks(next, 1) : addMonths(next, 1);
      changed = true;
      guard++;
    }
    r.nextDate = next.toISOString();
  });
  if (changed) saveState();
}

/* ---- Lending & debts ---- */
function openLendingList() {
  const body = `<div class="settings-group" id="lendingList"></div>
    <button class="btn-secondary" id="addDebtBtn" style="margin-top:12px;">+ Add entry</button>`;
  openSheet("Lending & debts", body, () => {
    renderLendingList();
    $("addDebtBtn").addEventListener("click", openDebtForm);
  });
}
function debtNetSummary() {
  return state.debts.filter((d) => !d.settled).reduce((s, d) => s + (d.direction === "owed_to_me" ? d.amount : -d.amount), 0);
}
function renderLendingList() {
  const list = $("lendingList");
  if (!list) return;
  list.innerHTML = "";
  if (state.debts.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:20px 0;"><div class="em-mark">🤝</div><p>Nobody owes you, and you owe nobody. Tap + to log one.</p></div>`;
    return;
  }
  const sorted = [...state.debts].sort((a, b) => (a.settled === b.settled ? 0 : a.settled ? 1 : -1) || new Date(b.date) - new Date(a.date));
  sorted.forEach((d) => {
    const row = document.createElement("div");
    row.className = "debt-row" + (d.settled ? " settled" : "");
    row.innerHTML = `
      <div class="debt-avatar">${escapeHtml((d.personName || "?").charAt(0).toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:14px;">${escapeHtml(d.personName)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${d.settled ? "Settled · " : ""}${d.note ? escapeHtml(d.note) + " · " : ""}${formatDateShort(d.date)}</div>
      </div>
      <div style="text-align:right;">
        <div class="debt-amt ${d.direction}">RWF ${formatMoney(d.amount)}</div>
        <div class="debt-tag ${d.direction}">${d.direction === "owed_to_me" ? "Owes you" : "You owe"}</div>
      </div>
    `;
    row.addEventListener("click", () => openDebtDetail(d.id));
    list.appendChild(row);
  });
}
function openDebtForm() {
  const walletsHtml = state.wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  const body = `
    <div class="toggle-row" id="debtDirToggle">
      <button data-d="owed_to_me" class="active">They owe me</button>
      <button data-d="i_owe">I owe them</button>
    </div>
    <div class="field"><label>Person's name</label><input type="text" id="debtName" placeholder="e.g. Claudine"></div>
    <div class="field"><label>Amount (RWF)</label><input type="number" id="debtAmount" placeholder="0"></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="debtNote" placeholder="e.g. Lent for transport"></div>
    <button class="btn-primary" id="debtSaveBtn" style="margin-top:8px;">Save</button>
  `;
  openSheet("New lending entry", body, () => {
    let dir = "owed_to_me";
    document.querySelectorAll("#debtDirToggle button").forEach((b) => {
      b.addEventListener("click", () => { dir = b.dataset.d; document.querySelectorAll("#debtDirToggle button").forEach((x) => x.classList.toggle("active", x === b)); });
    });
    $("debtSaveBtn").addEventListener("click", () => {
      const name = $("debtName").value.trim();
      const amount = parseFloat($("debtAmount").value);
      const note = $("debtNote").value.trim();
      if (!name) { toast("Enter a name"); return; }
      if (!amount || amount <= 0) { toast("Enter a valid amount"); return; }
      state.debts.push({ id: uid(), personName: name, amount, direction: dir, note, date: new Date().toISOString(), settled: false });
      saveState();
      closeSheet();
      openLendingList();
      toast("Saved");
    });
  });
}
function openDebtDetail(id) {
  const d = state.debts.find((x) => x.id === id);
  if (!d) return;
  const body = `
    <div style="text-align:center;margin-bottom:18px;">
      <div class="debt-avatar" style="width:56px;height:56px;font-size:20px;margin:0 auto 10px;">${escapeHtml((d.personName || "?").charAt(0).toUpperCase())}</div>
      <div style="font-weight:800;font-size:17px;">${escapeHtml(d.personName)}</div>
      <div class="debt-amt ${d.direction}" style="font-size:20px;margin-top:4px;">RWF ${formatMoney(d.amount)}</div>
      <div class="debt-tag ${d.direction}" style="margin-top:6px;display:inline-block;">${d.direction === "owed_to_me" ? "Owes you" : "You owe"}</div>
    </div>
    ${!d.settled ? `<button class="btn-primary" id="debtSettleBtn">Mark as settled</button>` : `<p style="text-align:center;color:var(--text-muted);font-size:13px;">Settled on ${formatDateShort(d.settledDate || d.date)}</p>`}
    <button class="btn-secondary" id="debtDeleteBtn" style="margin-top:10px;color:#E11D48;border-color:#F3D6DC;">Delete entry</button>
  `;
  openSheet("Lending detail", body, () => {
    if (!d.settled) {
      $("debtSettleBtn").addEventListener("click", () => {
        d.settled = true;
        d.settledDate = new Date().toISOString();
        saveState();
        closeSheet();
        renderAll();
        if (confirm(`Record this as ${d.direction === "owed_to_me" ? "money received" : "money paid"} in one of your wallets?`)) {
          if (!state.categories.income.some((c) => c.name === "Debt settlement")) state.categories.income.push({ name: "Debt settlement", emoji: "🤝" });
          if (!state.categories.expense.some((c) => c.name === "Debt settlement")) state.categories.expense.push({ name: "Debt settlement", emoji: "🤝" });
          openTxSheet(d.direction === "owed_to_me" ? "income" : "expense", null, { amount: d.amount, category: "Debt settlement", note: d.personName });
        } else {
          toast("Marked as settled");
        }
      });
    }
    $("debtDeleteBtn").addEventListener("click", () => {
      if (!confirm("Delete this entry?")) return;
      state.debts = state.debts.filter((x) => x.id !== d.id);
      saveState();
      closeSheet();
      renderAll();
    });
  });
}

/* ---- Google Drive backup (real implementation) ---- */
let gisTokenClient = null;
let gdriveAccessToken = null;
let gdriveBackupTimer = null;

function ensureGisClient() {
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) return null;
  if (!gisTokenClient) {
    gisTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: () => {}
    });
  }
  return gisTokenClient;
}

function requestGDriveToken(silent) {
  return new Promise((resolve) => {
    const client = ensureGisClient();
    if (!client) { resolve(null); return; }
    client.callback = (resp) => {
      if (resp && resp.access_token) { gdriveAccessToken = resp.access_token; resolve(resp.access_token); }
      else resolve(null);
    };
    try { client.requestAccessToken(silent ? { prompt: "" } : {}); }
    catch (e) { resolve(null); }
  });
}

async function ensureGDriveToken(silent) {
  if (gdriveAccessToken) return gdriveAccessToken;
  return requestGDriveToken(silent);
}

async function backupToGoogleDrive(silent) {
  if (!state.gdriveEnabled) return false;
  const token = await ensureGDriveToken(silent !== false);
  if (!token) return false;
  const content = JSON.stringify(state);
  try {
    if (!state.gdriveFileId) {
      const boundary = "mywalletbound";
      const metadata = { name: "mywallet-backup.json", mimeType: "application/json" };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body
      });
      if (!res.ok) return false;
      const data = await res.json();
      state.gdriveFileId = data.id;
    } else {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${state.gdriveFileId}?uploadType=media`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: content
      });
      if (!res.ok) {
        if (res.status === 404) { state.gdriveFileId = null; return backupToGoogleDrive(silent); }
        return false;
      }
    }
    state.gdriveLastBackup = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) { return false; }
}

function scheduleGDriveBackup() {
  if (!state || !state.gdriveEnabled) return;
  clearTimeout(gdriveBackupTimer);
  gdriveBackupTimer = setTimeout(() => { backupToGoogleDrive(true); }, 4000);
}

function connectGoogleDrive(onDone) {
  const client = ensureGisClient();
  if (!client) { toast("Google sign-in isn't available right now — check your connection"); if (onDone) onDone(false); return; }
  client.callback = async (resp) => {
    if (resp.error || !resp.access_token) { toast("Couldn't connect to Google Drive"); if (onDone) onDone(false); return; }
    gdriveAccessToken = resp.access_token;
    state.gdriveEnabled = true;
    saveState();
    const ok = await backupToGoogleDrive(false);
    toast(ok ? "Google Drive connected" : "Connected, but the first backup failed — try again");
    if (onDone) onDone(true);
  };
  try { client.requestAccessToken(); } catch (e) { if (onDone) onDone(false); }
}

/* ---- Google Drive settings sheet ---- */
function openGoogleDriveInfo() {
  if (state.gdriveEnabled) {
    const last = state.gdriveLastBackup ? new Date(state.gdriveLastBackup).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Not yet";
    const body = `
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:6px;">Backing up automatically to a private file in your Google Drive.</p>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:18px;">Last backup: <b style="color:var(--text)">${last}</b></p>
      <button class="btn-primary" id="gdriveBackupNowBtn">Backup now</button>
      <button class="btn-secondary" id="gdriveOffBtn" style="margin-top:10px;color:#E11D48;border-color:#F3D6DC;">Disconnect Google Drive</button>
    `;
    openSheet("Google Drive backup", body, () => {
      $("gdriveBackupNowBtn").addEventListener("click", async () => {
        toast("Backing up...");
        const ok = await backupToGoogleDrive(false);
        toast(ok ? "Backed up to Google Drive" : "Backup failed — try again");
        renderProfile();
      });
      $("gdriveOffBtn").addEventListener("click", () => {
        state.gdriveEnabled = false;
        gdriveAccessToken = null;
        saveState();
        closeSheet();
        renderProfile();
        toast("Google Drive disconnected");
      });
    });
  } else {
    const body = `
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px;">Automatically back up your data to a private file in your own Google Drive — nothing passes through anyone else's server.</p>
      <button class="btn-primary" id="gdriveConnectBtn">Connect Google Drive</button>
    `;
    openSheet("Google Drive backup", body, () => {
      $("gdriveConnectBtn").addEventListener("click", () => {
        toast("Follow the Google sign-in prompt...");
        connectGoogleDrive((success) => { if (success) { closeSheet(); renderProfile(); } });
      });
    });
  }
}
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
