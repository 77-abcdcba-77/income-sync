/**
 * app.js — PWA 主逻辑 / UI
 */
let currentTab = "dashboard";
let orderFilter = "all";

document.addEventListener("DOMContentLoaded", async () => {
  await getOrCreateDeviceId();
  initTabs();
  initSyncBadge();
  startSyncLoop();
  renderDashboard();
  // 启动时同步一次
  syncNow().then(() => updateSyncBadge());
  // 注册 Service Worker
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/static/pwa/sw.js"); } catch (_) {}
  }
});

// ---- Tabs ----

function initTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      switch (currentTab) {
        case "dashboard": renderDashboard(); break;
        case "orders": renderOrders(); break;
        case "expenses": renderExpenses(); break;
        case "sync": renderSyncPage(); break;
      }
    });
  });
}

function initSyncBadge() {
  document.getElementById("syncBadge").addEventListener("click", async () => {
    const result = await syncNow();
    updateSyncBadge();
    alert(`同步完成：推送 ${result.pushed}，拉取 ${result.pulled}，剩余 ${result.pending}`);
  });
}

// ---- Dashboard ----

async function renderDashboard() {
  const stats = await getStats();
  const unpaidAll = await getRecords("unpaid");
  const unpaidPartial = unpaidAll.filter(r => r.paid > 0);
  const unpaidNone = unpaidAll.filter(r => r.paid === 0);

  document.getElementById("mainContent").innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">本月收入</div>
        <div class="value green">¥${fmt(stats.monthPaid)}</div>
      </div>
      <div class="stat-card">
        <div class="label">未收尾款</div>
        <div class="value red">¥${fmt(stats.unpaidTotal)}</div>
      </div>
      <div class="stat-card">
        <div class="label">本月支出</div>
        <div class="value">¥${fmt(stats.monthExpense)}</div>
      </div>
      <div class="stat-card">
        <div class="label">本月净收入</div>
        <div class="value blue">¥${fmt(stats.monthNet)}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">未付款订单 (${unpaidAll.length})</div>
      <div class="filter-tabs">
        <button class="filter-tab active" data-df="all" onclick="switchUnpaidFilter(this,'all')">全部</button>
        <button class="filter-tab" data-df="partial" onclick="switchUnpaidFilter(this,'partial')">部分付款 (${unpaidPartial.length})</button>
        <button class="filter-tab" data-df="none" onclick="switchUnpaidFilter(this,'none')">未付款 (${unpaidNone.length})</button>
      </div>
      <div id="unpaidList">${renderUnpaidCards(unpaidAll)}</div>
    </div>

    <div class="section">
      <div class="section-title">客户排行</div>
      <div id="rankList">${renderRanking(await getRecords("all"))}</div>
    </div>
  `;
}

window.switchUnpaidFilter = function(btn, filter) {
  document.querySelectorAll(".filter-tab[data-df]").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  (async () => {
    const records = await getRecords(filter === "all" ? "unpaid" : filter);
    document.getElementById("unpaidList").innerHTML = renderUnpaidCards(records);
  })();
};

function renderUnpaidCards(records) {
  if (!records.length) return '<div class="empty"><div class="empty-icon">🎉</div><div class="empty-text">全部已结清</div></div>';
  return records.map(r => {
    const price = Number(r.price) || 0;
    const paid = Number(r.paid) || 0;
    const remaining = price - paid;
    const pct = price > 0 ? Math.round(paid / price * 100) : 0;
    const badge = paid > 0 ? "border-orange" : "border-red";
    return `
    <div class="card ${badge}" onclick="viewRecordDetail(${r.id})">
      <div class="card-row">
        <div>
          <div class="card-title">${esc(r.wechat || "未知")}</div>
          <div class="card-sub">${esc(r.taskName || "无任务名")}</div>
        </div>
        <div class="card-amount" style="color:${remaining > 0 ? 'var(--red)' : 'var(--green)'}">¥${fmt(remaining)}</div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="font-size:11px;color:var(--gray-400);margin-top:4px">总价 ¥${fmt(price)} · 已付 ¥${fmt(paid)} · ${pct}%</div>
    </div>`;
  }).join("");
}

function renderRanking(records) {
  const map = {};
  records.forEach(r => {
    const w = r.wechat || "未知";
    if (!map[w]) map[w] = { count: 0, total: 0, unpaid: 0 };
    map[w].count++;
    map[w].total += Number(r.price) || 0;
    map[w].unpaid += (Number(r.price) || 0) - (Number(r.paid) || 0);
  });
  const sorted = Object.entries(map).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  if (!sorted.length) return '<div class="empty"><div class="empty-text">暂无数据</div></div>';
  return sorted.map(([name, d], i) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div><span style="color:var(--gray-400);margin-right:8px">#${i+1}</span>${esc(name)}</div>
      <div style="text-align:right">
        <div style="font-weight:600">¥${fmt(d.total)}</div>
        <div style="font-size:11px;color:var(--red)">${d.unpaid > 0 ? '未收 ¥' + fmt(d.unpaid) : '已结清'}</div>
      </div>
    </div>
  `).join("");
}

