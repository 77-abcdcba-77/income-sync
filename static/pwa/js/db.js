/**
 * db.js — IndexedDB 数据层 (Dexie.js)
 * 与 Windows 端 SQLite 结构一一对应
 */
const DB = new Dexie("IncomeTracker");

DB.version(1).stores({
  records: "id,wechat,taskName,orderNo,deadlineStatus,acceptedDate,price,paid,remaining,updatedAt",
  payments: "id,recordId,payDate,amount,note,updatedAt",
  budgetChanges: "id,recordId,changeDate,amount,note,updatedAt",
  expenses: "id,expenseDate,name,amount,note,updatedAt",
  changeLog: "++localId,changeId,deviceId,tableName,rowId,operation,newData,changedAt,synced",
  meta: "key",
});

// ---- Helpers ----

function today() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString().replace("T", " ").slice(0, 19); }
function tsMs() { return Date.now(); }

// ---- Device ID ----

async function getOrCreateDeviceId() {
  let row = await DB.meta.get("device_id");
  if (!row) {
    const id = crypto.randomUUID().slice(0, 12);
    await DB.meta.put({ key: "device_id", value: id });
    return id;
  }
  return row.value;
}

// ---- CRUD: Records (订单) ----

async function getRecords(filter = "all") {
  let records = await DB.records.orderBy("id").reverse().toArray();
  records.forEach(r => {
    r.price = Number(r.price) || 0;
    r.paid = Number(r.paid) || 0;
    r.remaining = Number(r.remaining) || 0;
  });
  if (filter === "unpaid") {
    records = records.filter(r => r.remaining > 0);
  } else if (filter === "partial") {
    records = records.filter(r => r.remaining > 0 && r.paid > 0);
  } else if (filter === "none") {
    records = records.filter(r => r.remaining > 0 && r.paid === 0);
  }
  return records;
}

async function getRecord(id) {
  const r = await DB.records.get(Number(id));
  if (r) {
    r.price = Number(r.price) || 0;
    r.paid = Number(r.paid) || 0;
    r.remaining = Number(r.remaining) || 0;
  }
  return r;
}

async function saveRecord(data) {
  const deviceId = await getOrCreateDeviceId();
  const now = nowISO();
  const price = Number(data.price) || 0;
  const paid = Number(data.paid) || 0;

  if (data.id) {
    // Update
    const id = Number(data.id);
    await DB.records.update(id, {
      wechat: data.wechat || "",
      taskName: data.taskName || "",
      orderNo: data.orderNo || "",
      deadlineStatus: data.deadlineStatus || "",
      acceptedDate: data.acceptedDate || today(),
      price,
      paid,
      remaining: price - paid,
      updatedAt: now,
    });
    await logLocalChange("records", id, "UPDATE", {
      wechat: data.wechat || "",
      taskName: data.taskName || "",
      orderNo: data.orderNo || "",
      deadlineStatus: data.deadlineStatus || "",
      acceptedDate: data.acceptedDate || today(),
      price, paid, remaining: price - paid, updatedAt: now,
    }, deviceId);
    return id;
  } else {
    // Insert
    const remaining = price - paid;
    const rid = await DB.records.put({
      wechat: data.wechat || "",
      taskName: data.taskName || "",
      orderNo: data.orderNo || "",
      deadlineStatus: data.deadlineStatus || "",
      acceptedDate: data.acceptedDate || today(),
      price, paid, remaining,
      createdAt: now,
      updatedAt: now,
    });
    await logLocalChange("records", rid, "INSERT", {
      id: rid, wechat: data.wechat || "", taskName: data.taskName || "",
      orderNo: data.orderNo || "", deadlineStatus: data.deadlineStatus || "",
      acceptedDate: data.acceptedDate || today(),
      price, paid, remaining, updatedAt: now,
    }, deviceId);
    return rid;
  }
}

async function deleteRecord(id) {
  await DB.payments.where("recordId").equals(Number(id)).delete();
  await DB.budgetChanges.where("recordId").equals(Number(id)).delete();
  await DB.records.delete(Number(id));
  const deviceId = await getOrCreateDeviceId();
  await logLocalChange("records", Number(id), "DELETE", { id: Number(id) }, deviceId);
}

