"""
cloud_backend/routes/sync_routes.py  [v2 — tích hợp Telegram notification]

Thay thế sync_routes.py cũ — thêm:
  - Sau khi nhận alarm từ Edge → gửi Telegram tự động
  - CRITICAL: gửi ngay
  - WARNING:  gửi sau khi lưu MongoDB
"""

from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import APIKeyHeader
from pydantic import BaseModel

from cloud_backend.services.mongo_service import docs_to_list, get_col
from cloud_backend.services.notification_service import notifier
from cloud_backend.services.notification_service import notify_alarm

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))

_SYNC_KEY_ENV    = "SYNC_API_KEY"
_SYNC_KEY_HEADER = APIKeyHeader(name="X-Sync-Key", auto_error=False)
_DEFAULT_KEY     = "cnc_edge_sync_key_change_in_production"


def _verify_sync_key(key: str | None = Depends(_SYNC_KEY_HEADER)) -> str:
    expected = os.getenv(_SYNC_KEY_ENV, _DEFAULT_KEY)
    if not key or key != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Sync-Key không hợp lệ",
        )
    return key


SyncAuth = Depends(_verify_sync_key)


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


_COL_SENSOR   = "Sensor_Data"
_COL_ALARMS   = "Alarms"
_COL_SIM      = "Simulation_Data"
_COL_CMDS     = "Machine_Commands"
_COL_SETTINGS = "HMI_Settings"


# ══════════════════════════════════════════════════════════════════════════
#  SENSOR SYNC
# ══════════════════════════════════════════════════════════════════════════

class SensorSyncRequest(BaseModel):
    records: list[dict[str, Any]]


@router.post("/sensors", summary="Edge push batch sensor records")
def sync_sensors(body: SensorSyncRequest, _: str = SyncAuth) -> dict:
    if not body.records:
        return {"status": "ok", "inserted": 0}
    now  = _now_str()
    docs = [{**r, "synced_at": now} for r in body.records]
    get_col(_COL_SENSOR).insert_many(docs, ordered=False)
    return {"status": "ok", "inserted": len(docs)}


# ══════════════════════════════════════════════════════════════════════════
#  ALARM SYNC — với Telegram notification
# ══════════════════════════════════════════════════════════════════════════

class AlarmSyncRequest(BaseModel):
    alarms: list[dict[str, Any]]


def _send_telegram_async(alarm: dict) -> None:
    """Gửi Telegram trong thread riêng để không block sync response."""
    def _send():
        level   = alarm.get("level", "info").lower()
        message = alarm.get("message", "")
        action  = alarm.get("action", "")

        # Trích thông tin từ message nếu có
        current_A: float | None = None
        if "A" in message:
            import re
            m = re.search(r"(\d+\.?\d*)\s*A", message)
            if m:
                try:
                    current_A = float(m.group(1))
                except ValueError:
                    pass

        notify_alarm(
            level     = level,
            message   = message,
            action    = action,
            current_A = current_A,
        )

    threading.Thread(target=_send, daemon=True).start()


@router.post("/alarms", summary="Edge push alarms + gửi Telegram")
def sync_alarms(body: AlarmSyncRequest, _: str = SyncAuth) -> dict:
    """Edge đẩy alarms lên Cloud.

    Sau khi lưu vào MongoDB:
    - CRITICAL / EMERGENCY → gửi Telegram ngay (async thread)
    - WARNING              → gửi Telegram ngay (async thread)
    - INFO                 → chỉ lưu MongoDB, không gửi Telegram
    """
    if not body.alarms:
        return {"status": "ok", "upserted": 0}

    col   = get_col(_COL_ALARMS)
    count = 0
    now   = _now_str()

    for alarm in body.alarms:
        edge_id = alarm.get("edge_alarm_id") or alarm.get("_id")
        doc     = {k: v for k, v in alarm.items() if k not in ("_id",)}
        doc["synced_at"] = now

        # Lưu vào MongoDB (upsert để tránh duplicate khi Edge retry)
        if edge_id:
            result = col.update_one(
                {"edge_alarm_id": str(edge_id)},
                {"$setOnInsert": doc},
                upsert=True,
            )
            inserted = result.upserted_id is not None
        else:
            col.insert_one(doc)
            inserted = True

        if inserted:
            count += 1
            # Gửi Telegram cho WARNING trở lên
            level = alarm.get("level", "info").lower()
            if level in ("warning", "critical", "emergency"):
                _send_telegram_async(alarm)

    # Gửi Telegram cho alarm warning trở lên (async fire-and-forget)
    import asyncio
    for alarm in body.alarms:
        level = (alarm.get("level") or "info").lower()
        if level in ("warning", "critical", "emergency"):
            try:
                asyncio.ensure_future(notifier.send_alarm(alarm))
            except RuntimeError:
                notifier.send_alarm_sync(alarm)

    return {"status": "ok", "upserted": count}


# ══════════════════════════════════════════════════════════════════════════
#  SIMULATION SYNC
# ══════════════════════════════════════════════════════════════════════════

class SimSyncRequest(BaseModel):
    records: list[dict[str, Any]]