// ---- Orders ----

async function renderOrders(filter = null) {
  if (filter !== null) orderFilter = filter;
  const records = await getRecords(orderFilter);
  const allCount = (await getRecords("all")).length;
  const unpaidCount = (await getRecords("unpaid")).length;

  document.getElementById("mainContent").innerHTML = `
    <div class="section">
      <div class="section-title">订单列表</div>
      <div class="filter-tabs">
        <button class="filter-tab ${orderFilter==='all'?'active':''}" onclick="renderOrders('all')">全部 (${allCount})</button>
        <button class="filter-tab ${orderFilter==='unpaid'?'active':''}" onclick="renderOrders('unpaid')">待收 (${unpaidCount})</button>
        <button class="filter-tab ${orderFilter==='partial'?'active':''}" onclick="renderOrders('partial')">部分付款</button>
        <button class="filter-tab ${orderFilter==='none'?'active':''}" onclick="renderOrders('none')">未付款</button>
      </div>
      <input class="search-bar" placeholder="搜索客户名/任务名/单号..." oninput="searchOrders(this.value)">
      <div id="orderList">${renderOrderCards(records)}</div>
    </div>
    <button class="fab" onclick="showOrderForm()">+</button>
  `;
}

window.searchOrders = async function(query) {
  const records = await getRecords(orderFilter);
  const q = query.toLowerCase();
  const filtered = records.filter(r =>
    (r.wechat || "").toLowerCase().includes(q) ||
    (r.taskName || "").toLowerCase().includes(q) ||
    (r.orderNo || "").toLowerCase().includes(q)
  );
  document.getElementById("orderList").innerHTML = renderOrderCards(filtered);
};

function renderOrderCards(records) {
  if (!records.length) return '<div class="empty"><div class="empty-text">暂无订单</div></div>';
  return records.map(r => {
    const remaining = (Number(r.price) || 0) - (Number(r.paid) || 0);
    const badgeClass = remaining <= 0 ? "paid-full" : (Number(r.paid) > 0 ? "paid-part" : "paid-none");
    const badgeText = remaining <= 0 ? "已结清" : (Number(r.paid) > 0 ? "部分付款" : "未付款");
    return `
    <div class="card" onclick="viewRecordDetail(${r.id})">
      <div class="card-row">
        <div>
          <div class="card-title">${esc(r.wechat || "未知")} · ${esc(r.taskName || "无任务名")}</div>
          <div class="card-sub">${esc(r.orderNo || "无单号")} · ${esc(r.acceptedDate || "")} · ${esc(r.deadlineStatus || "")}</div>
        </div>
        <span class="card-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-row" style="margin-top:6px">
        <span style="font-size:12px;color:var(--gray-600)">总价 ¥${fmt(r.price)} · 已付 ¥${fmt(r.paid)}</span>
        <span style="font-weight:600;color:${remaining>0?'var(--red)':'var(--green)'}">${remaining>0?'待收 ¥'+fmt(remaining):'✓'}</span>
      </div>
    </div>`;
  }).join("");
}

