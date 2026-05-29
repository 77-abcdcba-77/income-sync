/* ====== Shared State & Utilities ====== */

let records = [];
let expenses = [];
let stats = null;
let versions = [];
let currentPayments = [];
let currentAdjustments = [];
let editingOrderId = null;
let editingExpenseId = null;
let editingPaymentId = null;
let editingAdjustmentId = null;
let activeFilter = "all";
let unpaidTab = "all";
let previewLoaded = false;
let selectedClient = null;
let resizeTimer = null;

const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
const numberFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const $ = (id) => document.getElementById(id);
const palette = ["#38bdf8", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#14b8a6", "#facc15"];

function getUrlParam(name) {
  return new URL(window.location.href).searchParams.get(name);
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function formatMoney(v) {
  return money.format(Number(v || 0));
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

async function api(path, options = {}) {
  const body = options.body;
  const headers = body instanceof FormData ? {} : { "Content-Type": "application/json" };
  const res = await fetch(path, { headers, ...options });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((data && data.error) || text || "请求失败");
  }
  return data;
}

function setDefaultDates() {
  const t = today();
  ["accepted_date", "initial_pay_date", "pay_date", "change_date", "expense_date"].forEach((id) => {
    const el = $(id);
    if (el && !el.value) el.value = t;
  });
}

function calcRemaining() {
  const price = Number($("price").value || 0);
  const initialPaid = Number($("initial_paid").value || 0);
  $("remainingPreview").value = numberFmt.format(price - initialPaid);
}

async function loadAll(keepSelection = true) {
  const oldSelected = $("selectedOrder") ? $("selectedOrder").value : null;
  const [recordData, expenseData, statsData, historyData] = await Promise.all([
    api("/api/records"),
    api("/api/expenses"),
    api("/api/stats"),
    api("/api/history"),
  ]);
  records = recordData;
  expenses = expenseData;
  stats = statsData;
  versions = historyData;
  const page = document.body.dataset.page;
  if (page === "dashboard") { renderKpis(); renderInsights(); renderUnpaidOverview(); renderCharts(); }
  if (page === "orders") { renderClientSummary(); renderOrdersTable(); }
  if (page === "payments") { renderOrderOptions(keepSelection ? oldSelected : null); loadSelectedOrderDetails(); }
  if (page === "expenses") { renderExpensesTable(); }
  if (page === "import-export") { renderHistory(); }
}

function statusBucket(value) {
  return value || "未填写";
}

function isOverdue(r) {
  if (!r.deadline_status || r.remaining <= 0) return false;
  const m = String(r.deadline_status).match(/^(\d{4}-\d{1,2}-\d{1,2})/);
  if (!m) return false;
  return new Date(m[1]).getTime() < new Date(today()).getTime();
}

/* ====== Dashboard ====== */

function renderKpis() {
  const s = stats.summary;
  $("kpiCount").textContent = s.count;
  $("kpiPrice").textContent = formatMoney(s.total_price);
  $("kpiPaid").textContent = formatMoney(s.total_paid);
  $("kpiRemaining").textContent = formatMoney(s.total_remaining);
  $("kpiTodayIncome").textContent = formatMoney(s.today_income);
  $("kpiMonthIncome").textContent = formatMoney(s.month_income);
  $("kpiExpense").textContent = formatMoney(s.total_expense);
  $("kpiNet").textContent = formatMoney(s.net_income);
  $("kpiPaidRate").textContent = `到账率 ${numberFmt.format(s.paid_rate)}%`;
  $("kpiUnpaidCount").textContent = `${s.unpaid_count || 0} 单待收`;
  $("kpiAvgOrder").textContent = `客单价 ${formatMoney(s.avg_order_value || 0)}`;
  $("riskBadge").textContent = `${s.overdue_count || 0} 逾期 / ${s.due_soon_count || 0} 近 7 天`;
}

function renderInsights() {
  const unpaid = [...records].filter((r) => r.remaining > 0).sort((a, b) => b.remaining - a.remaining).slice(0, 8);
  $("unpaidBody").innerHTML = unpaid.map((r) => `
    <button class="list-item ${isOverdue(r) ? "risk" : ""}" type="button" onclick="location.href='/payments?order_id=${r.id}'">
      <span>${escapeHtml(r.wechat || "未填客户")} · ${escapeHtml(r.order_no || `#${r.id}`)}</span>
      <b>${formatMoney(r.remaining)}</b>
    </button>
  `).join("") || `<div class="empty small-empty">没有待收款订单</div>`;

  $("clientBody").innerHTML = (stats.top_clients || []).slice(0, 5).map((c) => `
    <div class="list-item">
      <span>${escapeHtml(c.client)} · ${c.count} 单</span>
      <b>${formatMoney(c.price)}</b>
    </div>
  `).join("") || `<div class="empty small-empty">暂无客户数据</div>`;

  $("statusBody").innerHTML = (stats.status || []).map((s) => `<span class="tag">${escapeHtml(s.name)} ${s.value}</span>`).join("");
  $("statusSummary").textContent = `${(stats.status || []).length} 类`;
}

function renderUnpaidOverview() {
  const partialPaid = records.filter((r) => r.paid > 0 && r.remaining > 0);
  const nonePaid = records.filter((r) => r.paid === 0 && r.remaining > 0);

  $("partialCount").textContent = partialPaid.length;
  $("partialTotal").textContent = formatMoney(partialPaid.reduce((s, r) => s + r.remaining, 0));
  $("noneCount").textContent = nonePaid.length;
  $("noneTotal").textContent = formatMoney(nonePaid.reduce((s, r) => s + r.total_price, 0));

  const cardHtml = (r) => {
    const paidRate = r.total_price > 0 ? Math.round((r.paid / r.total_price) * 100) : 0;
    return `
    <button class="unpaid-card" type="button" onclick="location.href='/payments?order_id=${r.id}'">
      <div class="unpaid-card-top">
        <span class="unpaid-client">${escapeHtml(r.wechat || "未填客户")} · ${escapeHtml(r.task_name || "未命名")}</span>
        <span class="unpaid-remaining">${formatMoney(r.remaining)}</span>
      </div>
      <div class="unpaid-card-bar-wrap">
        <div class="unpaid-card-bar" style="width:${paidRate}%"></div>
      </div>
      <div class="unpaid-card-bottom">
        <span>总价 ${formatMoney(r.total_price)}</span>
        <span>已付 ${formatMoney(r.paid)}</span>
        <span>${escapeHtml(r.order_no || `#${r.id}`)}</span>
      </div>
    </button>`;
  };

  const sortFn = (a, b) => b.remaining - a.remaining;

  if (unpaidTab === "all") {
    $("partialBody").innerHTML = partialPaid.sort(sortFn).map(cardHtml).join("")
      || '<div class="empty small-empty">没有部分付款的订单</div>';
    $("noneBody").innerHTML = nonePaid.sort(sortFn).map(cardHtml).join("")
      || '<div class="empty small-empty">没有未付款的订单</div>';
    $("unpaidGrid").classList.remove("single-col");
  } else if (unpaidTab === "partial") {
    $("partialBody").innerHTML = partialPaid.sort(sortFn).map(cardHtml).join("")
      || '<div class="empty small-empty">没有部分付款的订单</div>';
    $("noneBody").innerHTML = "";
    $("unpaidGrid").classList.add("single-col");
  } else if (unpaidTab === "none") {
    $("partialBody").innerHTML = "";
    $("noneBody").innerHTML = nonePaid.sort(sortFn).map(cardHtml).join("")
      || '<div class="empty small-empty">没有未付款的订单</div>';
    $("unpaidGrid").classList.add("single-col");
  }
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.floor(rect.width * dpr));
  canvas.height = Math.max(220, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { ctx, w: rect.width, h: rect.height };
}

function drawPanelGrid(ctx, w, h, pad) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#07111f";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(148, 163, 184, .18)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(pad.top + (h - pad.top - pad.bottom) * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }
}

function valueFor(series, label) {
  const item = series.find((x) => x.label === label);
  return item ? Number(item.value || 0) : 0;
}

function mergeLabels(...seriesList) {
  return [...new Set(seriesList.flat().map((x) => x.label))].sort();
}

function drawLineChart(canvasId, series, labels) {
  const canvas = $(canvasId);
  const { ctx, w, h } = fitCanvas(canvas);
  const pad = { left: 64, right: 18, top: 22, bottom: 42 };
  const values = series.flatMap((s) => s.values);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v))) * 1.15;
  const min = values.some((v) => v < 0) ? -maxAbs : 0;
  const max = maxAbs;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  drawPanelGrid(ctx, w, h, pad);
  ctx.font = "12px Microsoft YaHei, sans-serif";
  ctx.fillStyle = "#cbd5e1";
  for (let i = 0; i <= 4; i++) {
    const val = max - (max - min) * i / 4;
    const y = pad.top + plotH * i / 4;
    ctx.fillText(`${Math.round(val / 1000)}k`, 12, y + 4);
  }
  series.forEach((s, si) => {
    ctx.strokeStyle = palette[si % palette.length];
    ctx.lineWidth = 3;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const x = Math.round(pad.left + (labels.length <= 1 ? plotW / 2 : plotW * i / (labels.length - 1)));
      const y = Math.round(pad.top + plotH - ((v - min) / (max - min)) * plotH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    s.values.forEach((v, i) => {
      const x = Math.round(pad.left + (labels.length <= 1 ? plotW / 2 : plotW * i / (labels.length - 1)));
      const y = Math.round(pad.top + plotH - ((v - min) / (max - min)) * plotH);
      ctx.fillStyle = palette[si % palette.length];
      ctx.fillRect(x - 3, y - 3, 6, 6);
    });
    ctx.fillStyle = palette[si % palette.length];
    ctx.fillText(s.name, pad.left + si * 78, h - 14);
  });
}

function drawBarChart(canvasId, items) {
  const canvas = $(canvasId);
  const { ctx, w, h } = fitCanvas(canvas);
  const pad = { left: 64, right: 20, top: 22, bottom: 74 };
  const max = Math.max(1, ...items.map((x) => Number(x.price || 0))) * 1.15;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  drawPanelGrid(ctx, w, h, pad);
  const barGap = 10;
  const barW = Math.max(16, Math.floor(plotW / Math.max(items.length, 1) - barGap));
  items.forEach((item, i) => {
    const x = Math.round(pad.left + i * (barW + barGap));
    const height = Math.round((Number(item.price || 0) / max) * plotH);
    const y = Math.round(pad.top + plotH - height);
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(x, y, barW, height);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(x + 3, y + 3, Math.max(0, barW - 6), Math.max(0, height - 6));
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(x + 5, y + 5, Math.max(0, barW - 10), Math.max(0, height - 10));
    ctx.save();
    ctx.translate(x + barW / 2, h - 48);
    ctx.rotate(-Math.PI / 5);
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px Microsoft YaHei, sans-serif";
    ctx.fillText(String(item.client || "暂无").slice(0, 10), 0, 0);
    ctx.restore();
  });
}

function drawStatusChart(canvasId, items) {
  const canvas = $(canvasId);
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#07111f";
  ctx.fillRect(0, 0, w, h);
  const max = Math.max(1, ...items.map((x) => Number(x.value || 0)));
  ctx.font = "13px Microsoft YaHei, sans-serif";
  items.slice(0, 7).forEach((item, i) => {
    const y = 28 + i * 34;
    const width = Math.round((w - 150) * Number(item.value || 0) / max);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(String(item.name).slice(0, 8), 14, y + 16);
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(92, y, width, 18);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(item.value, 100 + width, y + 15);
  });
}

function renderCharts() {
  if (!stats) return;
  const dailyLabels = mergeLabels(stats.daily_income, stats.daily_expense, stats.daily_cashflow);
  drawLineChart("dailyChart", [
    { name: "收入", values: (dailyLabels.length ? dailyLabels : [today()]).map((l) => valueFor(stats.daily_income, l)) },
    { name: "支出", values: (dailyLabels.length ? dailyLabels : [today()]).map((l) => valueFor(stats.daily_expense, l)) },
    { name: "净额", values: (dailyLabels.length ? dailyLabels : [today()]).map((l) => valueFor(stats.daily_cashflow, l)) },
  ], dailyLabels.length ? dailyLabels : [today()]);

  const monthlyLabels = mergeLabels(stats.monthly_income, stats.monthly_expense, stats.monthly_cashflow);
  drawLineChart("monthlyChart", [
    { name: "收入", values: (monthlyLabels.length ? monthlyLabels : [today().slice(0, 7)]).map((l) => valueFor(stats.monthly_income, l)) },
    { name: "支出", values: (monthlyLabels.length ? monthlyLabels : [today().slice(0, 7)]).map((l) => valueFor(stats.monthly_expense, l)) },
    { name: "净额", values: (monthlyLabels.length ? monthlyLabels : [today().slice(0, 7)]).map((l) => valueFor(stats.monthly_cashflow, l)) },
  ], monthlyLabels.length ? monthlyLabels : [today().slice(0, 7)]);

  drawStatusChart("statusChart", stats.status.length ? stats.status : [{ name: "暂无", value: 1 }]);
  drawBarChart("clientChart", stats.top_clients.length ? stats.top_clients : [{ client: "暂无", price: 0 }]);
}

/* ====== Orders ====== */

function orderLabel(r) {
  const name = r.task_name || "未命名任务";
  const client = r.wechat || "未填客户";
  return `#${r.id} · ${client} · ${name} · 剩余 ${formatMoney(r.remaining)}`;
}

function getFilteredRecords() {
  const q = ($("searchInput") ? $("searchInput").value : "").trim().toLowerCase();
  const highLine = Math.max(1000, (stats ? stats.summary.avg_order_value : 0) || 0);
  return records.filter((r) => {
    if (selectedClient && r.wechat !== selectedClient) return false;
    const text = `${r.wechat} ${r.task_name} ${r.order_no} ${r.deadline_status} ${r.accepted_date}`.toLowerCase();
    if (q && !text.includes(q)) return false;
    if (activeFilter === "unpaid") return r.remaining > 0;
    if (activeFilter === "paid") return r.remaining <= 0;
    if (activeFilter === "overdue") return isOverdue(r);
    if (activeFilter === "high") return r.total_price >= highLine;
    return true;
  });
}

function renderClientSummary() {
  const grid = $("clientSummary");
  if (!grid) return;

  const grouped = {};
  records.forEach((r) => {
    const key = r.wechat || "未填写";
    if (!grouped[key]) grouped[key] = { wechat: key, count: 0, total_price: 0, paid: 0, remaining: 0 };
    grouped[key].count += 1;
    grouped[key].total_price += r.total_price;
    grouped[key].paid += r.paid;
    grouped[key].remaining += r.remaining;
  });
  const clients = Object.values(grouped).sort((a, b) => b.total_price - a.total_price);

  grid.innerHTML = clients.map((c) => {
    const rate = c.total_price > 0 ? Math.round((c.paid / c.total_price) * 100) : 0;
    const sel = selectedClient === c.wechat ? " selected" : "";
    return `
    <button class="client-card${sel}" type="button" onclick="filterByClient('${escapeHtml(c.wechat).replace(/'/g, "\\'")}')">
      <div class="client-card-name">${escapeHtml(c.wechat)}</div>
      <div class="client-card-stats">
        <div><span>订单数</span><b>${c.count}</b></div>
        <div><span>总价</span><b>${formatMoney(c.total_price)}</b></div>
        <div><span>已到账</span><b class="green">${formatMoney(c.paid)}</b></div>
        <div><span>剩余</span><b class="red">${formatMoney(c.remaining)}</b></div>
      </div>
      <div class="client-card-bar-wrap">
        <div class="client-card-bar" style="width:${rate}%"></div>
      </div>
    </button>`;
  }).join("") || '<div class="empty">暂无客户数据</div>';
}

window.filterByClient = function(wechat) {
  if (selectedClient === wechat) {
    selectedClient = null;
    $("clientFilterBadge").classList.add("hidden");
    $("orderTableTitle").textContent = "订单数据库";
  } else {
    selectedClient = wechat;
    $("clientFilterBadge").classList.remove("hidden");
    $("clientFilterBadge").textContent = `当前筛选：${wechat}`;
    $("orderTableTitle").textContent = `${wechat} 的订单`;
  }
  renderClientSummary();
  renderOrdersTable();
  document.getElementById("orderTableTitle").scrollIntoView({ behavior: "smooth" });
};

function renderOrdersTable() {
  const body = $("recordsBody");
  if (!body) return;
  const filtered = getFilteredRecords();
  $("tableSummary").textContent = `显示 ${filtered.length} / ${records.length} 单，筛选剩余未收 ${formatMoney(filtered.reduce((sum, r) => sum + Number(r.remaining || 0), 0))}`;
  body.innerHTML = filtered.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${escapeHtml(r.accepted_date)}</td>
      <td>${escapeHtml(r.wechat)}</td>
      <td class="text-strong">${escapeHtml(r.task_name)}</td>
      <td>${escapeHtml(r.order_no)}</td>
      <td><span class="status-pill ${isOverdue(r) ? "danger" : ""}">${escapeHtml(r.deadline_status || "未填写")}</span></td>
      <td class="money">${formatMoney(r.price)}</td>
      <td class="money positive">${formatMoney(r.adjustment)}</td>
      <td class="money">${formatMoney(r.total_price)}</td>
      <td class="money positive">${formatMoney(r.paid)}</td>
      <td class="money remaining">${formatMoney(r.remaining)}</td>
      <td>
        <div class="row-actions">
          <a class="icon-btn" href="/payments?order_id=${r.id}">流水</a>
          <button class="icon-btn" onclick="editOrder(${r.id})">编辑</button>
          <button class="icon-btn delete" onclick="deleteOrder(${r.id})">删除</button>
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="12" class="empty">暂无订单</td></tr>`;
}

function getOrderFormPayload() {
  return {
    accepted_date: $("accepted_date").value,
    wechat: $("wechat").value,
    task_name: $("task_name").value,
    order_no: $("order_no").value,
    deadline_status: $("deadline_status").value,
    price: Number($("price").value || 0),
    initial_paid: Number($("initial_paid").value || 0),
    initial_pay_date: $("initial_pay_date").value,
  };
}

function resetOrderForm() {
  editingOrderId = null;
  $("orderForm").reset();
  $("recordId").value = "";
  $("price").value = 0;
  $("initial_paid").value = 0;
  $("remainingPreview").value = 0;
  $("initial_paid").disabled = false;
  $("initial_pay_date").disabled = false;
  $("orderFormTitle").textContent = "新增订单";
  $("orderSubmitBtn").textContent = "保存订单";
  $("cancelOrderEditBtn").classList.add("hidden");
  setDefaultDates();
}

window.editOrder = function(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  editingOrderId = id;
  $("recordId").value = id;
  $("accepted_date").value = r.accepted_date || today();
  $("wechat").value = r.wechat;
  $("task_name").value = r.task_name;
  $("order_no").value = r.order_no;
  $("deadline_status").value = r.deadline_status;
  $("price").value = r.price;
  $("initial_paid").value = 0;
  $("initial_pay_date").value = today();
  $("initial_paid").disabled = true;
  $("initial_pay_date").disabled = true;
  $("remainingPreview").value = numberFmt.format(r.remaining);
  $("orderFormTitle").textContent = `编辑订单 #${id}`;
  $("orderSubmitBtn").textContent = "更新订单";
  $("cancelOrderEditBtn").classList.remove("hidden");
  document.querySelector(".form-panel").scrollIntoView({ behavior: "smooth", block: "center" });
};

window.deleteOrder = async function(id) {
  if (!confirm(`确定删除订单 #${id}？对应付款和预算记录也会删除。`)) return;
  await api(`/api/records/${id}`, { method: "DELETE" });
  toast("订单已删除");
  if (editingOrderId === id) resetOrderForm();
  await loadAll(false);
};

/* ====== Payments ====== */

function renderOrderOptions(keepId) {
  const select = $("selectedOrder");
  if (!select) return;
  select.innerHTML = records.map((r) => `<option value="${r.id}">${escapeHtml(orderLabel(r))}</option>`).join("");
  if (keepId && records.some((r) => String(r.id) === String(keepId))) {
    select.value = keepId;
  } else if (records.length) {
    select.value = records[0].id;
  }
  if (!records.length) {
    select.innerHTML = `<option value="">暂无订单</option>`;
  }
  renderSelectedSummary();
}

function getSelectedOrder() {
  const select = $("selectedOrder");
  if (!select) return null;
  const id = Number(select.value || 0);
  return records.find((r) => r.id === id);
}

function renderSelectedSummary() {
  const r = getSelectedOrder();
  const el = $("selectedSummary");
  if (!el) return;
  if (!r) {
    el.textContent = "请选择订单";
    return;
  }
  el.innerHTML = `
    <span>订单总价 <b>${formatMoney(r.total_price)}</b></span>
    <span>已付 <b>${formatMoney(r.paid)}</b></span>
    <span>追加预算 <b>${formatMoney(r.adjustment)}</b></span>
    <span>剩余 <b class="danger-text">${formatMoney(r.remaining)}</b></span>
  `;
}

async function loadSelectedOrderDetails() {
  const r = getSelectedOrder();
  if (!r) {
    currentPayments = [];
    currentAdjustments = [];
    renderPaymentsTable();
    renderAdjustmentsTable();
    renderSelectedSummary();
    return;
  }
  [currentPayments, currentAdjustments] = await Promise.all([
    api(`/api/records/${r.id}/payments`),
    api(`/api/records/${r.id}/adjustments`),
  ]);
  renderPaymentsTable();
  renderAdjustmentsTable();
  renderSelectedSummary();
}

function renderPaymentsTable() {
  const body = $("paymentsBody");
  if (!body) return;
  body.innerHTML = currentPayments.map((p) => `
    <tr>
      <td>${p.id}</td><td>${escapeHtml(p.pay_date)}</td><td class="money positive">${formatMoney(p.amount)}</td><td>${escapeHtml(p.note)}</td>
      <td><div class="row-actions"><button class="icon-btn" onclick="editPayment(${p.id})">修改</button><button class="icon-btn delete" onclick="deletePayment(${p.id})">删除</button></div></td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="empty">当前订单暂无付款记录</td></tr>`;
}

function renderAdjustmentsTable() {
  const body = $("adjustmentsBody");
  if (!body) return;
  body.innerHTML = currentAdjustments.map((a) => `
    <tr>
      <td>${a.id}</td><td>${escapeHtml(a.change_date)}</td><td class="money positive">${formatMoney(a.amount)}</td><td>${escapeHtml(a.note)}</td>
      <td><div class="row-actions"><button class="icon-btn" onclick="editAdjustment(${a.id})">修改</button><button class="icon-btn delete" onclick="deleteAdjustment(${a.id})">删除</button></div></td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="empty">当前订单暂无预算记录</td></tr>`;
}

function getPaymentPayload() {
  return { pay_date: $("pay_date").value, amount: Number($("payment_amount").value || 0), note: $("payment_note").value };
}

function resetPaymentForm(resetDate = true) {
  editingPaymentId = null;
  $("paymentId").value = "";
  $("payment_amount").value = 0;
  $("payment_note").value = "";
  if (resetDate) $("pay_date").value = today();
  $("paymentFormTitle").textContent = "记录客户付款";
  $("paymentSubmitBtn").textContent = "保存付款";
  $("cancelPaymentEditBtn").classList.add("hidden");
}

window.editPayment = function(id) {
  const p = currentPayments.find((x) => x.id === id);
  if (!p) return;
  editingPaymentId = id;
  $("paymentId").value = id;
  $("pay_date").value = p.pay_date;
  $("payment_amount").value = p.amount;
  $("payment_note").value = p.note;
  $("paymentFormTitle").textContent = `修改付款 #${id}`;
  $("paymentSubmitBtn").textContent = "更新付款";
  $("cancelPaymentEditBtn").classList.remove("hidden");
};

window.deletePayment = async function(id) {
  if (!confirm(`确定删除付款记录 #${id}？`)) return;
  await api(`/api/payments/${id}`, { method: "DELETE" });
  toast("付款已删除");
  resetPaymentForm(false);
  await loadAll(true);
};

function getAdjustmentPayload() {
  return { change_date: $("change_date").value, amount: Number($("adjustment_amount").value || 0), note: $("adjustment_note").value };
}

function resetAdjustmentForm(resetDate = true) {
  editingAdjustmentId = null;
  $("adjustmentId").value = "";
  $("adjustment_amount").value = 0;
  $("adjustment_note").value = "";
  if (resetDate) $("change_date").value = today();
  $("adjustmentFormTitle").textContent = "增加客户预算";
  $("adjustmentSubmitBtn").textContent = "保存预算";
  $("cancelAdjustmentEditBtn").classList.add("hidden");
}

window.editAdjustment = function(id) {
  const a = currentAdjustments.find((x) => x.id === id);
  if (!a) return;
  editingAdjustmentId = id;
  $("adjustmentId").value = id;
  $("change_date").value = a.change_date;
  $("adjustment_amount").value = a.amount;
  $("adjustment_note").value = a.note;
  $("adjustmentFormTitle").textContent = `修改预算 #${id}`;
  $("adjustmentSubmitBtn").textContent = "更新预算";
  $("cancelAdjustmentEditBtn").classList.remove("hidden");
};

window.deleteAdjustment = async function(id) {
  if (!confirm(`确定删除预算记录 #${id}？`)) return;
  await api(`/api/adjustments/${id}`, { method: "DELETE" });
  toast("预算记录已删除");
  resetAdjustmentForm(false);
  await loadAll(true);
};

/* ====== Expenses ====== */

function getExpensePayload() {
  return {
    expense_date: $("expense_date").value,
    name: $("expense_name").value,
    amount: Number($("expense_amount").value || 0),
    note: $("expense_note").value,
  };
}

function resetExpenseForm() {
  editingExpenseId = null;
  $("expenseForm").reset();
  $("expenseId").value = "";
  $("expense_amount").value = 0;
  $("expense_date").value = today();
  $("expenseFormTitle").textContent = "工具费用支出";
  $("expenseSubmitBtn").textContent = "保存支出";
  $("cancelExpenseEditBtn").classList.add("hidden");
}

function renderExpensesTable() {
  const body = $("expensesBody");
  if (!body) return;
  body.innerHTML = expenses.map((e) => `
    <tr>
      <td>${e.id}</td><td>${escapeHtml(e.expense_date)}</td><td class="text-strong">${escapeHtml(e.name)}</td><td class="money expense">${formatMoney(e.amount)}</td><td>${escapeHtml(e.note)}</td>
      <td><div class="row-actions"><button class="icon-btn" onclick="editExpense(${e.id})">修改</button><button class="icon-btn delete" onclick="deleteExpense(${e.id})">删除</button></div></td>
    </tr>
  `).join("") || `<tr><td colspan="6" class="empty">暂无工具费用支出</td></tr>`;
}

window.editExpense = function(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  editingExpenseId = id;
  $("expenseId").value = id;
  $("expense_date").value = e.expense_date;
  $("expense_name").value = e.name;
  $("expense_amount").value = e.amount;
  $("expense_note").value = e.note;
  $("expenseFormTitle").textContent = `修改工具费用 #${id}`;
  $("expenseSubmitBtn").textContent = "更新支出";
  $("cancelExpenseEditBtn").classList.remove("hidden");
};

window.deleteExpense = async function(id) {
  if (!confirm(`确定删除工具费用 #${id}？`)) return;
  await api(`/api/expenses/${id}`, { method: "DELETE" });
  toast("工具费用已删除");
  if (editingExpenseId === id) resetExpenseForm();
  await loadAll(true);
};

/* ====== Import / Export ====== */

function fileFormData() {
  const file = $("importFile").files[0];
  if (!file) throw new Error("请先选择 Excel 文件");
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

function actionText(action) {
  return { create: "新增", update: "更新", unchanged: "不变" }[action] || action;
}

function renderImportPreview(data) {
  const s = data.summary;
  $("importSummary").innerHTML = `识别 ${escapeHtml(data.sheet_name)}：${s.parsed_count} 行，新增 ${s.created_count}，更新 ${s.updated_count}，不变 ${s.unchanged_count}，付款校正 ${s.payment_adjusted_count}`;
  const preview = data.preview || [];
  $("importPreview").classList.remove("hidden");
  $("importPreview").innerHTML = `
    <div class="preview-kpis">
      <span>表格总价 <b>${formatMoney(s.import_price)}</b></span>
      <span>表格到账 <b>${formatMoney(s.import_paid)}</b></span>
      <span>表格剩余 <b>${formatMoney(s.import_remaining)}</b></span>
      <span>跳过 <b>${s.skipped_count || (data.skipped || []).length}</b></span>
    </div>
    <div class="table-wrap preview-wrap">
      <table>
        <thead><tr><th>动作</th><th>行</th><th>微信号</th><th>任务</th><th>单号</th><th>价格</th><th>到账</th><th>付款差额</th></tr></thead>
        <tbody>
          ${preview.map((item) => `
            <tr>
              <td><span class="status-pill">${actionText(item.action)}</span></td>
              <td>${item.row.source_row}</td>
              <td>${escapeHtml(item.row.wechat)}</td>
              <td class="text-strong">${escapeHtml(item.row.task_name)}</td>
              <td>${escapeHtml(item.row.order_no)}</td>
              <td class="money">${formatMoney(item.row.price)}</td>
              <td class="money positive">${formatMoney(item.row.paid)}</td>
              <td class="money ${Number(item.payment_delta || 0) < 0 ? "expense" : "positive"}">${formatMoney(item.payment_delta)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function previewImport() {
  try {
    const data = await api("/api/import/preview", { method: "POST", body: fileFormData() });
    previewLoaded = true;
    $("applyImportBtn").disabled = false;
    renderImportPreview(data);
    toast("导入预览已生成");
  } catch (err) {
    previewLoaded = false;
    $("applyImportBtn").disabled = true;
    toast(err.message);
  }
}

async function applyImport() {
  try {
    if (!previewLoaded) return toast("请先预览导入");
    if (!confirm("确认导入？系统会先自动保存当前数据库快照。")) return;
    const data = await api("/api/import/xlsx", { method: "POST", body: fileFormData() });
    $("applyImportBtn").disabled = true;
    previewLoaded = false;
    toast(`导入完成：新增 ${data.summary.created_count}，更新 ${data.summary.updated_count}`);
    await loadAll(false);
  } catch (err) {
    toast(err.message);
  }
}

function renderHistory() {
  const body = $("versionsBody");
  if (!body) return;
  body.innerHTML = versions.map((v) => `
    <div class="history-item">
      <div>
        <b>#${v.id} ${escapeHtml(v.label)}</b>
        <span>${escapeHtml(v.created_at)} · ${v.record_count} 单 · ${escapeHtml(v.source_file || "本地操作")}</span>
      </div>
      <button class="btn danger small" type="button" onclick="rollbackVersion(${v.id})">回退</button>
    </div>
  `).join("") || `<div class="empty small-empty">暂无历史版本</div>`;
}

window.rollbackVersion = async function(id) {
  if (!confirm(`确定回退到历史版本 #${id}？回退前会自动再保存一份当前状态。`)) return;
  try {
    const res = await api(`/api/history/${id}/rollback`, { method: "POST", body: JSON.stringify({}) });
    toast(`已回退，回退前状态保存为 #${res.backup_id}`);
    await loadAll(false);
  } catch (err) {
    toast(err.message);
  }
};

async function loadDbInfo() {
  try {
    const data = await api("/api/sync/info");
    const info = data.info;
    $("dbInfo").innerHTML = `
      <span>订单数：</span><b>${info.record_count}</b><br>
      <span>付款记录：</span><b>${info.payment_count}</b><br>
      <span>预算记录：</span><b>${info.adjustment_count}</b><br>
      <span>支出记录：</span><b>${info.expense_count}</b><br>
      <span>已到账总额：</span><b>${formatMoney(info.total_paid)}</b><br>
      <span>剩余未收：</span><b>${formatMoney(info.total_remaining)}</b><br>
      <span>数据库大小：</span><b>${info.db_size_kb} KB</b><br>
      <span>最后更新：</span><b>${info.last_updated || "无"}</b>
    `;
  } catch (err) {
    $("dbInfo").textContent = `加载失败：${err.message}`;
  }
}

async function uploadDatabase() {
  const file = $("dbFile").files[0];
  if (!file) {
    toast("请先选择数据库文件");
    return;
  }
  if (!confirm("确定导入该数据库文件？当前数据库会自动备份。")) return;
  const fd = new FormData();
  fd.append("db", file);
  try {
    const statusEl = $("dbUploadStatus");
    statusEl.classList.remove("hidden");
    statusEl.textContent = "正在导入...";
    const data = await api("/api/sync/upload", { method: "POST", body: fd });
    statusEl.textContent = `导入成功！备份版本 #${data.backup_id}`;
    toast("数据库导入成功，页面将刷新...");
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    $("dbUploadStatus").classList.remove("hidden");
    $("dbUploadStatus").textContent = `导入失败：${err.message}`;
    toast(err.message);
  }
}

/* ====== Page Initialization ====== */

const page = document.body.dataset.page;

if (page === "dashboard") {
  $("refreshBtn").addEventListener("click", () => loadAll(true));
  document.querySelector(".unpaid-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-unpaid-tab]");
    if (!btn) return;
    unpaidTab = btn.dataset.unpaidTab;
    document.querySelectorAll(".unpaid-tabs .filter-chip").forEach((item) => item.classList.toggle("active", item === btn));
    renderUnpaidOverview();
  });
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 160);
  });
  loadAll().catch((err) => { console.error(err); toast(`加载失败：${err.message}`); });
}

if (page === "orders") {
  $("orderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getOrderFormPayload();
    if (editingOrderId) {
      await api(`/api/records/${editingOrderId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("订单已更新");
    } else {
      await api("/api/records", { method: "POST", body: JSON.stringify(payload) });
      toast("订单已保存");
    }
    resetOrderForm();
    await loadAll(false);
  });
  ["price", "initial_paid"].forEach((id) => $(id).addEventListener("input", calcRemaining));
  $("refreshBtn").addEventListener("click", () => loadAll(true));
  $("searchInput").addEventListener("input", renderOrdersTable);
  $("cancelOrderEditBtn").addEventListener("click", resetOrderForm);
  $("filterRow").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((item) => item.classList.toggle("active", item === btn));
    renderOrdersTable();
  });
  setDefaultDates();
  calcRemaining();
  loadAll().catch((err) => { console.error(err); toast(`加载失败：${err.message}`); });
}

if (page === "payments") {
  $("selectedOrder").addEventListener("change", async () => {
    renderSelectedSummary();
    resetPaymentForm(false);
    resetAdjustmentForm(false);
    await loadSelectedOrderDetails();
  });
  $("paymentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = getSelectedOrder();
    if (!r) return toast("请先选择订单");
    const payload = getPaymentPayload();
    if (editingPaymentId) {
      await api(`/api/payments/${editingPaymentId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("付款已更新");
    } else {
      await api(`/api/records/${r.id}/payments`, { method: "POST", body: JSON.stringify(payload) });
      toast("付款已入账");
    }
    resetPaymentForm();
    await loadAll(true);
  });
  $("adjustmentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = getSelectedOrder();
    if (!r) return toast("请先选择订单");
    const payload = getAdjustmentPayload();
    if (editingAdjustmentId) {
      await api(`/api/adjustments/${editingAdjustmentId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("预算已更新");
    } else {
      await api(`/api/records/${r.id}/adjustments`, { method: "POST", body: JSON.stringify(payload) });
      toast("预算已追加");
    }
    resetAdjustmentForm();
    await loadAll(true);
  });
  $("cancelPaymentEditBtn").addEventListener("click", () => resetPaymentForm());
  $("cancelAdjustmentEditBtn").addEventListener("click", () => resetAdjustmentForm());
  $("refreshBtn").addEventListener("click", () => loadAll(true));
  setDefaultDates();
  loadAll().then(() => {
    const orderId = getUrlParam('order_id');
    if (orderId && records.some(r => String(r.id) === orderId)) {
      $("selectedOrder").value = orderId;
      $("selectedOrder").dispatchEvent(new Event('change'));
    }
  }).catch((err) => { console.error(err); toast(`加载失败：${err.message}`); });
}

if (page === "expenses") {
  $("expenseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getExpensePayload();
    if (editingExpenseId) {
      await api(`/api/expenses/${editingExpenseId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("支出已更新");
    } else {
      await api("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
      toast("支出已保存");
    }
    resetExpenseForm();
    await loadAll(true);
  });
  $("cancelExpenseEditBtn").addEventListener("click", resetExpenseForm);
  $("refreshBtn").addEventListener("click", () => loadAll(true));
  setDefaultDates();
  loadAll().catch((err) => { console.error(err); toast(`加载失败：${err.message}`); });
}

if (page === "import-export") {
  $("previewImportBtn").addEventListener("click", previewImport);
  $("applyImportBtn").addEventListener("click", applyImport);
  $("reloadHistoryBtn").addEventListener("click", async () => {
    versions = await api("/api/history");
    renderHistory();
  });
  $("importFile").addEventListener("change", () => {
    previewLoaded = false;
    $("applyImportBtn").disabled = true;
    $("importSummary").textContent = $("importFile").files[0] ? `已选择：${$("importFile").files[0].name}` : "尚未选择文件";
    $("importPreview").classList.add("hidden");
  });
  $("dbUploadForm").addEventListener("submit", (e) => {
    e.preventDefault();
    uploadDatabase();
  });
  loadAll().catch((err) => { console.error(err); toast(`加载失败：${err.message}`); });
  loadDbInfo();
}
