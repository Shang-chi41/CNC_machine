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
from pymongo import ReturnDocument
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import APIKeyHeader
from pydantic import BaseModel

from cloud_backend.services.mongo_service import doc_to_dict, docs_to_list, get_col
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
_COL_GCODE    = "GCode_Files"
_COL_CMDS     = "Machine_Commands"
_COL_SETTINGS = "HMI_Settings"


def _edge_target(col, edge_id: str, edge_field: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Resolve one logical Edge record in both shared-DB and split-DB deployments.

    When Edge and Cloud point at the same MongoDB, the original ObjectId already
    exists before the HTTP sync call.  Prefer that document to avoid duplicating
    it.  In split deployments, fall back to the stable ``edge_*_id`` field.
    """
    target: dict[str, Any] = {edge_field: edge_id}
    existing = col.find_one(target) if edge_id else None
    if edge_id and existing is None:
        try:
            oid = ObjectId(edge_id)
            existing = col.find_one({"_id": oid})
            if existing is not None:
                target = {"_id": oid}
        except Exception:
            pass
    return target, existing


# ══════════════════════════════════════════════════════════════════════════
#  SENSOR SYNC
# ══════════════════════════════════════════════════════════════════════════

class SensorSyncRequest(BaseModel):
    records: list[dict[str, Any]]


@router.post("/sensors", summary="Edge push batch sensor records")
def sync_sensors(body: SensorSyncRequest, _: str = SyncAuth) -> dict:
    if not body.records:
        return {"status": "ok", "inserted": 0}
    col = get_col(_COL_SENSOR)
    now = _now_str()
    count = 0
    for record in body.records:
        edge_id = str(record.get("edge_sensor_id") or record.get("_id") or "")
        doc = {k: v for k, v in record.items() if k not in ("_id", "synced")}
        doc.update({"edge_sensor_id": edge_id, "synced_at": now})
        if edge_id:
            target, existing = _edge_target(col, edge_id, "edge_sensor_id")
            result = col.update_one(target, {"$set": doc}, upsert=True)
            count += int(existing is None or result.modified_count > 0)
        else:
            col.insert_one(doc)
            count += 1
    return {"status": "ok", "upserted": count}


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

        # Upsert chống duplicate cho cả mô hình DB dùng chung và DB tách riêng.
        if edge_id:
            edge_id = str(edge_id)
            target, existing = _edge_target(col, edge_id, "edge_alarm_id")
            should_notify = existing is None or not bool(existing.get("cloud_notified"))
            doc.update({"edge_alarm_id": edge_id, "cloud_notified": True})
            result = col.update_one(target, {"$set": doc}, upsert=True)
            changed = existing is None or result.modified_count > 0
        else:
            doc["cloud_notified"] = True
            col.insert_one(doc)
            should_notify = True
            changed = True

        count += int(changed)
        # Chỉ gửi một lần cho mỗi alarm, kể cả khi Edge retry HTTP sync.
        level = alarm.get("level", "info").lower()
        if should_notify and level in ("warning", "critical", "emergency"):
            _send_telegram_async(alarm)


    return {"status": "ok", "upserted": count}


# ══════════════════════════════════════════════════════════════════════════
#  SIMULATION SYNC
# ══════════════════════════════════════════════════════════════════════════

class SimSyncRequest(BaseModel):
    records: list[dict[str, Any]]


@router.post("/simulation", summary="Edge push simulation data")
def sync_simulation(body: SimSyncRequest, _: str = SyncAuth) -> dict:
    """Upsert simulation records theo ``edge_simulation_id`` để retry không tạo bản sao."""
    if not body.records:
        return {"status": "ok", "upserted": 0}
    col = get_col(_COL_SIM)
    now = _now_str()
    count = 0
    for record in body.records:
        edge_id = str(record.get("edge_simulation_id") or record.get("_id") or "")
        doc = {k: v for k, v in record.items() if k not in ("_id", "cloud_synced")}
        doc.update({"edge_simulation_id": edge_id, "synced_at": now})
        if edge_id:
            target, existing = _edge_target(col, edge_id, "edge_simulation_id")
            result = col.update_one(target, {"$set": doc}, upsert=True)
            count += int(existing is None or result.modified_count > 0)
        else:
            col.insert_one(doc)
            count += 1
    return {"status": "ok", "upserted": count}


# ══════════════════════════════════════════════════════════════════════════
#  G-CODE SYNC + EDGE FETCH
# ══════════════════════════════════════════════════════════════════════════

class GCodeSyncRequest(BaseModel):
    records: list[dict[str, Any]]


@router.post("/gcodes", summary="Edge upsert G-code lên Cloud")
def sync_gcodes(body: GCodeSyncRequest, _: str = SyncAuth) -> dict:
    """Đồng bộ GCode_Files từ Edge, dedup theo ``edge_gcode_id``."""
    if not body.records:
        return {"status": "ok", "upserted": 0}
    col = get_col(_COL_GCODE)
    now = _now_str()
    count = 0
    for record in body.records:
        edge_id = str(record.get("edge_gcode_id") or record.get("_id") or "")
        doc = {
            k: v for k, v in record.items()
            if k not in ("_id", "cloud_synced", "cloud_synced_at")
        }
        doc.update({"edge_gcode_id": edge_id, "synced_at": now})
        if edge_id:
            target, existing = _edge_target(col, edge_id, "edge_gcode_id")
            result = col.update_one(target, {"$set": doc}, upsert=True)
            count += int(existing is None or result.modified_count > 0)
        else:
            col.insert_one(doc)
            count += 1
    return {"status": "ok", "upserted": count}


@router.get("/gcodes/{gcode_id}", summary="Edge lấy G-code Cloud để thực thi")
def edge_get_gcode(gcode_id: str, _: str = SyncAuth) -> dict:
    try:
        doc = get_col(_COL_GCODE).find_one({"_id": ObjectId(gcode_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")
    return doc_to_dict(doc) or {}


# ══════════════════════════════════════════════════════════════════════════
#  COMMAND POLL + DONE
# ══════════════════════════════════════════════════════════════════════════

@router.get("/commands", summary="Edge poll và claim lệnh pending")
def poll_commands(_: str = SyncAuth) -> list[dict]:
    """Claim tối đa 10 lệnh theo priority, đồng thời phục hồi job bị treo."""
    col = get_col(_COL_CMDS)
    now = datetime.now(_VN_TZ)
    cutoff = (now - timedelta(minutes=5)).isoformat()

    # Edge chết giữa chừng: đưa command processing quá 5 phút về pending.
    col.update_many(
        {
            "status": "processing",
            "action": {"$ne": "run_gcode"},
            "$or": [
                {"processing_started_at": {"$lt": cutoff}},
                {"processing_started_at": {"$exists": False}},
            ],
        },
        {"$set": {"status": "pending", "recovered_at": now.isoformat()}},
    )


    # Không tự retry chương trình cắt sau Edge crash vì có thể gây chạy lặp.
    run_cutoff = (now - timedelta(hours=1)).isoformat()
    col.update_many(
        {
            "status": "processing",
            "action": "run_gcode",
            "processing_started_at": {"$lt": run_cutoff},
        },
        {"$set": {
            "status": "failed",
            "error": "Edge mất kết nối trong khi stream; cần operator kiểm tra máy",
            "executed_at": now.isoformat(),
        }},
    )

    claimed: list[dict] = []
    for _ in range(10):
        doc = col.find_one_and_update(
            {"status": "pending"},
            {"$set": {
                "status": "processing",
                "fetched_at": now.isoformat(),
                "processing_started_at": now.isoformat(),
            }},
            sort=[("priority", 1), ("created_at", 1)],
            return_document=ReturnDocument.AFTER,
        )
        if not doc:
            break
        if doc.get("action") == "run_gcode":
            gcode_id = str((doc.get("params") or {}).get("gcode_id", ""))
            if gcode_id:
                try:
                    get_col(_COL_GCODE).update_one(
                        {"_id": ObjectId(gcode_id)},
                        {"$set": {
                            "status": "executing",
                            "started_at": now.isoformat(),
                            "execution_command_id": str(doc.get("_id", "")),
                        }},
                    )
                except Exception:
                    pass
        claimed.append(doc)
    return docs_to_list(claimed)


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
        oid = ObjectId(command_id)
        cmd_doc = col.find_one({"_id": oid})
        if not cmd_doc:
            raise HTTPException(status_code=404, detail="Không tìm thấy command")
        col.update_one(
            {"_id": oid},
            {"$set": {
                "status": "done" if body.success else "failed",
                "result": body.result,
                "error": body.error,
                "executed_at": _now_str(),
            }},
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="command_id không hợp lệ")

    # Kết thúc run_gcode thì đồng bộ luôn vòng đời GCode_Files trên Cloud.
    if cmd_doc.get("action") == "run_gcode":
        gcode_id = str((cmd_doc.get("params") or {}).get("gcode_id", ""))
        if gcode_id:
            try:
                get_col(_COL_GCODE).update_one(
                    {"_id": ObjectId(gcode_id)},
                    {"$set": {
                        "status": "executed" if body.success else "failed",
                        "completed_at": _now_str(),
                        "execution_error": body.error,
                    }},
                )
            except Exception:
                pass

    if body.success and cmd_doc.get("action") == "estop":
        threading.Thread(
            target=lambda: notify_alarm(
                level="emergency",
                message="Máy đã dừng khẩn cấp thành công",
                action="estop_confirmed",
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
                message = "AI provider rơi xuống emergency tier (rule-based)",
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