// ---- Order Detail ----

window.viewRecordDetail = async function(id) {
  const record = await getRecord(id);
  const payments = await getPayments(id);
  const adjustments = await getAdjustments(id);
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const adj = adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const total = (Number(record.price) || 0) + adj;
  const remaining = total - paid;

  document.getElementById("mainContent").innerHTML = `
    <div style="margin-bottom:12px">
      <button class="btn btn-outline btn-sm" onclick="renderOrders()">← 返回订单列表</button>
    </div>
    <div class="card">
      <div class="card-row">
        <div class="card-title">${esc(record.wechat)} · ${esc(record.taskName)}</div>
        <button class="btn btn-outline btn-sm" onclick="showOrderForm(${id})">编辑</button>
      </div>
      <div class="card-sub">单号：${esc(record.orderNo || "无")} · 接单：${esc(record.acceptedDate || "")} · 状态：${esc(record.deadlineStatus || "")}</div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><span style="font-size:11px;color:var(--gray-400)">基础价格</span><br><b>¥${fmt(record.price)}</b></div>
        <div><span style="font-size:11px;color:var(--gray-400)">预算追加</span><br><b style="color:var(--orange)">¥${fmt(adj)}</b></div>
        <div><span style="font-size:11px;color:var(--gray-400)">总价</span><br><b>¥${fmt(total)}</b></div>
      </div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><span style="font-size:11px;color:var(--gray-400)">已付</span><br><b style="color:var(--green)">¥${fmt(paid)}</b></div>
        <div><span style="font-size:11px;color:var(--gray-400)">剩余</span><br><b style="color:${remaining>0?'var(--red)':'var(--green)'}">¥${fmt(remaining)}</b></div>
        <div><span style="font-size:11px;color:var(--gray-400)">进度</span><br><b>${total>0?Math.round(paid/total*100):0}%</b></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">付款记录</div>
      ${renderPaymentList(payments)}
      <button class="btn btn-primary btn-block btn-sm" onclick="showPaymentForm(${id})" style="margin-top:8px">+ 添加付款</button>
    </div>

    <div class="section">
      <div class="section-title">预算追加</div>
      ${renderAdjustmentList(adjustments)}
      <button class="btn btn-outline btn-block btn-sm" onclick="showAdjustmentForm(${id})" style="margin-top:8px">+ 追加预算</button>
    </div>

    <div style="margin-top:20px">
      <button class="btn btn-danger btn-block btn-sm" onclick="deleteRecordConfirm(${id})">删除此订单</button>
    </div>
  `;
};

function renderPaymentList(payments) {
  if (!payments.length) return '<div class="empty"><div class="empty-text">暂无付款记录</div></div>';
  return payments.map(p => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="card-title">¥${fmt(p.amount)}</div>
        <div class="card-sub">${esc(p.payDate || "")} · ${esc(p.note || "")}</div>
      </div>
      <div>
        <button class="btn btn-outline btn-sm" onclick="showPaymentForm(${p.recordId},${p.id})" style="margin-right:4px">编辑</button>
        <button class="btn btn-danger btn-sm" onclick="deletePaymentConfirm(${p.id},${p.recordId})">删除</button>
      </div>
    </div>
  `).join("");
}

function renderAdjustmentList(adjustments) {
  if (!adjustments.length) return '<div class="empty"><div class="empty-text">暂无追加记录</div></div>';
  return adjustments.map(a => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="card-title">¥${fmt(a.amount)}</div>
        <div class="card-sub">${esc(a.changeDate || "")} · ${esc(a.note || "")}</div>
      </div>
      <div>
        <button class="btn btn-outline btn-sm" onclick="showAdjustmentForm(${a.recordId},${a.id})" style="margin-right:4px">编辑</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAdjustmentConfirm(${a.id},${a.recordId})">删除</button>
      </div>
    </div>
  `).join("");
}

