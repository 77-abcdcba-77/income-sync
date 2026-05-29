/**
 * sync.js — P2P 同步引擎 (JavaScript / PWA)
 * 与 Windows sync_engine.py 使用相同的 Relay 协议
 */
let RELAY_URL = "https://income-sync-relay.onrender.com";
let SYNC_INTERVAL = 30000; // 30 秒

// ---- Sync State ----

async function getSyncState() {
  let row = await DB.meta.get("sync_state");
  if (!row) return { lastPullSeq: 0, lastPushAt: 0 };
  return JSON.parse(row.value);
}

async function setSyncState(partial) {
  let state = await getSyncState();
  Object.assign(state, partial);
  await DB.meta.put({ key: "sync_state", value: JSON.stringify(state) });
}

// ---- Push ----

async function pushChanges() {
  const deviceId = await getOrCreateDeviceId();
  const state = await getSyncState();
  const pending = await DB.changeLog.where("synced").equals(0).limit(200).toArray();

  if (pending.length === 0) return 0;

  const changes = pending.map(r => ({
    change_id: r.changeId,
    table_name: r.tableName,
    row_id: r.rowId,
    operation: r.operation,
    new_data: r.newData,
    changed_at: r.changedAt,
  }));

  try {
    const resp = await fetch(`${RELAY_URL}/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, last_pull_seq: state.lastPullSeq, changes }),
    });
    if (!resp.ok) return 0;
    const data = await resp.json();
    if (data.ok) {
      await DB.changeLog.where("synced").equals(0).modify({ synced: 1 });
      await setSyncState({ lastPushAt: Date.now() / 1000 });
      return data.accepted || 0;
    }
  } catch (_) {}
  return 0;
}

// ---- Pull ----

async function pullChanges() {
  const deviceId = await getOrCreateDeviceId();
  const state = await getSyncState();

  try {
    const resp = await fetch(
      `${RELAY_URL}/sync/pull?device_id=${deviceId}&since_seq=${state.lastPullSeq}`
    );
    if (!resp.ok) return 0;
    const data = await resp.json();
    if (!data.ok) return 0;

    let applied = 0;
    for (const ch of data.changes || []) {
      if (await applyRemoteChange(ch)) applied++;
    }

    if ((data.latest_seq || 0) > state.lastPullSeq) {
      await setSyncState({ lastPullSeq: data.latest_seq });
    }
    return applied;
  } catch (_) {}
  return 0;
}

// ---- Apply Remote Change (LWW) ----

async function applyRemoteChange(ch) {
  const changeId = ch.change_id || ch.changeId;
  const tableName = ch.table_name || ch.tableName;
  const rowId = ch.row_id || ch.rowId;
  const operation = ch.operation;
  const incomingTime = ch.changed_at || ch.changedAt || 0;
  let newData = ch.new_data || ch.newData || "{}";
  if (typeof newData === "string") newData = JSON.parse(newData);

  // 幂等检查
  const exists = await DB.changeLog.where("changeId").equals(changeId).first();
  if (exists) return false;

  // LWW 冲突检测
  const deviceId = await getOrCreateDeviceId();
  const localLog = await DB.changeLog
    .where("[tableName+rowId]")
    .equals([tableName, rowId])
    .filter(r => r.deviceId === deviceId)
    .last();

  if (localLog) {
    if (localLog.changedAt > incomingTime) return false;
    if (localLog.changedAt === incomingTime && localLog.changeId > changeId) return false;
  }

  // 映射表名
  const tableMap = {
    records: "records",
    payments: "payments",
    budget_changes: "budgetChanges",
    expenses: "expenses",
    budgetChanges: "budgetChanges",
  };
  const tbl = tableMap[tableName] || tableName;

  // 应用变更
  try {
    if (operation === "DELETE") {
      await DB.table(tbl).delete(Number(rowId));
    } else if (operation === "INSERT" || operation === "UPDATE") {
      const item = { ...newData, id: Number(rowId) };
      await DB.table(tbl).put(item);
    }

    // 记录到本地
    await DB.changeLog.put({
      changeId, deviceId: ch.device_id || ch.deviceId,
      tableName, rowId, operation,
      newData: JSON.stringify(newData), changedAt: incomingTime, synced: 1,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// ---- Full Sync ----

async function syncNow() {
  const pushed = await pushChanges();
  const pulled = await pullChanges();
  const pending = await DB.changeLog.where("synced").equals(0).count();
  return { pushed, pulled, pending };
}

// ---- Background Sync Loop ----

let syncTimer = null;

function startSyncLoop() {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    try { await syncNow(); updateSyncBadge(); } catch (_) {}
  }, SYNC_INTERVAL);
}

function stopSyncLoop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// ---- Sync Badge ----

async function updateSyncBadge() {
  const badge = document.getElementById("syncBadge");
  if (!badge) return;
  const pending = await DB.changeLog.where("synced").equals(0).count();
  badge.className = "sync-badge";
  if (pending > 0) {
    badge.textContent = "↻";
    badge.classList.add("pending");
    badge.title = `${pending} 条待同步`;
  } else {
    badge.textContent = "✓";
    badge.classList.add("ok");
    badge.title = "已同步";
  }
}
