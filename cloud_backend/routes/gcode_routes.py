"""
cloud_backend/routes/gcode_routes.py
G-code: lịch sử, chi tiết, upload thủ công, xác nhận thực thi.

Flow AI G-code (theo log.md):
    AI sinh G-code → lưu MongoDB (status=pending_validation)
    → MATLAB 1D sim → NX MCD 3D verify → status=approved
    → HMI Toolpath Preview → Operator confirm
    → POST /api/gcode/{id}/confirm → status=confirmed → Edge gửi FluidNC

Endpoints:
    GET  /api/gcode/history            → lịch sử G-code (History page)
    GET  /api/gcode/latest             → G-code mới nhất
    GET  /api/gcode/{id}               → chi tiết 1 G-code
    POST /api/gcode/upload             → upload G-code thủ công
    POST /api/gcode/{id}/confirm       → operator xác nhận thực thi
    POST /api/gcode/{id}/reject        → operator từ chối
    GET  /api/gcode/{id}/download      → download file .nc
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from cloud_backend.middleware.auth import CurrentUser, OperatorUser
from cloud_backend.services.mongo_service import doc_to_dict, docs_to_list, get_col

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))

_COL_GCODE = "GCode_Files"


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


def _parse_gcode_meta(content: str) -> dict:
    """Trích metadata từ nội dung G-code: số dòng, ước tính thời gian."""
    lines      = [l.strip() for l in content.splitlines() if l.strip() and not l.strip().startswith(";")]
    move_count = sum(1 for l in lines if re.match(r"^G[01]\b", l, re.I))
    return {
        "line_count":       len(lines),
        "move_count":       move_count,
        "estimated_time_s": move_count * 2,   # rough estimate
    }


# ══════════════════════════════════════════════════════════════════════════
#  HISTORY  (HMI History page → G-code tab)
# ══════════════════════════════════════════════════════════════════════════

@router.get("/history", summary="Lịch sử G-code")
def gcode_history(
    user:   CurrentUser,
    limit:  int           = Query(50, ge=1, le=500),
    source: str | None    = Query(None, description="ai | manual | upload"),
    status: str | None    = Query(None, description="pending_validation | approved | confirmed | executed | rejected"),
) -> list[dict]:
    """Lịch sử G-code — HMI History page → G-code tab.

    Trả về metadata, không kèm nội dung G-code đầy đủ (dùng GET /{id}).
    """
    col   = get_col(_COL_GCODE)
    query: dict = {}
    if source:
        query["source"] = source
    if status:
        query["status"] = status

    docs = list(
        col.find(query, {"content": 0,  # loại content để payload nhỏ
                         "rejection_reason": 1, "suggested_fix": 1,
                         "status": 1, "filename": 1, "source": 1,
                         "created_at": 1, "created_by": 1,
                         "line_count": 1, "move_count": 1})
           .sort("created_at", -1)
           .limit(limit)
    )
    return docs_to_list(docs)


# ══════════════════════════════════════════════════════════════════════════
#  LATEST
# ══════════════════════════════════════════════════════════════════════════

@router.get("/latest", summary="G-code mới nhất")
def gcode_latest(user: CurrentUser) -> dict:
    """Lấy G-code mới nhất (kèm content) — dùng cho HMI Control page preview."""
    col = get_col(_COL_GCODE)
    doc = col.find_one(sort=[("created_at", -1)])
    if not doc:
        return {"status": "no_data"}
    return doc_to_dict(doc) or {}


# ══════════════════════════════════════════════════════════════════════════
#  DETAIL
# ══════════════════════════════════════════════════════════════════════════

@router.get("/{gcode_id}", summary="Chi tiết G-code theo ID")
def gcode_detail(gcode_id: str, user: CurrentUser) -> dict:
    """Lấy đầy đủ thông tin + nội dung G-code theo ID."""
    col = get_col(_COL_GCODE)
    try:
        doc = col.find_one({"_id": ObjectId(gcode_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")

    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")
    return doc_to_dict(doc) or {}


# ══════════════════════════════════════════════════════════════════════════
#  UPLOAD THỦ CÔNG
# ══════════════════════════════════════════════════════════════════════════

@router.post("/upload", summary="Upload G-code thủ công")
async def upload_gcode(
    user:        OperatorUser,
    file:        UploadFile   = File(...),
    description: str          = Form(""),
    material:    str          = Form(""),
    tool:        str          = Form(""),
) -> dict:
    """Upload file G-code (.nc / .gcode / .txt) từ HMI.

    G-code upload thủ công bỏ qua pipeline AI validation,
    nhưng vẫn cần operator confirm trước khi gửi xuống FluidNC.
    """
    allowed_ext = {"nc", "gcode", "txt", "ngc"}
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=400,
            detail=f"Định dạng không hỗ trợ. Cho phép: {', '.join(sorted(allowed_ext))}",
        )

    raw     = await file.read()
    content = raw.decode("utf-8", errors="replace")
    meta    = _parse_gcode_meta(content)
    now     = _now_str()

    result = get_col(_COL_GCODE).insert_one({
        "filename":    file.filename,
        "content":     content,
        "description": description,
        "material":    material,
        "tool":        tool,
        "source":      "upload",
        "status":      "pending_confirmation",   # upload thủ công bỏ qua validation pipeline
        "uploaded_by": user["username"],
        "created_at":  now,
        **meta,
    })

    return {
        "status":   "ok",
        "gcode_id": str(result.inserted_id),
        "filename": file.filename,
        "lines":    meta["line_count"],
    }


# ══════════════════════════════════════════════════════════════════════════
#  SAVE (dùng nội bộ / từ AI worker qua Edge)
# ══════════════════════════════════════════════════════════════════════════

class SaveGcodeRequest(BaseModel):
    content:     str
    description: str  = ""
    material:    str  = ""
    tool:        str  = ""
    source:      str  = "ai"   # "ai" | "manual"
    filename:    str  = ""


@router.post("/save", summary="Lưu G-code mới (từ AI hoặc thủ công)")
def save_gcode(body: SaveGcodeRequest, user: OperatorUser) -> dict:
    """Lưu G-code vào MongoDB.

    Dùng khi HMI Control page nhận G-code từ AI chat và muốn
    lưu để preview / confirm riêng.
    """
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Nội dung G-code không được trống")

    meta = _parse_gcode_meta(body.content)
    now  = _now_str()

    result = get_col(_COL_GCODE).insert_one({
        "content":     body.content,
        "filename":    body.filename or f"gcode_{now[:10]}.nc",
        "description": body.description,
        "material":    body.material,
        "tool":        body.tool,
        "source":      body.source,
        "status":      "pending_validation" if body.source == "ai" else "pending_confirmation",
        "created_by":  user["username"],
        "created_at":  now,
        **meta,
    })

    return {
        "status":   "ok",
        "gcode_id": str(result.inserted_id),
        "lines":    meta["line_count"],
    }


# ══════════════════════════════════════════════════════════════════════════
#  CONFIRM / REJECT  (Operator action sau khi xem Toolpath Preview)
# ══════════════════════════════════════════════════════════════════════════

@router.post("/{gcode_id}/confirm", summary="Operator xác nhận G-code")
def confirm_gcode(gcode_id: str, user: OperatorUser) -> dict:
    """Operator xác nhận G-code sau khi xem Toolpath Preview.

    Status flow:
        pending_validation → approved (sau MATLAB+NX)
        approved / pending_confirmation → confirmed  ← endpoint này
        confirmed → executed (sau khi Edge gửi FluidNC)

    Khi status=confirmed, Edge Backend sẽ lấy G-code này và gửi xuống FluidNC.
    """
    col = get_col(_COL_GCODE)
    try:
        doc = col.find_one({"_id": ObjectId(gcode_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")

    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")

    current_status = doc.get("status", "")
    allowed_from = {"approved", "pending_confirmation", "pending_validation"}
    if current_status not in allowed_from:
        raise HTTPException(
            status_code=409,
            detail=f"Không thể confirm G-code ở trạng thái '{current_status}'",
        )

    col.update_one(
        {"_id": ObjectId(gcode_id)},
        {"$set": {
            "status":       "confirmed",
            "confirmed_by": user["username"],
            "confirmed_at": _now_str(),
        }},
    )
    return {"status": "ok", "gcode_id": gcode_id, "new_status": "confirmed"}


@router.post("/{gcode_id}/reject", summary="Operator từ chối G-code")
def reject_gcode(
    gcode_id: str, user: OperatorUser,
    reason: str = "", suggested_fix: str = ""
) -> dict:
    """Operator từ chối G-code — không gửi xuống máy."""
    col = get_col(_COL_GCODE)
    try:
        result = col.update_one(
            {"_id": ObjectId(gcode_id)},
            {"$set": {
                "status":           "rejected",
                "rejected_by":      user["username"],
                "rejected_at":      _now_str(),
                "rejection_reason": reason,        # đồng nhất với Edge (bỏ reject_reason)
                "suggested_fix":    suggested_fix, # thêm mới
            }},
        )
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")

    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")
    return {"status": "ok", "gcode_id": gcode_id, "new_status": "rejected"}


# ══════════════════════════════════════════════════════════════════════════
#  DOWNLOAD
# ══════════════════════════════════════════════════════════════════════════

@router.get("/{gcode_id}/download", response_class=PlainTextResponse,
            summary="Download G-code file")
def download_gcode(gcode_id: str, user: CurrentUser) -> str:
    """Download nội dung G-code dạng plain text (.nc)."""
    col = get_col(_COL_GCODE)
    try:
        doc = col.find_one({"_id": ObjectId(gcode_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="gcode_id không hợp lệ")

    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy G-code")

    # Đánh dấu đã download
    col.update_one(
        {"_id": ObjectId(gcode_id)},
        {"$set": {"downloaded": True, "downloaded_at": _now_str()}},
    )

    return doc.get("content", "")