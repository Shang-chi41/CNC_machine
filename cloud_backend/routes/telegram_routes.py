"""
cloud_backend/routes/telegram_routes.py
Webhook nhận lệnh từ Telegram + trigger gửi thông báo alarm.

Setup webhook một lần:
    curl https://api.telegram.org/bot{TOKEN}/setWebhook \
         -d "url=https://your-app.onrender.com/api/telegram/webhook"

Lệnh operator gửi qua Telegram:
    /status   → trạng thái máy + sensor mới nhất
    /alarms   → danh sách alarm chưa xử lý
    /stop     → Feed Hold (cần xác nhận thêm)
    /estop    → Dừng khẩn cấp (tạo command vào MongoDB)
    /resume   → Tiếp tục sau hold
    /help     → Danh sách lệnh

Endpoints:
    POST /api/telegram/webhook           → nhận update từ Telegram
    POST /api/telegram/notify/alarm      → Cloud gọi nội bộ để gửi alarm (từ sync)
    GET  /api/telegram/status            → kiểm tra bot còn sống không
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Any

from cloud_backend.services.mongo_service import docs_to_list, get_col
from cloud_backend.services.notification_service import notifier

router = APIRouter()
logger = logging.getLogger("cloud_backend.telegram_routes")

_VN_TZ     = timezone(timedelta(hours=7))
_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID",   "")

_COL_SENSOR  = "Sensor_Data"
_COL_ALARMS  = "Alarms"
_COL_CMDS    = "Machine_Commands"


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


def _push_command(action: str, params: dict, priority: int = 2) -> str:
    """Ghi lệnh vào Machine_Commands — giống control_routes."""
    result = get_col(_COL_CMDS).insert_one({
        "action":     action,
        "params":     params,
        "priority":   priority,
        "status":     "pending",
        "created_by": "telegram_bot",
        "created_at": _now_str(),
        "executed_at": None,
        "result":     None,
    })
    return str(result.inserted_id)


# ── Xác minh request đến từ Telegram thật (dùng secret token) ─────────────
def _verify_telegram(request_body: bytes, x_telegram_token: str) -> bool:
    """Xác minh webhook request đến từ Telegram.

    Telegram gửi header X-Telegram-Bot-Api-Secret-Token nếu đã setup.
    Nếu chưa setup secret, bỏ qua xác minh (chỉ dùng trong dev).
    """
    secret = os.getenv("TELEGRAM_WEBHOOK_SECRET", "")
    if not secret:
        return True   # dev mode: không xác minh
    expected = hmac.new(
        secret.encode(), request_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, x_telegram_token or "")


# ══════════════════════════════════════════════════════════════════════════
#  WEBHOOK  — Telegram gửi update tới đây
# ══════════════════════════════════════════════════════════════════════════

@router.post("/webhook", summary="Telegram webhook — nhận lệnh từ operator")
async def telegram_webhook(request: Request) -> dict:
    """Nhận Telegram Update và xử lý lệnh từ operator.

    Telegram gửi POST mỗi khi có tin nhắn mới vào bot.
    """
    body = await request.body()
    secret_header = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")

    if not _verify_telegram(body, secret_header):
        raise HTTPException(status_code=403, detail="Invalid Telegram signature")

    try:
        update = await request.json()
    except Exception:
        return {"ok": True}

    # Chỉ xử lý message (bỏ qua callback_query, edited_message...)
    message = update.get("message", {})
    if not message:
        return {"ok": True}

    chat_id = str(message.get("chat", {}).get("id", ""))
    text    = (message.get("text") or "").strip().lower()
    user    = message.get("from", {}).get("first_name", "Operator")

    # Bảo mật: chỉ chấp nhận từ chat_id đã cấu hình
    if _CHAT_ID and chat_id != _CHAT_ID:
        logger.warning(f"Telegram: từ chối chat_id={chat_id} không phải owner")
        return {"ok": True}

    # Dispatch lệnh
    reply = await _handle_command(text, user)

    # Gửi reply về Telegram
    if reply:
        await notifier.send_message(reply)

    return {"ok": True}


async def _handle_command(text: str, user: str) -> str:
    """Xử lý lệnh từ operator và trả về text reply."""

    # /help hoặc không nhận ra
    if text in ("/help", "help", "/start"):
        return (
            "🤖 *CNC Digital Twin Bot*\n\n"
            "Các lệnh hỗ trợ:\n"
            "📊 /status — Trạng thái máy\n"
            "🚨 /alarms — Alarm chưa xử lý\n"
            "🛑 /stop   — Feed Hold (dừng mềm)\n"
            "🆘 /estop  — Dừng khẩn cấp\n"
            "▶️ /resume — Tiếp tục sau hold\n"
            "ℹ️ /help   — Danh sách lệnh này"
        )

    # /status
    if text in ("/status", "status"):
        return _cmd_status()

    # /alarms
    if text in ("/alarms", "alarms"):
        return _cmd_alarms()

    # /stop — Feed Hold
    if text in ("/stop", "stop"):
        cmd_id = _push_command("stop", {}, priority=2)
        return (
            f"🛑 *Feed Hold đã được gửi*\n"
            f"Lệnh: `{cmd_id[:8]}...`\n"
            f"Operator: {user}\n"
            f"⚠️ Dùng /resume để tiếp tục"
        )

    # /estop — Dừng khẩn cấp
    if text in ("/estop", "estop", "emergency stop", "dừng"):
        cmd_id = _push_command("estop", {}, priority=1)
        # Lưu alarm
        get_col(_COL_ALARMS).insert_one({
            "level":      "critical",
            "message":    f"E-Stop bởi Telegram: {user}",
            "action":     "estop",
            "resolved":   False,
            "source":     "telegram",
            "created_at": _now_str(),
        })
        return (
            f"🆘 *DỪNG KHẨN CẤP ĐÃ ĐƯỢC GỬI*\n"
            f"Lệnh: `{cmd_id[:8]}...`\n"
            f"Operator: {user}\n"
            f"Edge Backend sẽ thực thi ngay."
        )

    # /resume
    if text in ("/resume", "resume", "tiếp tục"):
        cmd_id = _push_command("resume", {}, priority=2)
        return (
            f"▶️ *Resume đã được gửi*\n"
            f"Lệnh: `{cmd_id[:8]}...`\n"
            f"Operator: {user}"
        )

    # Không nhận ra lệnh
    return (
        f"❓ Không hiểu lệnh: `{text}`\n"
        "Gõ /help để xem danh sách lệnh."
    )


def _cmd_status() -> str:
    """Lấy trạng thái máy từ sensor mới nhất."""
    col = get_col(_COL_SENSOR)
    doc = col.find_one(sort=[("mqtt_timestamp", -1)])
    if not doc:
        doc = col.find_one(sort=[("timestamp", -1)])

    if not doc:
        return "📊 *Trạng thái máy:* Không có dữ liệu"

    # Kiểm tra độ tuổi dữ liệu
    ts_raw = doc.get("mqtt_timestamp") or doc.get("timestamp", "")
    age_s  = None
    try:
        ts    = datetime.fromisoformat(str(ts_raw))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=_VN_TZ)
        age_s = (datetime.now(_VN_TZ) - ts).total_seconds()
    except Exception:
        pass

    online     = age_s is not None and age_s < 10
    status_str = "🟢 Online" if online else f"🔴 Offline ({int(age_s or 0)}s trước)"

    axes    = doc.get("axes", {})
    current = doc.get("current", {})

    def pos(ax: str) -> float:
        return axes.get(ax, {}).get("position", doc.get(f"vi_tri_{ax}", 0.0))

    return (
        f"📊 *TRẠNG THÁI MÁY CNC*\n"
        f"Kết nối: {status_str}\n"
        f"📍 X={pos('x'):.2f}  Y={pos('y'):.2f}  Z={pos('z'):.2f} mm\n"
        f"⚡ Dòng: {current.get('rms', doc.get('load', 0.0)):.2f} A\n"
        f"🔧 Status: {doc.get('status', 'unknown')}\n"
        f"⏰ {str(ts_raw)[11:19]} (VN)"
    )


def _cmd_alarms() -> str:
    """Lấy danh sách alarm chưa xử lý."""
    col  = get_col(_COL_ALARMS)
    docs = list(col.find({"resolved": False}).sort("created_at", -1).limit(5))

    if not docs:
        return "✅ *Không có alarm nào chưa xử lý*"

    lines = [f"🚨 *{len(docs)} ALARM CHƯA XỬ LÝ:*\n"]
    for d in docs:
        level   = (d.get("level") or "warning").upper()
        msg     = d.get("message", "")[:80]
        ts      = str(d.get("created_at", ""))[11:19]
        emoji   = {"CRITICAL": "🔴", "WARNING": "🟡", "INFO": "🔵"}.get(level, "⚪")
        lines.append(f"{emoji} [{level}] {msg} ({ts})")

    if col.count_documents({"resolved": False}) > 5:
        total = col.count_documents({"resolved": False})
        lines.append(f"\n...và {total - 5} alarm khác. Xem HMI để biết thêm.")

    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════
#  NOTIFY ALARM  — sync_routes gọi sau khi nhận alarm từ Edge
# ══════════════════════════════════════════════════════════════════════════

class AlarmNotifyRequest(BaseModel):
    alarm: dict[str, Any]


@router.post("/notify/alarm", summary="Gửi alarm notification qua Telegram")
async def notify_alarm(body: AlarmNotifyRequest) -> dict:
    """Endpoint nội bộ: sync_routes gọi sau khi nhận alarm từ Edge.

    Chỉ gửi Telegram cho alarm từ warning trở lên.
    MongoDB đã được lưu bởi sync_routes rồi — ở đây chỉ gửi Telegram.
    """
    alarm = body.alarm
    level = (alarm.get("level") or "info").lower()

    if level == "info":
        return {"status": "skipped", "reason": "info level không gửi Telegram"}

    ok = await notifier.send_alarm(alarm)
    return {
        "status":  "sent" if ok else "failed",
        "level":   level,
        "enabled": notifier.enabled,
    }


# ══════════════════════════════════════════════════════════════════════════
#  BOT STATUS
# ══════════════════════════════════════════════════════════════════════════

@router.get("/status", summary="Kiểm tra Telegram bot")
def telegram_bot_status() -> dict:
    """Kiểm tra bot có được cấu hình không."""
    return {
        "enabled":     notifier.enabled,
        "has_token":   bool(_BOT_TOKEN),
        "has_chat_id": bool(_CHAT_ID),
        "webhook_path": "/api/telegram/webhook",
    }