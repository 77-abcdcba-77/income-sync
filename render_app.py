"""
Render 云部署 — 合并了同步中继 + 完整 Web 应用
部署到 Render, 得到一个固定 URL, 手机/电脑随时随地访问
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import date, datetime
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, send_file

app = Flask(
    __name__,
    template_folder=str(Path(__file__).resolve().parent / "templates"),
    static_folder=str(Path(__file__).resolve().parent / "static"),
)

DATA_DIR = Path("/tmp/data")
DB_PATH = DATA_DIR / "records.db"
RELAY_DB_PATH = DATA_DIR / "relay.db"

# ---- Helpers ----

def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def today_text() -> str:
    return date.today().strftime("%Y-%m-%d")

def get_app_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def get_relay_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(RELAY_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def as_float(value) -> float:
    if value in (None, ""):
        return 0.0
    try:
        if isinstance(value, str):
            value = value.replace(",", "").replace("￥", "").replace("¥", "").replace("元", "").strip()
        return round(float(value), 2)
    except (TypeError, ValueError):
        return 0.0

def clean_text(value) -> str:
    return str(value or "").strip()

def clean_date(value) -> str:
    if isinstance(value, datetime):
        return value.date().strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    value = clean_text(value)
    if not value:
        return today_text()
    import re
    match = re.match(r"^(\d{4}-\d{1,2}-\d{1,2})", value)
    if not match:
        return today_text()
    parts = match.group(1).split("-")
    try:
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        return date(y, m, d).strftime("%Y-%m-%d")
    except ValueError:
        return today_text()

# ---- Init ----

def init_app_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_app_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wechat TEXT, task_name TEXT, order_no TEXT,
                deadline_status TEXT, accepted_date TEXT NOT NULL DEFAULT '',
                price REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0,
                remaining REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL, pay_date TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0, note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS budget_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL, change_date TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0, note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                expense_date TEXT NOT NULL, name TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0, note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_records_order_no ON records(order_no)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_record_id ON payments(record_id)")
        conn.commit()

def init_relay_db():
    with get_relay_conn() as conn:
        conn.execute("""
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
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq)")
        conn.commit()

# ---- Serialization ----

def serialize_row(conn, table, row_id):
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if "created_at" in d:
        del d["created_at"]
    return d

# === Sync Relay API ===

@app.route("/sync/push", methods=["POST"])
def relay_push():
    body = request.get_json(force=True) or {}
    device_id = body.get("device_id", "").strip()
    changes = body.get("changes", [])
    if not device_id:
        return jsonify({"ok": False, "error": "missing device_id"}), 400
    if not changes:
        return jsonify({"ok": True, "accepted": 0})
    now = time.time()
    accepted = 0
    with get_relay_conn() as conn:
        for ch in changes:
            try:
                conn.execute(
                    "INSERT INTO changes (change_id, device_id, table_name, row_id, operation, new_data, changed_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (ch["change_id"], device_id, ch["table_name"], ch["row_id"], ch["operation"], ch["new_data"], ch["changed_at"], now),
                )
                accepted += 1
            except sqlite3.IntegrityError:
                pass
        conn.commit()
    return jsonify({"ok": True, "accepted": accepted})


@app.route("/sync/pull")
def relay_pull():
    device_id = request.args.get("device_id", "").strip()
    since_seq = int(request.args.get("since_seq", 0))
    if not device_id:
        return jsonify({"ok": False, "error": "missing device_id"}), 400
    with get_relay_conn() as conn:
        rows = conn.execute(
            "SELECT seq, change_id, device_id, table_name, row_id, operation, new_data, changed_at FROM changes WHERE seq > ? AND device_id != ? ORDER BY seq ASC LIMIT 500",
            (since_seq, device_id),
        ).fetchall()
        latest = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        # cleanup
        cutoff = time.time() - 7 * 86400
        conn.execute("DELETE FROM changes WHERE received_at < ?", (cutoff,))
        conn.commit()
    changes = [{"seq": r["seq"], "change_id": r["change_id"], "device_id": r["device_id"], "table_name": r["table_name"], "row_id": r["row_id"], "operation": r["operation"], "new_data": r["new_data"], "changed_at": r["changed_at"]} for r in rows]
    return jsonify({"ok": True, "changes": changes, "latest_seq": latest})

