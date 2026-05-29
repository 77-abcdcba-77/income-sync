"""
Sync Relay — 轻量中继服务
部署在 Render (免费层), 只做消息暂存转发, 不存业务数据。
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)
DATA_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "relay.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_relay() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                change_id TEXT NOT NULL UNIQUE,
                device_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                row_id INTEGER NOT NULL,
                operation TEXT NOT NULL,
                new_data TEXT NOT NULL,
                changed_at REAL NOT NULL,
                received_at REAL NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_changes_device ON changes(device_id)")
        conn.commit()


def cleanup_old_changes() -> None:
    cutoff = time.time() - 7 * 86400
    with get_conn() as conn:
        conn.execute("DELETE FROM changes WHERE received_at < ?", (cutoff,))
        conn.commit()


@app.route("/health")
def health():
    return jsonify({"ok": True, "service": "sync-relay"})


@app.route("/sync/push", methods=["POST"])
def sync_push():
    body = request.get_json(force=True) or {}
    device_id = body.get("device_id", "").strip()
    changes = body.get("changes", [])

    if not device_id:
        return jsonify({"ok": False, "error": "缺少 device_id"}), 400
    if not changes:
        return jsonify({"ok": True, "accepted": 0})

    now = time.time()
    accepted = 0
    with get_conn() as conn:
        for ch in changes:
            try:
                conn.execute(
                    """
                    INSERT INTO changes (change_id, device_id, table_name, row_id, operation, new_data, changed_at, received_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ch["change_id"], device_id, ch["table_name"],
                        ch["row_id"], ch["operation"], ch["new_data"],
                        ch["changed_at"], now,
                    ),
                )
                accepted += 1
            except sqlite3.IntegrityError:
                pass  # 重复的 change_id, 忽略
        conn.commit()

    # 异步清理不在这里, 每次 pull 时顺手清理
    return jsonify({"ok": True, "accepted": accepted})


@app.route("/sync/pull")
def sync_pull():
    device_id = request.args.get("device_id", "").strip()
    since_seq = int(request.args.get("since_seq", 0))

    if not device_id:
        return jsonify({"ok": False, "error": "缺少 device_id"}), 400

    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT seq, change_id, device_id, table_name, row_id, operation, new_data, changed_at
            FROM changes
            WHERE seq > ? AND device_id != ?
            ORDER BY seq ASC
            LIMIT 500
            """,
            (since_seq, device_id),
        ).fetchall()
        latest = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]

    changes = []
    for r in rows:
        changes.append({
            "seq": r["seq"],
            "change_id": r["change_id"],
            "device_id": r["device_id"],
            "table_name": r["table_name"],
            "row_id": r["row_id"],
            "operation": r["operation"],
            "new_data": r["new_data"],
            "changed_at": r["changed_at"],
        })

    # 顺手清理过期数据
    cutoff = time.time() - 7 * 86400
    with get_conn() as conn:
        conn.execute("DELETE FROM changes WHERE received_at < ?", (cutoff,))
        conn.commit()

    return jsonify({"ok": True, "changes": changes, "latest_seq": latest})


if __name__ == "__main__":
    init_relay()
    port = int(os.environ.get("PORT", 5051))
    print(f"Sync Relay 已启动: 0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