// ---- CRUD: Payments (付款) ----

async function getPayments(recordId) {
  return await DB.payments.where("recordId").equals(Number(recordId)).toArray();
}

async function savePayment(data) {
  const deviceId = await getOrCreateDeviceId();
  const now = nowISO();
  const amount = Number(data.amount) || 0;
  if (data.id) {
    const id = Number(data.id);
    await DB.payments.update(id, {
      payDate: data.payDate || today(), amount, note: data.note || "", updatedAt: now,
    });
    await logLocalChange("payments", id, "UPDATE", {
      id, recordId: Number(data.recordId), payDate: data.payDate || today(), amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return id;
  } else {
    const pid = await DB.payments.put({
      recordId: Number(data.recordId),
      payDate: data.payDate || today(), amount, note: data.note || "",
      createdAt: now, updatedAt: now,
    });
    await logLocalChange("payments", pid, "INSERT", {
      id: pid, recordId: Number(data.recordId),
      payDate: data.payDate || today(), amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return pid;
  }
}

async function deletePayment(id, recordId) {
  await DB.payments.delete(Number(id));
  const deviceId = await getOrCreateDeviceId();
  await logLocalChange("payments", Number(id), "DELETE", { id: Number(id), recordId: Number(recordId) }, deviceId);
  await updateRecordPaidAmount(Number(recordId));
}

// ---- CRUD: Budget Changes (预算调整) ----

async function getAdjustments(recordId) {
  return await DB.budgetChanges.where("recordId").equals(Number(recordId)).toArray();
}

async function saveAdjustment(data) {
  const deviceId = await getOrCreateDeviceId();
  const now = nowISO();
  const amount = Number(data.amount) || 0;
  if (data.id) {
    const id = Number(data.id);
    await DB.budgetChanges.update(id, {
      changeDate: data.changeDate || today(), amount, note: data.note || "", updatedAt: now,
    });
    await logLocalChange("budgetChanges", id, "UPDATE", {
      id, recordId: Number(data.recordId), changeDate: data.changeDate || today(), amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return id;
  } else {
    const aid = await DB.budgetChanges.put({
      recordId: Number(data.recordId),
      changeDate: data.changeDate || today(), amount, note: data.note || "",
      createdAt: now, updatedAt: now,
    });
    await logLocalChange("budgetChanges", aid, "INSERT", {
      id: aid, recordId: Number(data.recordId),
      changeDate: data.changeDate || today(), amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return aid;
  }
}

async function deleteAdjustment(id, recordId) {
  await DB.budgetChanges.delete(Number(id));
  const deviceId = await getOrCreateDeviceId();
  await logLocalChange("budgetChanges", Number(id), "DELETE", { id: Number(id), recordId: Number(recordId) }, deviceId);
}

// ---- CRUD: Expenses (支出) ----

async function getExpenses() {
  return await DB.expenses.orderBy("id").reverse().toArray();
}

async function saveExpense(data) {
  const deviceId = await getOrCreateDeviceId();
  const now = nowISO();
  const amount = Number(data.amount) || 0;
  if (data.id) {
    const id = Number(data.id);
    await DB.expenses.update(id, {
      expenseDate: data.expenseDate || today(), name: data.name || "", amount, note: data.note || "", updatedAt: now,
    });
    await logLocalChange("expenses", id, "UPDATE", {
      id, expenseDate: data.expenseDate || today(), name: data.name || "", amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return id;
  } else {
    const eid = await DB.expenses.put({
      expenseDate: data.expenseDate || today(), name: data.name || "", amount, note: data.note || "",
      createdAt: now, updatedAt: now,
    });
    await logLocalChange("expenses", eid, "INSERT", {
      id: eid, expenseDate: data.expenseDate || today(), name: data.name || "", amount, note: data.note || "", updatedAt: now,
    }, deviceId);
    return eid;
  }
}

async function deleteExpense(id) {
  await DB.expenses.delete(Number(id));
  const deviceId = await getOrCreateDeviceId();
  await logLocalChange("expenses", Number(id), "DELETE", { id: Number(id) }, deviceId);
}

// ---- Change Log ----

async function logLocalChange(tableName, rowId, operation, newData, deviceId) {
  const changeId = crypto.randomUUID();
  await DB.changeLog.put({
    changeId, deviceId, tableName, rowId, operation,
    newData: JSON.stringify(newData), changedAt: tsMs(), synced: 0,
  });
}

// ---- Recalculate record paid/remaining ----

async function updateRecordPaidAmount(recordId) {
  const payments = await DB.payments.where("recordId").equals(recordId).toArray();
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const record = await DB.records.get(recordId);
  if (record) {
    const price = Number(record.price) || 0;
    await DB.records.update(recordId, { paid, remaining: price - paid, updatedAt: nowISO() });
  }
}

// ---- Stats ----

async function getStats() {
  const records = await DB.records.toArray();
  const expenses = await DB.expenses.toArray();

  let totalIncome = 0, totalPaid = 0, totalRemaining = 0, totalExpense = 0;

  records.forEach(r => {
    const price = Number(r.price) || 0;
    const paid = Number(r.paid) || 0;
    totalIncome += price;
    totalPaid += paid;
    totalRemaining += (price - paid);
  });

  expenses.forEach(e => { totalExpense += Number(e.amount) || 0; });

  // 本月数据
  const now = new Date();
  const m = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  let monthIncome = 0, monthPaid = 0, monthExpense = 0;
  records.forEach(r => {
    if ((r.acceptedDate || "").startsWith(m)) monthIncome += Number(r.price) || 0;
  });
  // monthly paid from payments
  const allPays = await DB.payments.toArray();
  allPays.forEach(p => {
    if ((p.payDate || "").startsWith(m)) monthPaid += Number(p.amount) || 0;
  });
  expenses.forEach(e => {
    if ((e.expenseDate || "").startsWith(m)) monthExpense += Number(e.amount) || 0;
  });

  const unpaidRecords = records.filter(r => (Number(r.price) || 0) - (Number(r.paid) || 0) > 0);

  return {
    recordCount: records.length,
    totalIncome: round(totalIncome),
    totalPaid: round(totalPaid),
    totalRemaining: round(totalRemaining),
    totalExpense: round(totalExpense),
    netIncome: round(totalPaid - totalExpense),
    monthIncome: round(monthIncome),
    monthPaid: round(monthPaid),
    monthExpense: round(monthExpense),
    monthNet: round(monthPaid - monthExpense),
    unpaidCount: unpaidRecords.length,
    unpaidTotal: round(unpaidRecords.reduce((s, r) => s + (Number(r.price) || 0) - (Number(r.paid) || 0), 0)),
  };
}

function round(v) { return Math.round(v * 100) / 100; }

// ---- Import from JSON (用于从 Windows 端迁移数据) ----

async function importFromJSON(jsonData) {
  const { records, payments, budgetChanges, expenses } = jsonData;
  if (records) await DB.records.bulkPut(records.map(r => ({...r, taskName: r.task_name || r.taskName || "", orderNo: r.order_no || r.orderNo || "", deadlineStatus: r.deadline_status || r.deadlineStatus || "", acceptedDate: r.accepted_date || r.acceptedDate || "", updatedAt: r.updated_at || r.updatedAt || nowISO() })));
  if (payments) await DB.payments.bulkPut(payments.map(p => ({...p, recordId: p.record_id || p.recordId, payDate: p.pay_date || p.payDate || "", updatedAt: p.updated_at || p.updatedAt || nowISO() })));
  if (budgetChanges) await DB.budgetChanges.bulkPut(budgetChanges.map(b => ({...b, recordId: b.record_id || b.recordId, changeDate: b.change_date || b.changeDate || "", updatedAt: b.updated_at || b.updatedAt || nowISO() })));
  if (expenses) await DB.expenses.bulkPut(expenses.map(e => ({...e, expenseDate: e.expense_date || e.expenseDate || "", updatedAt: e.updated_at || e.updatedAt || nowISO() })));
}