# === Web Pages ===

@app.route("/")
def index():
    return redirect("/dashboard")

@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html", page="dashboard")

@app.route("/orders")
def orders():
    return render_template("orders.html", page="orders")

@app.route("/payments")
def payments():
    return render_template("payments.html", page="payments")

@app.route("/expenses")
def expenses():
    return render_template("expenses.html", page="expenses")

@app.route("/import-export")
def import_export():
    return render_template("import-export.html", page="import-export")

@app.route("/pwa")
@app.route("/pwa/")
def pwa():
    return app.send_static_file("pwa/index.html")

@app.route("/health")
def health():
    return jsonify({"ok": True, "service": "income-app"})

# === REST API ===

@app.route("/api/records", methods=["GET"])
def api_records():
    with get_app_conn() as conn:
        rows = conn.execute("""
            SELECT r.id, r.wechat, r.task_name, r.order_no, r.deadline_status,
                   r.accepted_date, r.price, r.created_at, r.updated_at,
                   COALESCE(p.total_paid, 0) AS paid,
                   COALESCE(b.total_adjustment, 0) AS adjustment
            FROM records r
            LEFT JOIN (
                SELECT record_id, SUM(amount) AS total_paid FROM payments GROUP BY record_id
            ) p ON p.record_id = r.id
            LEFT JOIN (
                SELECT record_id, SUM(amount) AS total_adjustment FROM budget_changes GROUP BY record_id
            ) b ON b.record_id = r.id
            ORDER BY r.accepted_date DESC, r.id DESC
        """).fetchall()

    result = []
    for row in rows:
        price = as_float(row["price"])
        adjustment = as_float(row["adjustment"])
        total_price = round(price + adjustment, 2)
        paid = as_float(row["paid"])
        result.append({
            "id": row["id"], "wechat": row["wechat"] or "", "task_name": row["task_name"] or "",
            "order_no": row["order_no"] or "", "deadline_status": row["deadline_status"] or "",
            "accepted_date": row["accepted_date"] or "", "price": price,
            "adjustment": adjustment, "total_price": total_price, "paid": paid,
            "remaining": round(total_price - paid, 2),
            "created_at": row["created_at"] or "", "updated_at": row["updated_at"] or "",
        })
    return jsonify(result)

@app.route("/api/records", methods=["POST"])
def api_create_record():
    data = request.get_json(force=True) or {}
    wechat = clean_text(data.get("wechat"))
    task_name = clean_text(data.get("task_name"))
    order_no = clean_text(data.get("order_no"))
    deadline_status = clean_text(data.get("deadline_status"))
    accepted_date = clean_date(data.get("accepted_date"))
    price = as_float(data.get("price"))
    initial_paid = as_float(data.get("initial_paid"))
    with get_app_conn() as conn:
        cur = conn.execute(
            "INSERT INTO records (wechat, task_name, order_no, deadline_status, accepted_date, price, paid, remaining, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (wechat, task_name, order_no, deadline_status, accepted_date, price, price, now_text(), now_text()),
        )
        rid = cur.lastrowid
        if initial_paid:
            conn.execute(
                "INSERT INTO payments (record_id, pay_date, amount, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (rid, accepted_date, initial_paid, "首笔付款", now_text(), now_text()),
            )
        conn.commit()
    return jsonify({"ok": True, "id": rid})

