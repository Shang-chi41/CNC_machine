"""
cloud_backend/routes/settings_routes.py
Cấu hình hệ thống: machine, AI provider, theme, export YAML.

Endpoints:
    GET  /api/settings/machine          → lấy machine config
    POST /api/settings/machine          → lưu machine config
    GET  /api/settings/machine/export   → export YAML
    GET  /api/settings/theme            → lấy theme ISA-101
    POST /api/settings/theme            → lưu theme
    GET  /api/settings/ai               → lấy AI provider config
    POST /api/settings/ai               → lưu AI provider config
    GET  /api/settings/network          → trạng thái mạng + sync
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from cloud_backend.middleware.auth import CurrentUser, OperatorUser
from cloud_backend.services.mongo_service import doc_to_dict, get_col

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))

_COL_MACHINE  = "Machine_Config"
_COL_THEME    = "Theme_Config"
_COL_SETTINGS = "HMI_Settings"
_COL_SENSOR   = "Sensor_Data"

_DOC_ID = "current"


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


# ── Default configs ───────────────────────────────────────────────────────

_DEFAULT_MACHINE = {
    "machine_id":    "CNC-001",
    "name":          "Desktop CNC 3-Axis",
    "steps_x": 80.0, "steps_y": 80.0, "steps_z": 80.0,
    "max_speed_x": 250.0, "max_speed_y": 250.0, "max_speed_z": 150.0,
    "acc_x": 1000.0, "acc_y": 1000.0, "acc_z": 800.0,
    "max_travel_x": 300.0, "max_travel_y": 200.0, "max_travel_z": 100.0,
    "enable_homing": True, "homing_speed": 50.0, "homing_pulloff": 5.0,
    "spindle_max_rpm": 12000,
    "normal_current_min_A": 2.0, "normal_current_max_A": 2.5,
}

_DEFAULT_THEME = {
    "primary":       "#1E5FA8",
    "secondary":     "#00c9d4",
    "bg_main":       "#C8CACF",
    "bg_panel":      "#D0D2D6",
    "bg_sidebar":    "#BABCBF",
    "bg_hover":      "#B0B2B6",
    "text_primary":  "#1A1A1A",
    "text_secondary":"#3A3A3A",
    "text_muted":    "#5A5A5A",
    "border":        "#9A9C9F",
    "success":       "#00AA00",
    "warning":       "#FFCC00",
    "alarm":         "#CC0000",
}

_DEFAULT_AI = {
    "primary_provider":  "gemini",
    "fallback_provider": "ollama",
    "local_ai_enabled":  True,
    "ollama_url":        "http://localhost:11434",
    "ollama_model":      "qwen:7b",
    "cloud_providers":   ["gemini", "claude", "openrouter"],
}


# ══════════════════════════════════════════════════════════════════════════
#  MACHINE CONFIG
# ══════════════════════════════════════════════════════════════════════════

@router.get("/machine", summary="Lấy cấu hình máy")
def get_machine_config(user: CurrentUser) -> dict:
    col = get_col(_COL_MACHINE)
    doc = col.find_one({"_id": _DOC_ID})
    if doc:
        del doc["_id"]
        return doc
    return _DEFAULT_MACHINE


@router.post("/machine", summary="Lưu cấu hình máy")
def save_machine_config(data: dict, user: OperatorUser) -> dict:
    """Lưu machine config vào MongoDB.

    HMI Settings → Machine Tuning group dùng endpoint này.
    """
    col = get_col(_COL_MACHINE)
    data["updated_by"] = user["username"]
    data["updated_at"] = _now_str()
    col.update_one({"_id": _DOC_ID}, {"$set": data}, upsert=True)
    return {"status": "ok", "message": "Đã lưu cấu hình máy"}


@router.get("/machine/export", response_class=PlainTextResponse, summary="Export YAML")
def export_machine_yaml(user: CurrentUser) -> str:
    """Export cấu hình máy thành YAML cho FluidNC / backup."""
    col = get_col(_COL_MACHINE)
    doc = col.find_one({"_id": _DOC_ID}) or _DEFAULT_MACHINE

    yaml = f"""# CNC Machine Configuration
# Generated: {_now_str()}
# Machine: {doc.get('name', 'CNC')}

machine_tuning:
  steps_per_mm:
    x: {doc.get('steps_x', 80.0)}
    y: {doc.get('steps_y', 80.0)}
    z: {doc.get('steps_z', 80.0)}

