"""
cloud_backend/services/notification_service.py
Gửi thông báo Telegram khi có alarm.

Hai nơi gọi service này:
  1. Cloud Backend — sync_routes.py nhận alarm từ Edge → gửi Telegram (warning+)
  2. Edge Backend  — anomaly_detector.py gọi thẳng khi CRITICAL (không qua Cloud)
     (Edge import trực tiếp nếu TELEGRAM_BOT_TOKEN có trong .env Edge)

Env vars:
    TELEGRAM_BOT_TOKEN   Token bot từ @BotFather
    TELEGRAM_CHAT_ID     Chat ID của operator (hoặc group lab)
    TELEGRAM_ENABLED     true | false (mặc định true nếu có TOKEN)

Sử dụng:
    from cloud_backend.services.notification_service import notifier
    await notifier.send_alarm(alarm_doc)
    notifier.send_alarm_sync(alarm_doc)   # nếu không dùng async
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger("cloud_backend.notification_service")

_VN_TZ    = timezone(timedelta(hours=7))
_BASE_URL = "https://api.telegram.org/bot{token}/{method}"
_TIMEOUT  = 10.0   # giây

# Emoji map theo alarm level
_LEVEL_EMOJI = {
    "info":      "ℹ️",
    "warning":   "⚠️",
    "critical":  "🚨",
    "emergency": "🆘",
}

# Cooldown tránh spam Telegram (giây) — theo từng level
_COOLDOWN = {
    "info":      300,   # 5 phút
    "warning":   120,   # 2 phút
    "critical":  0,     # không cooldown
    "emergency": 0,
}


class TelegramNotifier:
    """Gửi thông báo alarm đến Telegram Bot.

    Hỗ trợ cả async (send_alarm) và sync (send_alarm_sync).
    """

    def __init__(self) -> None:
        self._token    = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self._chat_id  = os.getenv("TELEGRAM_CHAT_ID",  "")
        self._enabled  = bool(self._token and self._chat_id)
        self._last_sent: dict[str, datetime] = {}   # level → last sent time

        if self._enabled:
            logger.info(f"TelegramNotifier OK — chat_id={self._chat_id}")
        else:
            logger.warning(
                "TelegramNotifier bị tắt — thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID"
            )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def send_alarm(self, alarm: dict[str, Any]) -> bool:
        """Gửi alarm notification (async).

        Args:
            alarm: dict từ MongoDB Alarms collection.

        Returns:
            True nếu gửi thành công.
        """
        if not self._enabled:
            return False

        level = (alarm.get("level") or "warning").lower()

        # Kiểm tra cooldown
        if not self._check_cooldown(level):
            logger.debug(f"Telegram cooldown: bỏ qua alarm level={level}")
            return False

        text = self._format_alarm(alarm)
        ok   = await self._send_message(text)

        if ok:
            self._last_sent[level] = datetime.now(_VN_TZ)
            logger.info(f"Telegram gửi OK: level={level}")
        return ok

    def send_alarm_sync(self, alarm: dict[str, Any]) -> bool:
        """Gửi alarm notification (sync wrapper).

        Dùng khi gọi từ Edge Backend anomaly_detector (không có event loop).
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Nếu đang trong async context, tạo task
                asyncio.ensure_future(self.send_alarm(alarm))
                return True
            else:
                return loop.run_until_complete(self.send_alarm(alarm))
        except RuntimeError:
            # Tạo loop mới nếu không có
            return asyncio.run(self.send_alarm(alarm))

    async def send_message(self, text: str) -> bool:
        """Gửi tin nhắn tùy ý (dùng cho lệnh ngược từ Telegram webhook)."""
        if not self._enabled:
            return False
        return await self._send_message(text)

    def send_message_sync(self, text: str) -> bool:
        """Gửi tin nhắn tùy ý (sync wrapper)."""
        try:
            return asyncio.run(self.send_message(text))
        except RuntimeError:
            asyncio.ensure_future(self.send_message(text))
            return True

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _check_cooldown(self, level: str) -> bool:
        """True nếu đã qua cooldown hoặc không có cooldown."""
        cooldown_s = _COOLDOWN.get(level, 120)
        if cooldown_s == 0:
            return True
        last = self._last_sent.get(level)
        if last is None:
            return True
        elapsed = (datetime.now(_VN_TZ) - last).total_seconds()
        return elapsed >= cooldown_s

    def _format_alarm(self, alarm: dict[str, Any]) -> str:
        """Tạo tin nhắn Telegram từ alarm document."""
        level   = (alarm.get("level") or "warning").lower()
        emoji   = _LEVEL_EMOJI.get(level, "⚠️")
        ts      = alarm.get("created_at", alarm.get("timestamp", ""))
        if hasattr(ts, "isoformat"):
            ts = ts.isoformat()
        # Chỉ lấy phần giờ:phút:giây
        ts_short = str(ts)[11:19] if len(str(ts)) > 18 else str(ts)

        lines = [
            f"{emoji} *ALARM [{level.upper()}]*",
            f"📋 {alarm.get('message', 'Không có mô tả')}",
        ]

        if alarm.get("action"):
            lines.append(f"🔧 Hành động: {alarm['action']}")

        # Neo4j context nếu có
        if alarm.get("tool"):
            lines.append(f"🛠️ Dao: {alarm['tool']}")
        if alarm.get("material"):
            lines.append(f"🧱 Vật liệu: {alarm['material']}")

        # AI analysis nếu có
        if alarm.get("ai_analysis"):
            analysis = str(alarm["ai_analysis"])[:200]
            lines.append(f"🤖 AI: {analysis}")

        lines.append(f"⏰ {ts_short} (VN)")

        if level == "critical":
            lines.append("\n‼️ Máy đã dừng khẩn cấp")

        return "\n".join(lines)

    async def _send_message(self, text: str) -> bool:
        """Gọi Telegram Bot API sendMessage."""
        url = _BASE_URL.format(token=self._token, method="sendMessage")
        payload = {
            "chat_id":    self._chat_id,
            "text":       text,
            "parse_mode": "Markdown",
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(url, json=payload)
                if resp.status_code == 200 and resp.json().get("ok"):
                    return True
                logger.warning(f"Telegram API lỗi: {resp.status_code} — {resp.text[:200]}")
                return False
        except Exception as e:
            logger.error(f"Telegram _send_message lỗi: {e}")
            return False

    @property
    def enabled(self) -> bool:
        return self._enabled


# ── Singleton ─────────────────────────────────────────────────────────────
notifier = TelegramNotifier()

def notify_alarm(
    level: str,
    message: str,
    action: str = "",
    current_A: float | None = None,
) -> bool:
    """Gửi alarm Telegram (sync, an toàn để gọi trong threading.Thread).

    Hàm tiện ích bọc quanh `notifier.send_alarm_sync()` — nhận tham số rời
    (level/message/action/current_A) thay vì phải tự dựng dict alarm, vì
    sync_routes.py gọi hàm này ở nhiều chỗ (estop confirm, provider
    emergency, alarm relay từ Edge).

    Args:
        level: "info" | "warning" | "critical" | "emergency".
        message: Nội dung alarm.
        action: Hành động liên quan (gcode đang chạy, "estop_confirmed", ...).
        current_A: Dòng điện tại thời điểm alarm (nếu có).

    Returns:
        True nếu gửi Telegram thành công.
    """
    alarm = {
        "level": level,
        "message": message,
        "action": action,
        "current_A": current_A,
    }
    return notifier.send_alarm_sync(alarm)
