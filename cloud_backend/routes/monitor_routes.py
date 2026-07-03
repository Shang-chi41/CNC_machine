"""
cloud_backend/routes/monitor_routes.py
Dữ liệu realtime và lịch sử cho HMI Monitor page.

Endpoints:
    GET  /api/monitor/sensor/latest        → actual sensor mới nhất (từ ESP32)
    GET  /api/monitor/sensor/history       → actual sensor N phút gần đây
    GET  /api/monitor/simulation/latest    → MATLAB simulation mới nhất
    GET  /api/monitor/simulation/history   → MATLAB simulation N phút gần đây
    GET  /api/monitor/alarms               → danh sách alarm (có filter)
    POST /api/monitor/alarms/{id}/resolve  → đánh dấu alarm đã xử lý
    GET  /api/monitor/status               → tổng trạng thái hệ thống
    GET  /api/monitor/alarm/active         → alarm đang active (badge navbar)
    GET  /api/monitor/connection           → trạng thái kết nối các nguồn dữ liệu
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, status

from cloud_backend.middleware.auth import CurrentUser, OperatorUser
from cloud_backend.services.mongo_service import doc_to_dict, docs_to_list, get_col, ping as mongo_ping

router  = APIRouter()
_VN_TZ  = timezone(timedelta(hours=7))

# ── Collection names ───────────────────────────────────────────────────────
_COL_SENSOR  = "Sensor_Data"
_COL_SIM     = "Simulation_Data"
_COL_ALARMS  = "Alarms"

# ── Sensor field normalizer: hỗ trợ cả format mới (axes) và cũ (vi_tri_x) ─
def _normalize_sensor(doc: dict) -> dict:
    if doc is None:
        return {}
    d = doc_to_dict(doc) or {}

    # Format mới: axes.x.position / current.rms / spindle.speed
    axes    = d.get("axes", {})
    current = d.get("current", {})
    spindle = d.get("spindle", {})

    def _axis(name: str) -> dict:
        a = axes.get(name, {})
        return {
            "position": a.get("position", 0.0),
            "velocity": a.get("velocity", 0.0),
            "torque":   a.get("torque",   0.0),
        }

    # Compat với format cũ (app.py Flask)
    return {
        "timestamp":   d.get("timestamp", d.get("mqtt_timestamp", "")),
        "machine_id":  d.get("machine_id", "CNC-001"),
        "axes": {
            "x": _axis("x") if axes else {
                "position": d.get("vi_tri_x", d.get("position_x", 0.0)),
                "velocity": d.get("van_toc_x", d.get("velocity",  0.0)),
                "torque":   d.get("moment_x",  d.get("moment",    0.0)),
            },
            "y": _axis("y") if axes else {
                "position": d.get("vi_tri_y", d.get("position_y", 0.0)),
                "velocity": d.get("van_toc_y", 0.0),
                "torque":   d.get("moment_y",  0.0),
            },
            "z": _axis("z") if axes else {
                "position": d.get("vi_tri_z", d.get("position_z", 0.0)),
                "velocity": d.get("van_toc_z", 0.0),
                "torque":   d.get("moment_z",  0.0),
            },
        },
        "current": {
            "rms":  current.get("rms",  d.get("load", 0.0)),
            "peak": current.get("peak", 0.0),
        },
        "spindle": {
            "speed": spindle.get("speed", 0.0),
            "load":  spindle.get("load",  d.get("load", 0.0)),
        },
        "temp":   d.get("temp", 0.0),
        "status": d.get("status", "unknown"),
    }


def _normalize_simulation(doc: dict) -> dict:
    if doc is None:
        return {}
    d  = doc_to_dict(doc) or {}
    mr = d.get("matlab_results", {})

    pos = mr.get("position", d.get("position", {}))
    vel = mr.get("velocity", d.get("velocity", {}))
    tor = mr.get("torque",   d.get("torque",   {}))
    ts  = d.get("timestamp", d.get("created_at", ""))

    health = d.get("system_health", d.get("edge_computing", {}).get("system_health", {}))

    return {
        "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
        "machine_id": d.get("machine_id", "CNC-001"),
        "axes": {
            "x": {"position": pos.get("x", 0.0), "velocity": vel.get("x", 0.0), "torque": tor.get("x", 0.0)},
            "y": {"position": pos.get("y", 0.0), "velocity": vel.get("y", 0.0), "torque": tor.get("y", 0.0)},
            "z": {"position": pos.get("z", 0.0), "velocity": vel.get("z", 0.0), "torque": tor.get("z", 0.0)},
        },
        "health_status": health.get("status", "UNKNOWN") if health else "UNKNOWN",
        "health_score":  health.get("score",  0)         if health else 0,
    }


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


def _minutes_ago_str(n: int) -> str:
    return (datetime.now(_VN_TZ) - timedelta(minutes=n)).isoformat()


# Sau bao nhiêu giây không có bản ghi mới thì coi là "mất kết nối / chưa có dữ liệu".
# edge_backend gửi dữ liệu thực ~100ms/lần, nên chỉ cần 2s là đủ để phân biệt
# dữ liệu "đang sống" (mới cách đây 1-2s) với dữ liệu cũ (vài phút/giờ trước) còn sót trong DB.
_SENSOR_STALE_SECONDS = 2


def _doc_age_seconds(doc: dict) -> float | None:
    """Tuổi (giây) của bản ghi, dựa vào mqtt_timestamp hoặc timestamp. None nếu không parse được."""
    raw = doc.get("mqtt_timestamp") or doc.get("timestamp")
    if not raw:
        return None
    try:
        if isinstance(raw, datetime):
            ts = raw
        else:
            ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=_VN_TZ)
        return (datetime.now(timezone.utc) - ts.astimezone(timezone.utc)).total_seconds()
    except (ValueError, TypeError):
        return None


# ── GET /api/monitor/sensor/latest ────────────────────────────────────────

@router.get("/sensor/latest", summary="Sensor thực tế mới nhất (ESP32)")
def sensor_latest(user: CurrentUser) -> dict:
    """Trả về bản ghi sensor mới nhất từ ESP32 (collection Sensor_Data).

    Nếu bản ghi mới nhất đã quá cũ (thiết bị mất kết nối / chưa từng gửi dữ liệu
    trong phiên hiện tại), trả về "no_data" thay vì số liệu đóng băng từ lần
    chạy trước — tránh HMI hiển thị nhầm như đang có dữ liệu/tải thật.
    """
    col = get_col(_COL_SENSOR)
    doc = col.find_one(sort=[("mqtt_timestamp", -1)])
    if not doc:
        doc = col.find_one(sort=[("timestamp", -1)])
    if not doc:
        return {"status": "no_data"}

    age = _doc_age_seconds(doc)
    if age is not None and age > _SENSOR_STALE_SECONDS:
        return {"status": "no_data"}

    return _normalize_sensor(doc)


# ── GET /api/monitor/sensor/history ───────────────────────────────────────

@router.get("/sensor/history", summary="Lịch sử sensor thực tế")
def sensor_history(
    user: CurrentUser,
    minutes: int = Query(10,  ge=1, le=1440, description="Số phút gần đây"),
    limit:   int = Query(500, ge=1, le=5000, description="Số bản ghi tối đa"),
) -> list[dict]:
    """Lấy lịch sử sensor trong N phút gần đây.

    HMI dùng endpoint này để vẽ chart realtime theo khoảng thời gian.
    Tự động downsample nếu kết quả > limit.
    """
    col   = get_col(_COL_SENSOR)
    start = _minutes_ago_str(minutes)

    # Thử field mqtt_timestamp trước (format mới), fallback timestamp
    docs = list(
        col.find({"mqtt_timestamp": {"$gte": start}})
           .sort("mqtt_timestamp", 1)
           .limit(limit * 2)   # lấy dư để downsample
    )
    if not docs:
        docs = list(
            col.find({"timestamp": {"$gte": start}})
               .sort("timestamp", 1)
               .limit(limit * 2)
        )

    # Downsample nếu quá nhiều
    if len(docs) > limit:
        step = len(docs) // limit
        docs = docs[::step]

    return [_normalize_sensor(d) for d in docs]


# ── GET /api/monitor/simulation/latest ────────────────────────────────────

@router.get("/simulation/latest", summary="Simulation MATLAB mới nhất")
def simulation_latest(user: CurrentUser) -> dict:
    """Trả về bản ghi simulation mới nhất từ MATLAB (Simulation_Data)."""
    col = get_col(_COL_SIM)
    # Ưu tiên doc có matlab_results (format Edge Backend mới)
    doc = col.find_one(
        {"matlab_results": {"$exists": True}},
        sort=[("created_at", -1)],
    )
    if not doc:
        doc = col.find_one(sort=[("created_at", -1)])
    if not doc:
        return {"status": "no_data"}
    return _normalize_simulation(doc)


# ── GET /api/monitor/simulation/history ───────────────────────────────────

@router.get("/simulation/history", summary="Lịch sử simulation MATLAB")
def simulation_history(
    user: CurrentUser,
    minutes: int = Query(10,  ge=1, le=1440),
    limit:   int = Query(200, ge=1, le=2000),
) -> list[dict]:
    """Lịch sử simulation trong N phút gần đây."""
    col   = get_col(_COL_SIM)
    start = _minutes_ago_str(minutes)

    docs = list(
        col.find({"created_at": {"$gte": start}})
           .sort("created_at", 1)
           .limit(limit)
    )
    return [_normalize_simulation(d) for d in docs]


# ── GET /api/monitor/alarms ───────────────────────────────────────────────

@router.get("/alarms", summary="Danh sách alarm")
def get_alarms(
    user:     CurrentUser,
    limit:    int  = Query(100, ge=1, le=1000),
    resolved: bool | None = Query(None, description="True=đã xử lý, False=chưa, None=tất cả"),
    level:    str | None  = Query(None, description="warning | critical | emergency"),
) -> list[dict]:
    """Lấy danh sách alarm với filter tùy chọn.

    HMI Monitor → Alarm Table dùng endpoint này.
    """
    col   = get_col(_COL_ALARMS)
    query: dict = {}
    if resolved is not None:
        query["resolved"] = resolved
    if level:
        query["level"] = level

    docs = list(col.find(query).sort("created_at", -1).limit(limit))
    return docs_to_list(docs)


# ── POST /api/monitor/alarms/{id}/resolve ────────────────────────────────

@router.post("/alarms/{alarm_id}/resolve", summary="Đánh dấu alarm đã xử lý")
def resolve_alarm(alarm_id: str, user: OperatorUser) -> dict:
    """Operator đánh dấu một alarm đã được xử lý."""
    col = get_col(_COL_ALARMS)
    try:
        result = col.update_one(
            {"_id": ObjectId(alarm_id)},
            {"$set": {
                "resolved":    True,
                "resolved_by": user["username"],
                "resolved_at": _now_str(),
            }},
        )
    except Exception:
        raise HTTPException(status_code=400, detail="alarm_id không hợp lệ")

    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy alarm")
    return {"status": "ok", "alarm_id": alarm_id}


# ── GET /api/monitor/status ───────────────────────────────────────────────

@router.get("/status", summary="Tổng trạng thái hệ thống")
def system_status(user: CurrentUser) -> dict:
    """Snapshot nhanh toàn bộ hệ thống cho HMI Dashboard.

    Trả về:
    - sensor: bản ghi mới nhất + tuổi dữ liệu (giây)
    - alarms_unresolved: số alarm chưa xử lý
    - alarms_critical: số alarm critical chưa xử lý
    - simulation: bản ghi simulation mới nhất
    """
    # Sensor
    s_col   = get_col(_COL_SENSOR)
    s_doc   = s_col.find_one(sort=[("mqtt_timestamp", -1)])
    if not s_doc:
        s_doc = s_col.find_one(sort=[("timestamp", -1)])

    sensor_age_s: float | None = None
    if s_doc:
        ts_raw = s_doc.get("mqtt_timestamp") or s_doc.get("timestamp")
        if ts_raw:
            try:
                ts = datetime.fromisoformat(str(ts_raw))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=_VN_TZ)
                sensor_age_s = (datetime.now(_VN_TZ) - ts).total_seconds()
            except Exception:
                pass

    # Alarms
    a_col = get_col(_COL_ALARMS)
    unresolved = a_col.count_documents({"resolved": False})
    critical   = a_col.count_documents({"resolved": False, "level": "critical"})

    # Simulation
    sim_col = get_col(_COL_SIM)
    sim_doc = sim_col.find_one(
        {"matlab_results": {"$exists": True}}, sort=[("created_at", -1)]
    )

    return {
        "sensor": {
            "latest":   _normalize_sensor(s_doc) if s_doc else None,
            "age_s":    round(sensor_age_s, 1) if sensor_age_s is not None else None,
            "online":   sensor_age_s is not None and sensor_age_s < 10,
        },
        "alarms": {
            "unresolved": unresolved,
            "critical":   critical,
        },
        "simulation": {
            "latest": _normalize_simulation(sim_doc) if sim_doc else None,
        },
        "timestamp": _now_str(),
    }

# ── GET /api/monitor/alarm/active ─────────────────────────────────────────

@router.get("/alarm/active", summary="Alarm đang active (badge navbar)")
def alarm_active(user: CurrentUser) -> dict:
    """Trả về số lượng và danh sách alarm chưa xử lý (tối đa 10).

    Dùng bởi base.html để hiển thị badge cảnh báo trên navbar toàn bộ trang.
    Chỉ lấy các alarm chưa resolved, ưu tiên critical trước.

    Response shape::

        {
            "count": 3,
            "alarms": [
                {
                    "id":         "...",
                    "level":      "critical",
                    "message":    "Nhiệt độ vượt ngưỡng",
                    "created_at": "2026-07-03T10:00:00+07:00"
                },
                ...
            ]
        }
    """
    col   = get_col(_COL_ALARMS)
    total = col.count_documents({"resolved": False})

    # Lấy tối đa 10 alarm — critical trước, sau đó theo thời gian mới nhất
    docs = list(
        col.find({"resolved": False})
           .sort([("level", 1), ("created_at", -1)])
           .limit(10)
    )

    alarms = [
        {
            "id":         str(d.get("_id", "")),
            "level":      d.get("level", "warning"),
            "message":    d.get("message", d.get("description", "")),
            "created_at": str(d.get("created_at", "")),
        }
        for d in docs
    ]

    return {"count": total, "alarms": alarms}


# ── GET /api/monitor/connection ───────────────────────────────────────────

# Ngưỡng "stale" cho từng nguồn dữ liệu (giây)
_STALE_SENSOR     = 10   # ESP32 gửi ~100ms, 10s là rất cũ
_STALE_SIMULATION = 30   # MATLAB gửi chậm hơn, cho phép 30s
_STALE_SYNC       = 60   # NX MCD sync qua SyncWorker, 60s


@router.get("/connection", summary="Trạng thái kết nối các nguồn dữ liệu")
def connection_status(user: CurrentUser) -> dict:
    """Trả về trạng thái kết nối của FluidNC, MATLAB, NX MCD và MongoDB.

    Dùng bởi base.html để hiển thị các chấm trạng thái kết nối trên navbar.

    Cách xác định:
    - fluidnc : tuổi bản ghi mới nhất trong Sensor_Data
    - matlab  : tuổi bản ghi mới nhất trong Simulation_Data
    - nxmcd   : field nxmcd_synced_at trong Simulation_Data (SyncWorker ghi)
    - mongodb : mongo_ping() trực tiếp

    Response shape::

        {
            "fluidnc": { "connected": true,  "status": "online",  "age_s": 0.8 },
            "matlab":  { "connected": false, "status": "offline", "age_s": 120  },
            "nxmcd":   { "connected": true,  "status": "online",  "age_s": 5.1  },
            "mongodb": { "connected": true,  "status": "online",  "age_s": null }
        }
    """
    now = datetime.now(timezone.utc)

    def _age(doc: dict | None, *fields: str) -> float | None:
        if not doc:
            return None
        for f in fields:
            raw = doc.get(f)
            if not raw:
                continue
            try:
                ts = raw if isinstance(raw, datetime) else datetime.fromisoformat(
                    str(raw).replace("Z", "+00:00")
                )
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                return (now - ts.astimezone(timezone.utc)).total_seconds()
            except (ValueError, TypeError):
                continue
        return None

    def _result(age: float | None, threshold: int) -> dict:
        if age is None:
            return {"connected": False, "status": "no_data", "age_s": None}
        ok = age <= threshold
        return {"connected": ok, "status": "online" if ok else "offline", "age_s": round(age, 1)}

    # FluidNC — qua Sensor_Data
    s_col   = get_col(_COL_SENSOR)
    s_doc   = s_col.find_one(sort=[("mqtt_timestamp", -1)]) or s_col.find_one(sort=[("timestamp", -1)])
    fluidnc = _result(_age(s_doc, "mqtt_timestamp", "timestamp"), _STALE_SENSOR)

    # MATLAB — qua Simulation_Data
    sim_col = get_col(_COL_SIM)
    sim_doc = (
        sim_col.find_one({"matlab_results": {"$exists": True}}, sort=[("created_at", -1)])
        or sim_col.find_one(sort=[("created_at", -1)])
    )
    matlab = _result(_age(sim_doc, "created_at", "timestamp"), _STALE_SIMULATION)

    # NX MCD — field nxmcd_synced_at
    nxmcd_doc = sim_col.find_one(
        {"nxmcd_synced_at": {"$exists": True}}, sort=[("nxmcd_synced_at", -1)]
    )
    nxmcd = _result(_age(nxmcd_doc, "nxmcd_synced_at"), _STALE_SYNC)

    # MongoDB Atlas — ping trực tiếp
    mongo_ok = mongo_ping()
    mongodb  = {"connected": mongo_ok, "status": "online" if mongo_ok else "offline", "age_s": None}

    return {"fluidnc": fluidnc, "matlab": matlab, "nxmcd": nxmcd, "mongodb": mongodb}