@app.route("/api/records/<int:record_id>", methods=["PUT"])
def api_update_record(record_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        conn.execute(
            "UPDATE records SET wechat=?, task_name=?, order_no=?, deadline_status=?, accepted_date=?, price=?, updated_at=? WHERE id=?",
            (clean_text(data.get("wechat")), clean_text(data.get("task_name")), clean_text(data.get("order_no")), clean_text(data.get("deadline_status")), clean_date(data.get("accepted_date")), as_float(data.get("price")), now_text(), record_id),
        )
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/records/<int:record_id>", methods=["DELETE"])
def api_delete_record(record_id):
    with get_app_conn() as conn:
        conn.execute("DELETE FROM payments WHERE record_id=?", (record_id,))
        conn.execute("DELETE FROM budget_changes WHERE record_id=?", (record_id,))
        conn.execute("DELETE FROM records WHERE id=?", (record_id,))
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/records/<int:record_id>/payments", methods=["GET"])
def api_record_payments(record_id):
    with get_app_conn() as conn:
        rows = conn.execute("SELECT * FROM payments WHERE record_id=? ORDER BY id DESC", (record_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/records/<int:record_id>/payments", methods=["POST"])
def api_create_payment(record_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        cur = conn.execute(
            "INSERT INTO payments (record_id, pay_date, amount, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (record_id, clean_date(data.get("pay_date")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), now_text()),
        )
        conn.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})

@app.route("/api/payments/<int:payment_id>", methods=["PUT"])
def api_update_payment(payment_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        conn.execute(
            "UPDATE payments SET pay_date=?, amount=?, note=?, updated_at=? WHERE id=?",
            (clean_date(data.get("pay_date")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), payment_id),
        )
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/payments/<int:payment_id>", methods=["DELETE"])
def api_delete_payment(payment_id):
    with get_app_conn() as conn:
        conn.execute("DELETE FROM payments WHERE id=?", (payment_id,))
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/records/<int:record_id>/adjustments", methods=["GET"])
def api_record_adjustments(record_id):
    with get_app_conn() as conn:
        rows = conn.execute("SELECT * FROM budget_changes WHERE record_id=? ORDER BY id DESC", (record_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/records/<int:record_id>/adjustments", methods=["POST"])
def api_create_adjustment(record_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        cur = conn.execute(
            "INSERT INTO budget_changes (record_id, change_date, amount, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (record_id, clean_date(data.get("change_date")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), now_text()),
        )
        conn.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})

@app.route("/api/adjustments/<int:adjustment_id>", methods=["PUT"])
def api_update_adjustment(adjustment_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        conn.execute(
            "UPDATE budget_changes SET change_date=?, amount=?, note=?, updated_at=? WHERE id=?",
            (clean_date(data.get("change_date")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), adjustment_id),
        )
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/adjustments/<int:adjustment_id>", methods=["DELETE"])
def api_delete_adjustment(adjustment_id):
    with get_app_conn() as conn:
        conn.execute("DELETE FROM budget_changes WHERE id=?", (adjustment_id,))
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/expenses", methods=["GET"])
def api_expenses():
    with get_app_conn() as conn:
        rows = conn.execute("SELECT * FROM expenses ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/expenses", methods=["POST"])
def api_create_expense():
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        cur = conn.execute(
            "INSERT INTO expenses (expense_date, name, amount, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (clean_date(data.get("expense_date")), clean_text(data.get("name")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), now_text()),
        )
        conn.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})

@app.route("/api/expenses/<int:expense_id>", methods=["PUT"])
def api_update_expense(expense_id):
    data = request.get_json(force=True) or {}
    with get_app_conn() as conn:
        conn.execute(
            "UPDATE expenses SET expense_date=?, name=?, amount=?, note=?, updated_at=? WHERE id=?",
            (clean_date(data.get("expense_date")), clean_text(data.get("name")), as_float(data.get("amount")), clean_text(data.get("note")), now_text(), expense_id),
        )
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
def api_delete_expense(expense_id):
    with get_app_conn() as conn:
        conn.execute("DELETE FROM expenses WHERE id=?", (expense_id,))
        conn.commit()
    return jsonify({"ok": True})

@app.route("/api/stats", methods=["GET"])
def api_stats():
    from collections import defaultdict

    with get_app_conn() as conn:
        records = conn.execute("""
            SELECT r.*, COALESCE(p.total_paid, 0) AS paid,
                   COALESCE(b.total_adjustment, 0) AS adjustment
            FROM records r
            LEFT JOIN (SELECT record_id, SUM(amount) AS total_paid FROM payments GROUP BY record_id) p ON p.record_id = r.id
            LEFT JOIN (SELECT record_id, SUM(amount) AS total_adjustment FROM budget_changes GROUP BY record_id) b ON b.record_id = r.id
        """).fetchall()
        payments_list = conn.execute("SELECT * FROM payments").fetchall()
        expenses_list = conn.execute("SELECT * FROM expenses").fetchall()

    records_data = []
    for row in records:
        price = as_float(row["price"]); adj = as_float(row["adjustment"])
        records_data.append({
            "id": row["id"], "wechat": row["wechat"] or "", "task_name": row["task_name"] or "",
            "deadline_status": row["deadline_status"] or "", "accepted_date": row["accepted_date"] or "",
            "price": price, "adjustment": adj, "total_price": round(price + adj, 2),
            "paid": as_float(row["paid"]),
            "remaining": round(price + adj - as_float(row["paid"]), 2),
            "created_at": row["created_at"] or "", "updated_at": row["updated_at"] or "",
        })

    payments = [{"id": p["id"], "record_id": p["record_id"], "pay_date": p["pay_date"],
                  "amount": as_float(p["amount"]), "note": p["note"] or ""} for p in payments_list]
    expenses = [{"id": e["id"], "expense_date": e["expense_date"], "name": e["name"] or "",
                  "amount": as_float(e["amount"]), "note": e["note"] or ""} for e in expenses_list]

    total_price = sum(r["total_price"] for r in records_data)
    total_adjustment = sum(r["adjustment"] for r in records_data)
    total_paid = sum(p["amount"] for p in payments)
    total_remaining = total_price - total_paid
    total_expense = sum(e["amount"] for e in expenses)

    _today = today_text()
    _month = _today[:7]
    _today_date = date.today()

    unpaid_count = 0; overdue_count = 0; due_soon_count = 0
    status_buckets = {}
    clients = {}

    for r in records_data:
        bucket = r["deadline_status"] or "未填写"
        status_buckets[bucket] = status_buckets.get(bucket, 0) + 1
        if r["remaining"] > 0:
            unpaid_count += 1
            try:
                from datetime import datetime as dt
                dl = (r["deadline_status"] or "")[:10]
                dl_date = dt.strptime(dl, "%Y-%m-%d").date()
                delta = (dl_date - _today_date).days
                if delta < 0: overdue_count += 1
                elif delta <= 7: due_soon_count += 1
            except ValueError:
                pass
        c = r["wechat"] or "未填写"
        clients.setdefault(c, {"client": c, "count": 0, "price": 0, "paid": 0, "remaining": 0})
        clients[c]["count"] += 1
        clients[c]["price"] += r["total_price"]
        clients[c]["paid"] += r["paid"]
        clients[c]["remaining"] += r["remaining"]

    daily_income = defaultdict(float)
    monthly_income = defaultdict(float)
    for p in payments:
        daily_income[p["pay_date"]] += p["amount"]
        monthly_income[p["pay_date"][:7]] += p["amount"]

    daily_expense = defaultdict(float)
    monthly_expense = defaultdict(float)
    for e in expenses:
        daily_expense[e["expense_date"]] += e["amount"]
        monthly_expense[e["expense_date"][:7]] += e["amount"]

    top_clients = sorted(clients.values(), key=lambda x: x["price"], reverse=True)[:10]

    return jsonify({
        "summary": {
            "count": len(records_data), "total_price": round(total_price, 2),
            "total_adjustment": round(total_adjustment, 2), "total_paid": round(total_paid, 2),
            "total_remaining": round(total_remaining, 2),
            "paid_rate": round((total_paid / total_price * 100) if total_price else 0, 2),
            "total_expense": round(total_expense, 2),
            "net_income": round(total_paid - total_expense, 2),
            "today_income": round(daily_income.get(_today, 0), 2),
            "month_income": round(monthly_income.get(_month, 0), 2),
            "today_expense": round(daily_expense.get(_today, 0), 2),
            "month_expense": round(monthly_expense.get(_month, 0), 2),
            "today_net": round(daily_income.get(_today, 0) - daily_expense.get(_today, 0), 2),
            "month_net": round(monthly_income.get(_month, 0) - monthly_expense.get(_month, 0), 2),
            "avg_order_value": round((total_price / len(records_data)) if records_data else 0, 2),
            "unpaid_count": unpaid_count, "overdue_count": overdue_count, "due_soon_count": due_soon_count,
        },
        "daily_income": [{"label": k, "value": round(v, 2)} for k, v in sorted(daily_income.items())],
        "monthly_income": [{"label": k, "value": round(v, 2)} for k, v in sorted(monthly_income.items())],
        "daily_expense": [{"label": k, "value": round(v, 2)} for k, v in sorted(daily_expense.items())],
        "monthly_expense": [{"label": k, "value": round(v, 2)} for k, v in sorted(monthly_expense.items())],
        "daily_cashflow": [{"label": k, "value": round(daily_income.get(k, 0) - daily_expense.get(k, 0), 2)} for k in sorted(set(daily_income) | set(daily_expense))],
        "monthly_cashflow": [{"label": k, "value": round(monthly_income.get(k, 0) - monthly_expense.get(k, 0), 2)} for k in sorted(set(monthly_income) | set(monthly_expense))],
        "status": [{"label": k, "value": v} for k, v in sorted(status_buckets.items())],
        "top_clients": [{"client": c["client"], "count": c["count"], "price": c["price"], "paid": c["paid"], "remaining": c["remaining"]} for c in top_clients],
    })

# Transfer data from app DB to relay / sync-compatible DB
@app.route("/api/sync/info", methods=["GET"])
def api_sync_info():
    with get_app_conn() as conn:
        record_count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        last_updated = conn.execute("SELECT MAX(updated_at) FROM records").fetchone()[0] or ""
    return jsonify({"ok": True, "info": {"record_count": record_count, "last_updated": last_updated}})

@app.route("/api/import/bulk", methods=["POST"])
def api_bulk_import():
    """一次性导入全部数据，用于从本地迁移到云端。"""
    body = request.get_json(force=True) or {}
    records_data = body.get("records", [])
    payments_data = body.get("payments", [])
    adjustments_data = body.get("budget_changes", [])
    expenses_data = body.get("expenses", [])

    id_map = {}  # old_id -> new_id (for records)
    stats = {"records": 0, "payments": 0, "budget_changes": 0, "expenses": 0}

    with get_app_conn() as conn:
        for r in records_data:
            old_id = r.get("id")
            cur = conn.execute(
                """INSERT INTO records (wechat, task_name, order_no, deadline_status, accepted_date, price, paid, remaining, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    clean_text(r.get("wechat")), clean_text(r.get("task_name")),
                    clean_text(r.get("order_no")), clean_text(r.get("deadline_status")),
                    clean_date(r.get("accepted_date")), as_float(r.get("price")),
                    as_float(r.get("paid")), as_float(r.get("remaining")),
                    r.get("created_at") or now_text(), r.get("updated_at") or now_text(),
                ),
            )
            new_id = cur.lastrowid
            if old_id is not None:
                id_map[old_id] = new_id
            stats["records"] += 1

        for p in payments_data:
            old_record_id = p.get("record_id")
            new_record_id = id_map.get(old_record_id)
            if new_record_id is None:
                continue
            conn.execute(
                """INSERT INTO payments (record_id, pay_date, amount, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    new_record_id, clean_date(p.get("pay_date")),
                    as_float(p.get("amount")), clean_text(p.get("note")),
                    p.get("created_at") or now_text(), p.get("updated_at") or now_text(),
                ),
            )
            stats["payments"] += 1

        for a in adjustments_data:
            old_record_id = a.get("record_id")
            new_record_id = id_map.get(old_record_id)
            if new_record_id is None:
                continue
            conn.execute(
                """INSERT INTO budget_changes (record_id, change_date, amount, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    new_record_id, clean_date(a.get("change_date")),
                    as_float(a.get("amount")), clean_text(a.get("note")),
                    a.get("created_at") or now_text(), a.get("updated_at") or now_text(),
                ),
            )
            stats["budget_changes"] += 1

        for e in expenses_data:
            conn.execute(
                """INSERT INTO expenses (expense_date, name, amount, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    clean_date(e.get("expense_date")), clean_text(e.get("name")),
                    as_float(e.get("amount")), clean_text(e.get("note")),
                    e.get("created_at") or now_text(), e.get("updated_at") or now_text(),
                ),
            )
            stats["expenses"] += 1

        conn.commit()

    return jsonify({"ok": True, "stats": stats})


# ---- Stub routes (compatible with frontend, not full featured) ----

@app.route("/api/history", methods=["GET"])
def api_history():
    return jsonify([])


@app.route("/api/sync/state", methods=["GET"])
def api_sync_state():
    with get_relay_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM changes").fetchone()[0]
        recent = conn.execute("SELECT * FROM changes ORDER BY seq DESC LIMIT 10").fetchall()
    return jsonify({
        "ok": True,
        "device": {"device_id": "cloud", "display_name": "Render Cloud"},
        "sync": {"last_pull_seq": 0, "last_push_at": 0, "pending_changes": 0, "total_changes": total},
        "recent_changes": [{"change_id": r["change_id"], "table_name": r["table_name"], "row_id": r["row_id"], "operation": r["operation"], "synced": True} for r in recent],
        "relay_url": "",
    })


@app.route("/api/sync/device", methods=["GET"])
def api_sync_device():
    return jsonify({"ok": True, "device_id": "cloud", "display_name": "Render Cloud", "last_pull_seq": 0, "last_push_at": 0, "pending_changes": 0, "total_changes": 0, "relay_url": "", "sync_interval_sec": 0})


@app.route("/api/sync/push", methods=["POST"])
def api_sync_push_now():
    return jsonify({"ok": True, "pushed": 0, "pulled": 0, "pending": 0})


@app.route("/api/import/preview", methods=["POST"])
def api_import_preview():
    return jsonify({"ok": False, "error": "云端暂不支持 Excel 导入，请在本地 Windows 版操作"})


@app.route("/api/import/xlsx", methods=["POST"])
def api_import_xlsx():
    return jsonify({"ok": False, "error": "云端暂不支持 Excel 导入，请在本地 Windows 版操作"})


@app.route("/api/sync/upload", methods=["POST"])
def api_sync_upload():
    return jsonify({"ok": False, "error": "云端暂不支持数据库上传"})


@app.route("/sync")
def sync_page():
    return render_template("sync.html", page="sync")


@app.errorhandler(404)
def page_not_found(error):
    if request.path.startswith("/api/") or request.path.startswith("/export/"):
        return jsonify({"ok": False, "error": "not found"}), 404
    return redirect("/dashboard")

# === Startup ===

if __name__ == "__main__":
    init_app_db()
    init_relay_db()
    port = int(os.environ.get("PORT", 5050))
    print(f"Income App + Sync Relay running on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
