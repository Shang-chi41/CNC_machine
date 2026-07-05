"""
cloud_backend/routes/ai_routes.py
AI Chat: tạo job, poll kết quả, lịch sử, provider status.

Flow (theo log.md):
  HMI → POST /api/ai/chat       → tạo Chat_Job (pending) trong MongoDB
  Edge AIWorker poll Chat_Jobs  → xử lý → lưu Chat_Messages (assistant)
  HMI → GET  /api/ai/chat/{id} → poll kết quả (done=True khi xong)

Endpoints:
    POST /api/ai/chat                   → tạo job AI
    GET  /api/ai/chat/{conv_id}         → poll tin nhắn + trạng thái job
    GET  /api/ai/history                → lịch sử chat (History page)
    GET  /api/ai/provider/status        → tier hiện tại cloud/local/emergency
    POST /api/ai/provider/switch        → chuyển provider (Settings page)
    POST /api/ai/upload/image           → upload ảnh phôi kèm chat
    GET  /api/ai/images                 → danh sách ảnh đã upload
"""

from __future__ import annotations

import base64
import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from cloud_backend.middleware.auth import CurrentUser, OperatorUser
from cloud_backend.services.mongo_service import doc_to_dict, docs_to_list, get_col

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))

_COL_MESSAGES = "Chat_Messages"
_COL_JOBS     = "Chat_Jobs"
_COL_IMAGES   = "Uploaded_Images"
_COL_SETTINGS = "HMI_Settings"


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


# ══════════════════════════════════════════════════════════════════════════
#  CHAT
# ══════════════════════════════════════════════════════════════════════════

class ChatRequest(BaseModel):
    message:      str
    image_id:     str = ""
    action:       str = "chat"      # "chat" | "check_gcode"
    gcode:        str = ""          # G-code content (khi action=check_gcode)
    filename:     str = ""          # tên file G-code


@router.post("/chat", summary="Gửi tin nhắn tới AI")
def send_chat(body: ChatRequest, user: CurrentUser) -> dict:
    """Tạo Chat_Job để Edge AIWorker xử lý.

    Flow:
      1. Lưu tin nhắn user vào Chat_Messages
      2. Tạo job pending trong Chat_Jobs
      3. Trả về conversation_id để HMI poll

    Edge AIWorker sẽ poll Chat_Jobs, gọi AI, lưu kết quả vào
    Chat_Messages với role=assistant, đánh dấu job done.
    """
    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Tin nhắn không được trống")

    # Mỗi lượt chat = 1 conv_id riêng để không lẫn với lượt trước
    conv_id = str(ObjectId())
    now     = _now_str()

    # Lấy base64 ảnh nếu có image_id
    image_b64    = None
    image_format = "png"
    if body.image_id:
        try:
            img_doc = get_col(_COL_IMAGES).find_one({"_id": ObjectId(body.image_id)})
            if img_doc:
                image_b64    = img_doc.get("file_base64")
                image_format = img_doc.get("file_extension", "png")
                # Đánh dấu ảnh đã dùng
                get_col(_COL_IMAGES).update_one(
                    {"_id": ObjectId(body.image_id)},
                    {"$set": {"used": True}},
                )
        except Exception:
            pass

    # Lưu tin nhắn user
    get_col(_COL_MESSAGES).insert_one({
        "conversation_id": conv_id,
        "role":            "user",
        "message":         msg,
        "image_id":        body.image_id or None,
        "username":        user["username"],
        "timestamp":       now,
        "created_at":      now,
    })

    # Tạo job cho Edge AIWorker
    get_col(_COL_JOBS).insert_one({
        "conversation_id": conv_id,
        "question":        msg,
        "action":          body.action,     # "chat" | "check_gcode"
        "gcode":           body.gcode,      # nội dung G-code (nếu check_gcode)
        "filename":        body.filename,   # tên file G-code
        "image_base64":    image_b64,
        "image_format":    image_format,
        "status":          "pending",
        "created_by":      user["username"],
        "created_at":      now,
    })

    return {
        "status":          "ok",
        "conversation_id": conv_id,
        "message":         "AI đang xử lý...",
    }


@router.get("/chat/{conv_id}", summary="Poll kết quả chat")
def poll_chat(conv_id: str, user: CurrentUser) -> dict:
    """Lấy tin nhắn của một conversation và trạng thái job.

    HMI poll endpoint này mỗi 1-2 giây cho đến khi done=True.

    Returns:
        messages: list tin nhắn (user + assistant)
        done:     True khi job đã hoàn thành (có thể dừng poll)
        failed:   True nếu job thất bại
    """
    msgs = list(
        get_col(_COL_MESSAGES)
        .find({"conversation_id": conv_id})
        .sort("created_at", 1)
    )

    job = get_col(_COL_JOBS).find_one({"conversation_id": conv_id})

    result_msgs = []
    for m in msgs:
        role = "assistant" if m.get("role") in ("ai", "assistant") else m.get("role", "user")
        entry = {
            "role":    role,
            "message": m.get("message", ""),
            "time":    m.get("timestamp", m.get("created_at", "")),
        }
        # Trích G-code block nếu có
        if role == "assistant":
            gm = re.search(r"```gcode\n(.*?)\n```", m.get("message", ""), re.DOTALL)
            if gm:
                entry["has_gcode"] = True
                entry["gcode"]     = gm.group(1)
        result_msgs.append(entry)

    job_status = job.get("status", "pending") if job else "unknown"

    return {
        "messages": result_msgs,
        "done":     job_status == "done",
        "failed":   job_status == "failed",
        "status":   job_status,
    }