// ---- Order Form Modal ----

window.showOrderForm = async function(id) {
  let data = {};
  if (id) {
    const r = await getRecord(id);
    data = {
      id: r.id, wechat: r.wechat || "", taskName: r.taskName || "",
      orderNo: r.orderNo || "", deadlineStatus: r.deadlineStatus || "",
      acceptedDate: r.acceptedDate || today(), price: r.price,
    };
  }
  const title = data.id ? "编辑订单" : "新增订单";
  showModal(`
    <div class="modal-header"><span>${title}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-group"><label>微信号 / 客户名</label><input id="fWechat" value="${esc(data.wechat)}"></div>
    <div class="form-group"><label>任务名字</label><input id="fTaskName" value="${esc(data.taskName)}"></div>
    <div class="form-row">
      <div class="form-group"><label>单号</label><input id="fOrderNo" value="${esc(data.orderNo)}"></div>
      <div class="form-group"><label>截止状态</label><input id="fDeadlineStatus" value="${esc(data.deadlineStatus)}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>接单日期</label><input id="fAcceptedDate" type="date" value="${data.acceptedDate || today()}"></div>
      <div class="form-group"><label>价格 ¥</label><input id="fPrice" type="number" step="0.01" value="${data.price || ''}"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="submitOrderForm(${data.id || 0})">保存</button>
    </div>
  `);
};

window.submitOrderForm = async function(id) {
  const data = {
    id: id || undefined,
    wechat: document.getElementById("fWechat").value,
    taskName: document.getElementById("fTaskName").value,
    orderNo: document.getElementById("fOrderNo").value,
    deadlineStatus: document.getElementById("fDeadlineStatus").value,
    acceptedDate: document.getElementById("fAcceptedDate").value,
    price: parseFloat(document.getElementById("fPrice").value) || 0,
  };
  await saveRecord(data);
  closeModal();
  if (currentTab === "orders") {
    await renderOrders();
  } else {
    await renderDashboard();
  }
  await syncNow();
  updateSyncBadge();
};

// ---- Payment Form ----

window.showPaymentForm = async function(recordId, paymentId) {
  let data = { recordId, payDate: today(), amount: "", note: "" };
  if (paymentId) {
    const payments = await DB.payments.get(Number(paymentId));
    if (payments) data = { recordId: payments.recordId, id: payments.id, payDate: payments.payDate || "", amount: payments.amount, note: payments.note || "" };
  }
  showModal(`
    <div class="modal-header"><span>${data.id?'编辑付款':'新增付款'}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-row">
      <div class="form-group"><label>日期</label><input id="fPayDate" type="date" value="${data.payDate}"></div>
      <div class="form-group"><label>金额 ¥</label><input id="fPayAmount" type="number" step="0.01" value="${data.amount}"></div>
    </div>
    <div class="form-group"><label>备注</label><input id="fPayNote" value="${esc(data.note)}"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="submitPaymentForm(${data.id||0},${recordId})">保存</button>
    </div>
  `);
};

window.submitPaymentForm = async function(id, recordId) {
  const data = {
    id: id || undefined, recordId,
    payDate: document.getElementById("fPayDate").value,
    amount: parseFloat(document.getElementById("fPayAmount").value) || 0,
    note: document.getElementById("fPayNote").value,
  };
  await savePayment(data);
  await updateRecordPaidAmount(recordId);
  closeModal();
  await viewRecordDetail(recordId);
  await syncNow();
  updateSyncBadge();
};

// ---- Adjustment Form ----