@router.post("/simulation", summary="Edge push simulation data")
def sync_simulation(body: SimSyncRequest, _: str = SyncAuth) -> dict:
    if not body.records:
        return {"status": "ok", "inserted": 0}
    now  = _now_str()
    docs = [{**r, "synced_at": now} for r in body.records]
    get_col(_COL_SIM).insert_many(docs, ordered=False)
    return {"status": "ok", "inserted": len(docs)}


# ══════════════════════════════════════════════════════════════════════════
#  COMMAND POLL + DONE
# ══════════════════════════════════════════════════════════════════════════

@router.get("/commands", summary="Edge poll lệnh điều khiển pending")
def poll_commands(_: str = SyncAuth) -> list[dict]:
    col  = get_col(_COL_CMDS)
    docs = list(
        col.find({"status": "pending"})
           .sort([("priority", 1), ("created_at", 1)])
           .limit(10)
    )
    if not docs:
        return []
    ids = [d["_id"] for d in docs]
    col.update_many(
        {"_id": {"$in": ids}},
        {"$set": {"status": "processing", "fetched_at": _now_str()}},
    )
    return docs_to_list(docs)


class CommandResultRequest(BaseModel):
    success: bool
    result:  str = ""
    error:   str = ""


@router.post("/commands/{command_id}/done", summary="Edge báo lệnh đã thực thi")
def command_done(
    command_id: str,
    body: CommandResultRequest,
    _: str = SyncAuth,
) -> dict:
    col = get_col(_COL_CMDS)
    try:
        result = col.update_one(
            {"_id": ObjectId(command_id)},
            {"$set": {
                "status":      "done" if body.success else "failed",
                "result":      body.result,
                "error":       body.error,
                "executed_at": _now_str(),
            }},
        )
    except Exception:
        raise HTTPException(status_code=400, detail="command_id không hợp lệ")

    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy command")

    # Nếu estop thành công → thông báo Telegram
    if body.success:
        cmd_doc = col.find_one({"_id": ObjectId(command_id)})
        if cmd_doc and cmd_doc.get("action") == "estop":
            threading.Thread(
                target=lambda: notify_alarm(
                    level   = "emergency",
                    message = "Máy đã dừng khẩn cấp thành công",
                    action  = "estop_confirmed",
                ),
                daemon=True,
            ).start()

    return {"status": "ok", "command_id": command_id}


# ══════════════════════════════════════════════════════════════════════════
#  STREAM PROGRESS SYNC (Edge → Cloud)
# ══════════════════════════════════════════════════════════════════════════

class StreamProgressRequest(BaseModel):
    command_id:    str           # Machine_Commands._id
    current_line:  int
    total_lines:   int
    current_gcode: str   = ""
    pct:           float = 0.0


@router.post("/stream_progress", summary="Edge push tiến trình stream G-code")
def sync_stream_progress(body: StreamProgressRequest, _: str = SyncAuth) -> dict:
    """Edge gọi endpoint này mỗi khi gửi xong 1 dòng G-code.

    HMI poll GET /api/control/stream_progress để đọc giá trị này.
    """
    col = get_col(_COL_CMDS)
    try:
        result = col.update_one(
            {"_id": ObjectId(body.command_id)},
            {"$set": {
                "progress": {
                    "current_line":  body.current_line,
                    "total_lines":   body.total_lines,
                    "current_gcode": body.current_gcode,
                    "pct":           body.pct,
                    "updated_at":    _now_str(),
                }
            }},
        )
    except Exception:
        raise HTTPException(status_code=400, detail="command_id không hợp lệ")

    return {"ok": result.modified_count > 0}


# ══════════════════════════════════════════════════════════════════════════
#  PROVIDER STATUS UPDATE
# ══════════════════════════════════════════════════════════════════════════

class ProviderStatusRequest(BaseModel):
    tier:         str
    provider:     str
    switch_count: int = 0
    last_switch:  str = ""


@router.post("/provider/status", summary="Edge update trạng thái AI provider")
def update_provider_status(body: ProviderStatusRequest, _: str = SyncAuth) -> dict:
    col = get_col(_COL_SETTINGS)
    col.update_one(
        {"_id": "provider_status"},
        {"$set": {
            "tier":         body.tier,
            "provider":     body.provider,
            "switch_count": body.switch_count,
            "last_switch":  body.last_switch,
            "updated_at":   _now_str(),
        }},
        upsert=True,
    )

    # Gửi Telegram nếu rơi xuống emergency tier
    if body.tier == "emergency":
        threading.Thread(
            target=lambda: notify_alarm(
                level   = "warning",
                message = f"AI provider rơi xuống emergency tier (rule-based)",
                action  = f"Đang dùng: {body.provider}",
            ),
            daemon=True,
        ).start()

    # Kiểm tra switch request pending
    switch_req = col.find_one({"_id": "provider_switch_request", "applied": False})
    if switch_req:
        col.update_one(
            {"_id": "provider_switch_request"},
            {"$set": {"applied": True, "applied_at": _now_str()}},
        )
        return {
            "status":           "ok",
            "switch_requested": True,
            "switch_to":        switch_req.get("provider"),
        }

    return {"status": "ok", "switch_requested": False}