# ══════════════════════════════════════════════════════════════════════════
#  HISTORY (HMI History page → Chat tab)
# ══════════════════════════════════════════════════════════════════════════

@router.get("/history", summary="Lịch sử chat AI")
def chat_history(
    user:   CurrentUser,
    limit:  int = Query(50, ge=1, le=500),
    search: str = Query("", description="Tìm kiếm theo nội dung"),
) -> list[dict]:
    """Lấy lịch sử chat — HMI History page → Chat tab.

    Chỉ lấy tin nhắn role=user (1 record/lượt chat) để hiển thị dạng table.
    Có thể tìm kiếm theo nội dung message.
    """
    col   = get_col(_COL_MESSAGES)
    query: dict = {"role": "user"}
    if search:
        query["message"] = {"$regex": search, "$options": "i"}

    docs = list(col.find(query).sort("created_at", -1).limit(limit))
    return docs_to_list(docs)


# ══════════════════════════════════════════════════════════════════════════
#  AI PROVIDER STATUS  (Settings page → AI Provider group)
# ══════════════════════════════════════════════════════════════════════════

@router.get("/provider/status", summary="Trạng thái AI provider hiện tại")
def provider_status(user: CurrentUser) -> dict:
    """Trạng thái tier của AI provider.

    Edge AIWorker cập nhật field này vào HMI_Settings sau mỗi lần switch.
    Cloud Backend đọc lại và trả về cho HMI.

    Returns:
        tier: cloud | local | emergency
        provider: tên provider đang dùng (gemini, claude, ollama, rule_based)
        last_switch: thời điểm switch gần nhất
    """
    col = get_col(_COL_SETTINGS)
    doc = col.find_one({"_id": "provider_status"})
    if doc:
        del doc["_id"]
        return doc

    # Fallback: lấy từ ai_provider config
    cfg = col.find_one({"_id": "ai_provider"}) or {}
    return {
        "tier":        "unknown",
        "provider":    cfg.get("primary_provider", "gemini"),
        "last_switch": None,
    }


class SwitchProviderRequest(BaseModel):
    provider: str   # "claude" | "gemini" | "openrouter" | "ollama"


@router.post("/provider/switch", summary="Chuyển AI provider thủ công")
def switch_provider(body: SwitchProviderRequest, user: OperatorUser) -> dict:
    """Operator chuyển cloud provider từ HMI Settings.

    Ghi vào HMI_Settings → Edge AIWorker poll và apply khi nhận được.
    Đây là cơ chế gián tiếp: Cloud ghi lệnh, Edge thực thi.
    """
    _VALID = {"claude", "gemini", "openrouter", "ollama", "rule_based"}
    if body.provider not in _VALID:
        raise HTTPException(
            status_code=400,
            detail=f"Provider không hợp lệ. Hợp lệ: {', '.join(sorted(_VALID))}",
        )

    col = get_col(_COL_SETTINGS)
    col.update_one(
        {"_id": "provider_switch_request"},
        {"$set": {
            "provider":    body.provider,
            "requested_by": user["username"],
            "requested_at": _now_str(),
            "applied":     False,
        }},
        upsert=True,
    )
    return {
        "status":   "ok",
        "message":  f"Yêu cầu chuyển sang '{body.provider}' đã được ghi. Edge sẽ áp dụng.",
        "provider": body.provider,
    }


# ══════════════════════════════════════════════════════════════════════════
#  IMAGE UPLOAD (kèm chat)
# ══════════════════════════════════════════════════════════════════════════

@router.post("/upload/image", summary="Upload ảnh phôi để gửi AI")
async def upload_image(
    user:        CurrentUser,
    file:        UploadFile = File(...),
    description: str        = Form(""),
) -> dict:
    """Upload ảnh phôi/dao/bề mặt — lưu base64 vào MongoDB Uploaded_Images.

    Trả về image_id để dùng trong POST /api/ai/chat body.image_id.
    """
    MAX_SIZE = 10 * 1024 * 1024  # 10 MB
    content  = await file.read()

    if len(content) > MAX_SIZE:
        raise HTTPException(status_code=413, detail="File quá lớn (tối đa 10MB)")

    allowed_ext = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in allowed_ext:
        raise HTTPException(
            status_code=400,
            detail=f"Định dạng không hỗ trợ. Cho phép: {', '.join(sorted(allowed_ext))}",
        )

    b64 = base64.b64encode(content).decode("utf-8")
    now = _now_str()

    result = get_col(_COL_IMAGES).insert_one({
        "filename":       file.filename,
        "file_extension": ext,
        "file_size":      len(content),
        "file_base64":    b64,
        "mime_type":      file.content_type or f"image/{ext}",
        "uploaded_by":    user["username"],
        "uploaded_at":    now,
        "created_at":     now,
        "description":    description,
        "used":           False,
    })

    return {
        "status":   "ok",
        "image_id": str(result.inserted_id),
        "filename": file.filename,
        "size_kb":  round(len(content) / 1024, 1),
    }


@router.get("/images", summary="Danh sách ảnh đã upload")
def list_images(
    user:  CurrentUser,
    limit: int = Query(20, ge=1, le=200),
) -> list[dict]:
    """Lấy danh sách ảnh đã upload (không kèm base64 để tránh payload lớn)."""
    col  = get_col(_COL_IMAGES)
    docs = list(
        col.find({}, {"file_base64": 0})
           .sort("created_at", -1)
           .limit(limit)
    )
    return docs_to_list(docs)