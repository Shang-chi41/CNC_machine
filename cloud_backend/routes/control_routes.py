"""
cloud_backend/routes/control_routes.py
Điều khiển máy CNC từ HMI: status, dừng khẩn cấp, jog, gửi G-code.

Lưu ý kiến trúc quan trọng (log.md):
  Cloud Backend KHÔNG kết nối trực tiếp FluidNC.
  Tất cả lệnh điều khiển được ghi vào MongoDB collection "Machine_Commands",
  Edge Backend poll collection này và thực thi qua telnet_client → FluidNC.

  HMI → POST /api/control/* → MongoDB (Machine_Commands)
        ↓
  Edge Backend poll → FluidNC (telnet) → thực thi

Endpoints:
    GET  /api/control/status          → trạng thái máy mới nhất
    POST /api/control/estop           → dừng khẩn cấp (ưu tiên cao nhất)
    POST /api/control/stop            → feed hold
    POST /api/control/resume          → tiếp tục sau hold
    POST /api/control/home            → về home
    POST /api/control/unlock          → unlock sau alarm ($X)
    POST /api/control/jog             → jog một trục
    POST /api/control/gcode           → gửi 1 dòng G-code
    POST /api/control/run/{gcode_id}  → chạy G-code đã confirmed
    GET  /api/control/commands        → lịch sử lệnh (debug)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from cloud_backend.middleware.auth import CurrentUser, OperatorUser
from cloud_backend.services.mongo_service import doc_to_dict, docs_to_list, get_col

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))

_COL_CMDS   = "Machine_Commands"    # Edge poll từ đây
_COL_SENSOR = "Sensor_Data"
_COL_GCODE  = "GCode_Files"
_COL_ALARMS = "Alarms"


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


def _push_command(
    action:    str,
    params:    dict,
    username:  str,
    priority:  int = 5,           # 1=khẩn cấp cao nhất, 10=thấp nhất
) -> str:
    """Ghi lệnh vào Machine_Commands để Edge poll và thực thi.

    Returns:
        command_id (str) để HMI theo dõi trạng thái.
    """
    now = _now_str()
    doc = {
        "action":     action,
        "params":     params,
        "priority":   priority,
        "status":     "pending",    # Edge sẽ update: processing → done | failed
        "created_by": username,
        "created_at": now,
        "executed_at": None,
        "result":     None,
    }
    result = get_col(_COL_CMDS).insert_one(doc)
    return str(result.inserted_id)


def _latest_sensor() -> dict:
    """Lấy sensor document mới nhất."""
    col = get_col(_COL_SENSOR)
    doc = col.find_one(sort=[("mqtt_timestamp", -1)])
    if not doc:
        doc = col.find_one(sort=[("timestamp", -1)])
    return doc_to_dict(doc) or {} if doc else {}


# ══════════════════════════════════════════════════════════════════════════
#  STATUS
# ══════════════════════════════════════════════════════════════════════════

@router.get("/status", summary="Trạng thái máy CNC mới nhất")
def machine_status(user: CurrentUser) -> dict:
    """Trạng thái tổng hợp từ sensor data mới nhất.

    HMI Dashboard + Control page dùng endpoint này.
    """
    sensor = _latest_sensor()
    if not sensor:
        return {"online": False, "status": "no_data"}

    axes    = sensor.get("axes", {})
    current = sensor.get("current", {})
    spindle = sensor.get("spindle", {})

    def pos(ax: str) -> float:
        return axes.get(ax, {}).get("position", 0.0) if axes else sensor.get(f"vi_tri_{ax}", 0.0)

    # Kiểm tra độ tuổi dữ liệu
    ts_raw = sensor.get("timestamp", sensor.get("mqtt_timestamp"))
    age_s  = None
    if ts_raw:
        try:
            ts    = datetime.fromisoformat(str(ts_raw))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=_VN_TZ)
            age_s = (datetime.now(_VN_TZ) - ts).total_seconds()
        except Exception:
            pass

    online = age_s is not None and age_s < 10

    return {
        "online":    online,
        "age_s":     round(age_s, 1) if age_s is not None else None,
        "status":    sensor.get("status", "unknown"),
        "position":  {"x": pos("x"), "y": pos("y"), "z": pos("z")},
        "current_A": current.get("rms", sensor.get("load", 0.0)),
        "spindle_rpm": spindle.get("speed", 0.0),
        "timestamp": sensor.get("timestamp", ""),
    }


# ══════════════════════════════════════════════════════════════════════════
#  E-STOP (ưu tiên cao nhất — priority=1)
# ══════════════════════════════════════════════════════════════════════════

@router.post("/estop", summary="DỪNG KHẨN CẤP")
def emergency_stop(user: OperatorUser) -> dict:
    """Dừng khẩn cấp: Feed Hold (!) rồi Ctrl+X (soft reset).

    Ghi lệnh estop vào MongoDB với priority=1.
    Edge Backend poll và thực thi ngay lập tức qua telnet → FluidNC.

    Đồng thời lưu alarm CRITICAL vào MongoDB.
    """
    # Lưu alarm
    get_col(_COL_ALARMS).insert_one({
        "level":      "critical",
        "message":    f"DỪNG KHẨN CẤP bởi {user['username']}",
        "action":     "estop",
        "resolved":   False,
        "source":     "hmi_manual",
        "created_at": _now_str(),
    })

    cmd_id = _push_command(
        action   = "estop",
        params   = {},
        username = user["username"],
        priority = 1,
    )
    return {
        "status":     "ok",
        "command_id": cmd_id,
        "message":    "🚨 Lệnh dừng khẩn cấp đã được gửi",
    }


# ══════════════════════════════════════════════════════════════════════════
#  FEED HOLD / RESUME
# ══════════════════════════════════════════════════════════════════════════

@router.post("/stop", summary="Dừng tạm (Feed Hold)")
def feed_hold(user: OperatorUser) -> dict:
    """Gửi Feed Hold (!) — máy dừng mềm, có thể resume."""
    cmd_id = _push_command("stop", {}, user["username"], priority=2)
    return {"status": "ok", "command_id": cmd_id, "message": "🛑 Feed Hold đã được gửi"}


@router.post("/resume", summary="Tiếp tục sau Feed Hold")
def resume(user: OperatorUser) -> dict:
    """Gửi lệnh tiếp tục (~) sau khi Feed Hold."""
    cmd_id = _push_command("resume", {}, user["username"], priority=2)
    return {"status": "ok", "command_id": cmd_id, "message": "▶️ Resume đã được gửi"}


# ══════════════════════════════════════════════════════════════════════════
#  HOME
# ══════════════════════════════════════════════════════════════════════════

@router.post("/home", summary="Về home ($H)")
def home(user: OperatorUser) -> dict:
    """Gửi lệnh homing về gốc tọa độ."""
    cmd_id = _push_command("home", {}, user["username"], priority=3)
    return {"status": "ok", "command_id": cmd_id, "message": "🏠 Lệnh Home đã được gửi"}


@router.post("/unlock", summary="Unlock sau alarm ($X)")
def unlock(user: OperatorUser) -> dict:
    """Gửi lệnh unlock ($X) để thoát khỏi trạng thái alarm của FluidNC.

    Dùng khi máy bị kẹt ở trạng thái ALARM sau sự cố.
    Edge Backend nhận lệnh từ Machine_Commands và gửi ``$X`` qua telnet.

    .. warning::
        Chỉ dùng sau khi đã kiểm tra và xử lý nguyên nhân alarm.
        Không dùng thay thế cho ESTOP.
    """
    cmd_id = _push_command("unlock", {}, user["username"], priority=2)
    return {"status": "ok", "command_id": cmd_id, "message": "🔓 Unlock đã được gửi"}


# ══════════════════════════════════════════════════════════════════════════
#  JOG
# ══════════════════════════════════════════════════════════════════════════

class JogRequest(BaseModel):
    axis:     Literal["X", "Y", "Z"]
    distance: float = Field(..., ge=-500, le=500, description="mm, âm = chiều ngược")
    feed:     float = Field(500, ge=1, le=5000, description="mm/min")


@router.post("/jog", summary="Jog một trục")
def jog(body: JogRequest, user: OperatorUser) -> dict:
    """Jog tương đối một trục X/Y/Z."""
    cmd_id = _push_command(
        action   = "jog",
        params   = {"axis": body.axis, "distance": body.distance, "feed": body.feed},
        username = user["username"],
        priority = 3,
    )
    return {
        "status":     "ok",
        "command_id": cmd_id,
        "message":    f"🎮 Jog {body.axis}{body.distance:+g}mm F{body.feed}",
    }


# ══════════════════════════════════════════════════════════════════════════
#  GCODE ĐƠN (1 dòng)
# ══════════════════════════════════════════════════════════════════════════

class GcodeLineRequest(BaseModel):
    cmd: str = Field(..., description="Lệnh G-code, ví dụ: G0 X50 Y30")


@router.post("/gcode", summary="Gửi 1 dòng G-code")
def send_gcode_line(body: GcodeLineRequest, user: OperatorUser) -> dict:
    """Gửi một lệnh G-code đơn xuống FluidNC qua Edge."""
    cmd = body.cmd.strip()
    if not cmd:
        raise HTTPException(status_code=400, detail="Lệnh G-code không được trống")

    # Chặn M112 trực tiếp — dùng /estop thay thế
    if "M112" in cmd.upper():
        raise HTTPException(
            status_code=400,
            detail="Dùng POST /api/control/estop cho lệnh dừng khẩn cấp",
        )

    cmd_id = _push_command(
        action   = "gcode",
        params   = {"cmd": cmd},
        username = user["username"],
        priority = 4,
    )
    return {"status": "ok", "command_id": cmd_id, "message": f"📤 G-code: {cmd}"}


# ══════════════════════════════════════════════════════════════════════════
#  RUN G-CODE ĐÃ CONFIRMED
# ══════════════════════════════════════════════════════════════════════════

@router.post("/run/{gcode_id}", summary="Chạy G-code đã xác nhận")
def run_gcode(gcode_id: str, user: OperatorUser) -> dict:
    """Gửi lệnh chạy toàn bộ G-code đã confirmed xuống FluidNC.

    Chỉ cho phép G-code có status=confirmed.
    Edge sẽ lấy nội dung từ MongoDB và gửi từng dòng xuống FluidNC.
    """
    col = get_col(_COL_GCODE)
    try:
        doc = col.find_one({"_id": ObjectId(gcode_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")

    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")

    if doc.get("status") != "confirmed":
        raise HTTPException(
            status_code=409,
            detail=(
                f"G-code chưa được xác nhận (status='{doc.get('status')}'). "
                "Cần POST /api/gcode/{id}/confirm trước."
            ),
        )

    cmd_id = _push_command(
        action   = "run_gcode",
        params   = {"gcode_id": gcode_id},
        username = user["username"],
        priority = 4,
    )

    # Chỉ đánh dấu queued tại Cloud. Trạng thái executing được đặt khi Edge
    # thực sự claim command, tránh báo đang chạy khi Edge đang offline.
    col.update_one(
        {"_id": ObjectId(gcode_id)},
        {"$set": {
            "status": "queued",
            "queued_at": _now_str(),
            "execution_command_id": cmd_id,
        }},
    )

    return {
        "status":     "ok",
        "command_id": cmd_id,
        "gcode_id":   gcode_id,
        "message":    f"▶️ Bắt đầu chạy G-code '{doc.get('filename', gcode_id)}'",
    }


# ══════════════════════════════════════════════════════════════════════════
#  STREAM PROGRESS (HMI poll khi đang chạy G-code)
# ══════════════════════════════════════════════════════════════════════════

@router.get("/stream_progress", summary="Tiến trình stream G-code hiện tại")
def stream_progress(user: CurrentUser) -> dict:
    """Trả về tiến trình STREAM mode hiện tại.

    Edge push qua POST /api/sync/stream_progress → lưu vào Machine_Commands.
    HMI poll endpoint này mỗi 1 giây khi đang chạy G-code.
    """
    col = get_col(_COL_CMDS)
    cmd = col.find_one(
        {"action": "run_gcode", "status": {"$in": ["processing", "executing"]}},
        sort=[("created_at", -1)],
    )
    if not cmd:
        return {"is_streaming": False}

    progress = cmd.get("progress", {})
    return {
        "is_streaming":  True,
        "current_line":  progress.get("current_line", 0),
        "total_lines":   progress.get("total_lines", 0),
        "current_gcode": progress.get("current_gcode", ""),
        "pct":           progress.get("pct", 0.0),
        "gcode_id":      str(cmd["params"].get("gcode_id", "")),
        "started_at":    str(cmd.get("created_at", "")),
    }


# ══════════════════════════════════════════════════════════════════════════
#  COMMAND HISTORY (debug / audit)
# ══════════════════════════════════════════════════════════════════════════

@router.get("/commands", summary="Lịch sử lệnh điều khiển")
def command_history(
    user:  CurrentUser,
    limit: int = Query(50, ge=1, le=500),
) -> list[dict]:
    """Lịch sử lệnh đã gửi — dùng để debug và audit."""
    col  = get_col(_COL_CMDS)
    docs = list(col.find({}).sort("created_at", -1).limit(limit))
    return docs_to_list(docs)