window.showAdjustmentForm = async function(recordId, adjId) {
  let data = { recordId, changeDate: today(), amount: "", note: "" };
  if (adjId) {
    const a = await DB.budgetChanges.get(Number(adjId));
    if (a) data = { recordId: a.recordId, id: a.id, changeDate: a.changeDate || "", amount: a.amount, note: a.note || "" };
  }
  showModal(`
    <div class="modal-header"><span>${data.id?'编辑追加':'追加预算'}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-row">
      <div class="form-group"><label>日期</label><input id="fAdjDate" type="date" value="${data.changeDate}"></div>
      <div class="form-group"><label>金额 ¥</label><input id="fAdjAmount" type="number" step="0.01" value="${data.amount}"></div>
    </div>
    <div class="form-group"><label>备注</label><input id="fAdjNote" value="${esc(data.note)}"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="submitAdjustmentForm(${data.id||0},${recordId})">保存</button>
    </div>
  `);
};

window.submitAdjustmentForm = async function(id, recordId) {
  const data = {
    id: id || undefined, recordId,
    changeDate: document.getElementById("fAdjDate").value,
    amount: parseFloat(document.getElementById("fAdjAmount").value) || 0,
    note: document.getElementById("fAdjNote").value,
  };
  await saveAdjustment(data);
  closeModal();
  await viewRecordDetail(recordId);
  await syncNow();
  updateSyncBadge();
};

// ---- Delete Confirmations ----

window.deleteRecordConfirm = async function(id) {
  if (!confirm("确定删除此订单及其关联的所有付款和预算记录吗？")) return;
  await deleteRecord(id);
  await syncNow();
  updateSyncBadge();
  renderOrders();
};

window.deletePaymentConfirm = async function(pid, recordId) {
  if (!confirm("确定删除此付款记录吗？")) return;
  await deletePayment(pid, recordId);
  await syncNow();
  updateSyncBadge();
  viewRecordDetail(recordId);
};

window.deleteAdjustmentConfirm = async function(aid, recordId) {
  if (!confirm("确定删除此预算追加记录吗？")) return;
  await deleteAdjustment(aid, recordId);
  await syncNow();
  updateSyncBadge();
  viewRecordDetail(recordId);
};

// ---- Expenses ----