motion:
  max_speed_mm_min:
    x: {doc.get('max_speed_x', 250.0)}
    y: {doc.get('max_speed_y', 250.0)}
    z: {doc.get('max_speed_z', 150.0)}
  acceleration_mm_s2:
    x: {doc.get('acc_x', 1000.0)}
    y: {doc.get('acc_y', 1000.0)}
    z: {doc.get('acc_z', 800.0)}

travel_limits:
  max_travel_mm:
    x: {doc.get('max_travel_x', 300.0)}
    y: {doc.get('max_travel_y', 200.0)}
    z: {doc.get('max_travel_z', 100.0)}

homing:
  enabled: {str(doc.get('enable_homing', True)).lower()}
  speed_mm_min: {doc.get('homing_speed', 50.0)}
  pull_off_mm:  {doc.get('homing_pulloff', 5.0)}

spindle:
  max_rpm: {doc.get('spindle_max_rpm', 12000)}

safety:
  normal_current_A:
    min: {doc.get('normal_current_min_A', 2.0)}
    max: {doc.get('normal_current_max_A', 2.5)}
"""
    return yaml


# ══════════════════════════════════════════════════════════════════════════
#  THEME
# ══════════════════════════════════════════════════════════════════════════

@router.get("/theme", summary="Lấy theme ISA-101")
def get_theme(user: CurrentUser) -> dict:
    col = get_col(_COL_THEME)
    doc = col.find_one({"_id": _DOC_ID})
    if doc:
        del doc["_id"]
        return doc
    return _DEFAULT_THEME


@router.post("/theme", summary="Lưu theme")
def save_theme(data: dict, user: CurrentUser) -> dict:
    """Lưu theme vào MongoDB — đồng bộ qua mọi tab HMI."""
    col = get_col(_COL_THEME)
    data["updated_by"] = user["username"]
    data["updated_at"] = _now_str()
    col.update_one({"_id": _DOC_ID}, {"$set": data}, upsert=True)
    return {"status": "ok", "message": "Đã lưu theme"}


# ══════════════════════════════════════════════════════════════════════════
#  AI PROVIDER SETTINGS
# ══════════════════════════════════════════════════════════════════════════

@router.get("/ai", summary="Lấy cấu hình AI provider")
def get_ai_settings(user: CurrentUser) -> dict:
    """Trả về cấu hình AI provider hiện tại.

    HMI Settings → AI Provider group dùng endpoint này để hiển thị
    provider đang dùng và trạng thái fallback.
    """
    col = get_col(_COL_SETTINGS)
    doc = col.find_one({"_id": "ai_provider"})
    if doc:
        del doc["_id"]
        return doc
    return _DEFAULT_AI


@router.post("/ai", summary="Lưu cấu hình AI provider")
def save_ai_settings(data: dict, user: OperatorUser) -> dict:
    """Lưu cấu hình AI provider.

    Edge Backend sẽ poll endpoint này khi cần đồng bộ cấu hình provider
    (hoặc operator thay đổi thủ công từ HMI).
    """
    col = get_col(_COL_SETTINGS)
    data["updated_by"] = user["username"]
    data["updated_at"] = _now_str()
    col.update_one({"_id": "ai_provider"}, {"$set": data}, upsert=True)
    return {"status": "ok", "message": "Đã lưu cấu hình AI provider"}


# ══════════════════════════════════════════════════════════════════════════
#  NETWORK STATUS
# ══════════════════════════════════════════════════════════════════════════

@router.get("/network", summary="Trạng thái mạng và đồng bộ")
def get_network_status(user: CurrentUser) -> dict:
    """Thông tin kết nối Cloud + thống kê sync.

    HMI Settings → Network group + Data Backup group.
    """
    # Kiểm tra xem Edge có đang đẩy data không (sensor mới nhất < 30s)
    s_col  = get_col(_COL_SENSOR)
    s_doc  = s_col.find_one(sort=[("mqtt_timestamp", -1)])
    if not s_doc:
        s_doc = s_col.find_one(sort=[("timestamp", -1)])

    edge_online   = False
    last_sync_str = None

    if s_doc:
        ts_raw = s_doc.get("mqtt_timestamp") or s_doc.get("timestamp")
        if ts_raw:
            try:
                ts = datetime.fromisoformat(str(ts_raw))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=_VN_TZ)
                age_s = (datetime.now(_VN_TZ) - ts).total_seconds()
                edge_online   = age_s < 30
                last_sync_str = ts.isoformat()
            except Exception:
                pass





    sensor_total = s_col.count_documents({})

    return {
        "cloud_connected":  True,         # Nếu endpoint này trả về được là cloud OK
        "edge_online":      edge_online,
        "last_data_sync":   last_sync_str,
        "sensor_records_total": sensor_total,
        "timestamp":        _now_str(),
    }