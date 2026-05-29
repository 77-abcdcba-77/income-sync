"""
Sync Engine — 本地优先同步引擎 (Python / Windows)
==================================================
负责:
1. 追踪本地变更 (change_log 表)
2. 推送到 Relay (POST /sync/push)
3. 拉取远程变更 (GET /sync/pull)
4. LWW 冲突解决
5. 定时同步
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Thread

import requests

# ---- 配置 ----
RELAY_URL = os.environ.get("SYNC_RELAY_URL", "https://income-sync-relay.onrender.com")
SYNC_INTERVAL_SEC = int(os.environ.get("SYNC_INTERVAL_SEC", 30))
DEVICE_CONFIG_PATH = Path(__file__).resolve().parent / "data" / "device.json"


def get_device_id() -> str:
    """读取或生成设备标识。"""
    DEVICE_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DEVICE_CONFIG_PATH.exists():
        cfg = json.loads(DEVICE_CONFIG_PATH.read_text(encoding="utf-8"))
    else:
        cfg = {}
    did = cfg.get("device_id", "").strip()
    if not did:
        did = str(uuid.uuid4())[:12]
        cfg["device_id"] = did
        cfg["display_name"] = f"Windows-{did[:4]}"
        DEVICE_CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return did


def get_sync_state() -> dict:
    """读取同步状态：上次拉取的 seq 和上次推送的时间。"""
    cfg = json.loads(DEVICE_CONFIG_PATH.read_text(encoding="utf-8")) if DEVICE_CONFIG_PATH.exists() else {}
    return {
        "device_id": cfg.get("device_id", ""),
        "last_pull_seq": cfg.get("last_pull_seq", 0),
        "last_push_at": cfg.get("last_push_at", 0),
        "display_name": cfg.get("display_name", ""),
    }


def set_sync_state(last_pull_seq: int | None = None, last_push_at: float | None = None) -> None:
    cfg = json.loads(DEVICE_CONFIG_PATH.read_text(encoding="utf-8")) if DEVICE_CONFIG_PATH.exists() else {}
    if last_pull_seq is not None:
        cfg["last_pull_seq"] = last_pull_seq
    if last_push_at is not None:
        cfg["last_push_at"] = last_push_at
    DEVICE_CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def init_sync_tables(conn: sqlite3.Connection) -> None:
    """在现有数据库中创建同步所需的 change_log 表。"""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            change_id TEXT NOT NULL UNIQUE,
            device_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            row_id INTEGER NOT NULL,
            operation TEXT NOT NULL,
            new_data TEXT NOT NULL,
            changed_at REAL NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_change_log_synced ON change_log(synced)")


def log_change(
    conn: sqlite3.Connection,
    table_name: str,
    row_id: int,
    operation: str,
    new_data: dict,
) -> None:
    """记录一次本地变更到 change_log。"""
    device_id = get_device_id()
    change_id = str(uuid.uuid4())
    changed_at = time.time() * 1000  # 毫秒级时间戳
    conn.execute(
        """
        INSERT INTO change_log (change_id, device_id, table_name, row_id, operation, new_data, changed_at, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (change_id, device_id, table_name, row_id, operation, json.dumps(new_data, ensure_ascii=False), changed_at),
    )


def serialize_record(conn: sqlite3.Connection, table_name: str, row_id: int) -> dict | None:
    """把某张表的某行序列化为 dict，用于记录变更前的完整状态。"""
    row = conn.execute(f"SELECT * FROM {table_name} WHERE id = ?", (row_id,)).fetchone()
    if not row:
        return None
    return dict(row)


# ---- LWW 冲突解决 ----