async function renderExpenses() {
  const expenses = await getExpenses();
  const stats = await getStats();

  document.getElementById("mainContent").innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">总支出</div>
        <div class="value">¥${fmt(stats.totalExpense)}</div>
      </div>
      <div class="stat-card">
        <div class="label">本月支出</div>
        <div class="value">¥${fmt(stats.monthExpense)}</div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">支出列表</div>
      <div id="expenseList">${renderExpenseCards(expenses)}</div>
    </div>
    <button class="fab" onclick="showExpenseForm()">+</button>
  `;
}

function renderExpenseCards(expenses) {
  if (!expenses.length) return '<div class="empty"><div class="empty-text">暂无支出记录</div></div>';
  return expenses.map(e => `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">${esc(e.name || "未命名")}</div>
          <div class="card-sub">${esc(e.expenseDate || "")} · ${esc(e.note || "")}</div>
        </div>
        <span style="font-weight:700;color:var(--red)">¥${fmt(e.amount)}</span>
      </div>
      <div style="margin-top:4px">
        <button class="btn btn-outline btn-sm" onclick="showExpenseForm(${e.id})">编辑</button>
        <button class="btn btn-danger btn-sm" onclick="deleteExpenseConfirm(${e.id})">删除</button>
      </div>
    </div>
  `).join("");
}

window.showExpenseForm = async function(id) {
  let data = { expenseDate: today(), name: "", amount: "", note: "" };
  if (id) {
    const e = await DB.expenses.get(Number(id));
    if (e) data = { id: e.id, expenseDate: e.expenseDate || "", name: e.name || "", amount: e.amount, note: e.note || "" };
  }
  showModal(`
    <div class="modal-header"><span>${data.id?'编辑支出':'新增支出'}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="form-row">
      <div class="form-group"><label>日期</label><input id="fExpDate" type="date" value="${data.expenseDate}"></div>
      <div class="form-group"><label>金额 ¥</label><input id="fExpAmount" type="number" step="0.01" value="${data.amount}"></div>
    </div>
    <div class="form-group"><label>名称</label><input id="fExpName" value="${esc(data.name)}"></div>
    <div class="form-group"><label>备注</label><input id="fExpNote" value="${esc(data.note)}"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="submitExpenseForm(${data.id||0})">保存</button>
    </div>
  `);
};

window.submitExpenseForm = async function(id) {
  const data = {
    id: id || undefined,
    expenseDate: document.getElementById("fExpDate").value,
    name: document.getElementById("fExpName").value,
    amount: parseFloat(document.getElementById("fExpAmount").value) || 0,
    note: document.getElementById("fExpNote").value,
  };
  await saveExpense(data);
  closeModal();
  await renderExpenses();
  await syncNow();
  updateSyncBadge();
};

window.deleteExpenseConfirm = async function(id) {
  if (!confirm("确定删除此支出记录吗？")) return;
  await deleteExpense(id);
  await syncNow();
  updateSyncBadge();
  renderExpenses();
};

// ---- Sync Page ----

async function renderSyncPage() {
  const deviceId = await getOrCreateDeviceId();
  const state = await getSyncState();
  const pending = await DB.changeLog.where("synced").equals(0).count();
  const total = await DB.changeLog.count();
  const stats = await getStats();

  document.getElementById("mainContent").innerHTML = `
    <div class="section">
      <div class="section-title">同步状态</div>
      <div class="sync-card">
        <div class="sync-label">设备 ID</div>
        <div class="sync-value" style="font-family:monospace">${deviceId}</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">中继服务器</div>
        <div class="sync-value" style="font-family:monospace;font-size:13px">${RELAY_URL}</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">待同步变更</div>
        <div class="sync-value" style="color:${pending>0?'var(--orange)':'var(--green)'}">${pending} 条</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">累计变更记录</div>
        <div class="sync-value">${total} 条</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">上次拉取序号</div>
        <div class="sync-value" style="font-family:monospace">${state.lastPullSeq}</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">上次推送</div>
        <div class="sync-value">${state.lastPushAt ? new Date(state.lastPushAt*1000).toLocaleString("zh-CN") : "从未"}</div>
      </div>
      <div class="sync-card">
        <div class="sync-label">本地数据</div>
        <div class="sync-value">${stats.recordCount} 订单 · ¥${fmt(stats.totalPaid)} 已收 · ¥${fmt(stats.totalRemaining)} 待收</div>
      </div>
    </div>
    <button class="btn btn-primary btn-block" onclick="manualSync()">🔄 立即同步</button>
    <div style="margin-top:10px;text-align:center;font-size:12px;color:var(--gray-400)" id="syncInterval">后台每 ${SYNC_INTERVAL/1000} 秒自动同步</div>
  `;
}

window.manualSync = async function() {
  const btn = document.querySelector(".btn-primary.btn-block");
  btn.disabled = true;
  btn.textContent = "同步中...";
  const result = await syncNow();
  updateSyncBadge();
  btn.textContent = `✅ 推送 ${result.pushed} · 拉取 ${result.pulled} · 剩余 ${result.pending}`;
  setTimeout(() => { btn.textContent = "🔄 立即同步"; btn.disabled = false; }, 2000);
};

// ---- Modal ----

function showModal(html) {
  document.getElementById("modalBox").innerHTML = html;
  document.getElementById("modalOverlay").classList.remove("hidden");
}

window.closeModal = function() {
  document.getElementById("modalOverlay").classList.add("hidden");
};

document.getElementById("modalOverlay").addEventListener("click", function(e) {
  if (e.target === this) closeModal();
});

// ---- Helpers ----

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