def apply_remote_change(conn: sqlite3.Connection, change: dict) -> bool:
    """
    将一条远程变更应用到本地数据库。LWW 策略：
    - 比较 changed_at (毫秒时间戳)，新的覆盖旧的
    - 时间相同时，change_id 字典序大的胜出（确定性）
    - 本地 change_log 中已有相同 change_id 则跳过（幂等）
    """
    change_id = change["change_id"]
    table_name = change["table_name"]
    row_id = change["row_id"]
    operation = change["operation"]
    incoming_time = change["changed_at"]
    new_data = json.loads(change["new_data"]) if isinstance(change["new_data"], str) else change["new_data"]

    # 幂等检查
    exists = conn.execute(
        "SELECT 1 FROM change_log WHERE change_id = ?", (change_id,)
    ).fetchone()
    if exists:
        return False

    # 检查本地是否有更新的版本
    local_log = conn.execute(
        """
        SELECT change_id, changed_at FROM change_log
        WHERE table_name = ? AND row_id = ? AND device_id = ?
        ORDER BY changed_at DESC LIMIT 1
        """,
        (table_name, row_id, get_device_id()),
    ).fetchone()

    if local_log:
        local_time = local_log["changed_at"]
        if local_time > incoming_time:
            return False  # 本地版本更新，拒绝
        if local_time == incoming_time and local_log["change_id"] > change_id:
            return False  # 时间相同，本地 change_id 更大，拒绝

    # 应用变更
    if operation == "DELETE":
        conn.execute(f"DELETE FROM {table_name} WHERE id = ?", (row_id,))
    elif operation == "INSERT":
        columns = ", ".join(new_data.keys())
        placeholders = ", ".join(["?"] * len(new_data))
        values = list(new_data.values())
        conn.execute(
            f"INSERT OR REPLACE INTO {table_name} ({columns}) VALUES ({placeholders})",
            values,
        )
    elif operation == "UPDATE":
        set_clause = ", ".join(f"{k} = ?" for k in new_data.keys())
        values = list(new_data.values()) + [row_id]
        conn.execute(f"UPDATE {table_name} SET {set_clause} WHERE id = ?", values)

    # 记录到本地 change_log (标记为已同步)
    device_id = change["device_id"]
    conn.execute(
        """
        INSERT OR IGNORE INTO change_log (change_id, device_id, table_name, row_id, operation, new_data, changed_at, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """,
        (change_id, device_id, table_name, row_id, operation, json.dumps(new_data, ensure_ascii=False), incoming_time),
    )
    return True


# ---- Push / Pull ----

def push_changes(conn: sqlite3.Connection) -> int:
    """推送本地未同步的变更到 Relay。返回成功推送的数量。"""
    device_id = get_device_id()
    state = get_sync_state()

    rows = conn.execute(
        "SELECT * FROM change_log WHERE synced = 0 ORDER BY id ASC LIMIT 200"
    ).fetchall()

    if not rows:
        return 0

    changes = []
    for r in rows:
        changes.append({
            "change_id": r["change_id"],
            "table_name": r["table_name"],
            "row_id": r["row_id"],
            "operation": r["operation"],
            "new_data": r["new_data"],
            "changed_at": r["changed_at"],
        })

    try:
        resp = requests.post(
            f"{RELAY_URL}/sync/push",
            json={"device_id": device_id, "last_pull_seq": state["last_pull_seq"], "changes": changes},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("ok"):
                # 标记已同步
                ids = [r["id"] for r in rows]
                placeholders = ",".join("?" * len(ids))
                conn.execute(
                    f"UPDATE change_log SET synced = 1 WHERE id IN ({placeholders})", ids
                )
                conn.commit()
                set_sync_state(last_push_at=time.time())
                return data.get("accepted", len(changes))
    except requests.RequestException:
        pass

    return 0


def pull_changes(conn: sqlite3.Connection) -> int:
    """从 Relay 拉取远程变更并应用。返回应用的变更数量。"""
    device_id = get_device_id()
    state = get_sync_state()

    try:
        resp = requests.get(
            f"{RELAY_URL}/sync/pull",
            params={"device_id": device_id, "since_seq": state["last_pull_seq"]},
            timeout=10,
        )
        if resp.status_code != 200:
            return 0

        data = resp.json()
        if not data.get("ok"):
            return 0

        applied = 0
        for ch in data.get("changes", []):
            if apply_remote_change(conn, ch):
                applied += 1

        if data.get("latest_seq", 0) > state["last_pull_seq"]:
            set_sync_state(last_pull_seq=data["latest_seq"])

        conn.commit()
        return applied
    except requests.RequestException:
        return 0


def sync_now(conn: sqlite3.Connection) -> dict:
    """执行一次完整的同步周期。返回统计信息。"""
    pushed = push_changes(conn)
    pulled = pull_changes(conn)
    pending = conn.execute("SELECT COUNT(*) FROM change_log WHERE synced = 0").fetchone()[0]
    return {"pushed": pushed, "pulled": pulled, "pending": pending, "ok": True}


def start_sync_loop() -> None:
    """后台定时同步线程。"""
    from app import get_conn as app_get_conn

    def loop():
        while True:
            time.sleep(SYNC_INTERVAL_SEC)
            try:
                with app_get_conn() as conn:
                    sync_now(conn)
            except Exception:
                pass

    t = Thread(target=loop, daemon=True)
    t.start()
