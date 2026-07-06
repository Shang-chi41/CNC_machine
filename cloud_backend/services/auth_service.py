"""
cloud_backend/services/auth_service.py
Xác thực người dùng bằng JWT + bcrypt.

Flow:
  Login → verify password (bcrypt) → tạo JWT access token
  Protected route → FastAPI Depends(get_current_user) → decode JWT → trả User

User lưu trong MongoDB collection "Users":
  {
    username: str,       # unique
    hashed_password: str,
    role: "admin" | "operator" | "viewer",
    created_at: str,
    last_login: str | null
  }

Seed user mặc định nếu chưa có:
  admin / cnc2026   (role: admin)
  user  / 123456    (role: operator)

Sử dụng trong route:
    from cloud_backend.services.auth_service import (
        login_user, get_current_user, require_role
    )

    @router.post("/login")
    def login(form: LoginForm):
        return login_user(form.username, form.password)

    @router.get("/protected")
    def protected(user = Depends(get_current_user)):
        return {"hello": user["username"]}
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from cloud_backend.services.mongo_service import get_col, doc_to_dict

logger = logging.getLogger("cloud_backend.auth_service")

# ── Config ────────────────────────────────────────────────────────────────
_INSECURE_DEV_SECRET = "cnc_hust_vimes_lab_2026_jwt_secret_change_me"
_SECRET_PLACEHOLDERS = {"", "CHANGE_ME", "CHANGE_ME_GENERATE_A_LONG_RANDOM_SECRET", _INSECURE_DEV_SECRET}
_ALGORITHM   = "HS256"
_EXPIRE_MIN  = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))  # 8 giờ

_USERS_COL   = "Users"
_VN_TZ       = timezone(timedelta(hours=7))

_pwd_ctx     = CryptContext(schemes=["bcrypt"], deprecated="auto")
_bearer      = HTTPBearer(auto_error=False)

# ── Seed accounts mặc định ───────────────────────────────────────────────
_DEFAULT_USERS = [
    {"username": "admin", "password": "cnc2026",  "role": "admin"},
    {"username": "user",  "password": "123456",   "role": "operator"},
]


# ── Pydantic schemas ──────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    username:     str
    role:         str
    expires_in:   int  # giây


# ── Password helpers ──────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


# ── JWT helpers ───────────────────────────────────────────────────────────

def _allow_insecure_defaults() -> bool:
    return os.getenv("ALLOW_INSECURE_DEV_DEFAULTS", "false").strip().lower() in {
        "1", "true", "yes", "on"
    }


def _jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "").strip()
    if secret in _SECRET_PLACEHOLDERS:
        if _allow_insecure_defaults():
            logger.warning("JWT_SECRET đang dùng insecure dev default — chỉ dùng trong test/dev cô lập")
            return _INSECURE_DEV_SECRET
        raise RuntimeError(
            "JWT_SECRET chưa được cấu hình an toàn. Hãy tạo secret dài ngẫu nhiên trong .env."
        )
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET quá ngắn; cần tối thiểu 32 ký tự ngẫu nhiên.")
    return secret


def validate_auth_config() -> None:
    """Fail fast khi cấu hình auth không đủ an toàn để chạy Cloud Backend."""
    _jwt_secret()


def _create_token(data: dict) -> str:
    payload = data.copy()
    expire  = datetime.now(_VN_TZ) + timedelta(minutes=_EXPIRE_MIN)
    payload.update({"exp": expire})
    return jwt.encode(payload, _jwt_secret(), algorithm=_ALGORITHM)


def _decode_token(token: str) -> dict:
    return jwt.decode(token, _jwt_secret(), algorithms=[_ALGORITHM])


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode JWT thành user dict để dùng cho WebSocket/auth ngoài Depends()."""
    try:
        payload = _decode_token(token)
        username: str = payload.get("sub", "")
        role: str = payload.get("role", "viewer")
        if not username:
            raise ValueError("Token không có subject")
        return {"username": username, "role": role}
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token không hợp lệ hoặc hết hạn: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── Seed ─────────────────────────────────────────────────────────────────

def seed_default_users() -> None:
    """Tạo user mặc định nếu collection Users còn trống.
    Gọi một lần trong startup FastAPI.
    """
    col = get_col(_USERS_COL)
    if col.count_documents({}) > 0:
        return
    now = datetime.now(_VN_TZ).isoformat()
    for u in _DEFAULT_USERS:
        col.insert_one({
            "username":        u["username"],
            "hashed_password": hash_password(u["password"]),
            "role":            u["role"],
            "created_at":      now,
            "last_login":      None,
        })
    logger.info(f"Đã seed {len(_DEFAULT_USERS)} user mặc định vào MongoDB")


# ── Core auth logic ───────────────────────────────────────────────────────

def login_user(username: str, password: str) -> TokenResponse:
    """Xác thực username/password, trả về JWT token.

    Raises:
        HTTPException 401 nếu sai thông tin.
    """
    col  = get_col(_USERS_COL)
    user = col.find_one({"username": username})

    if not user or not verify_password(password, user.get("hashed_password", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sai tên đăng nhập hoặc mật khẩu",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Cập nhật last_login
    col.update_one(
        {"username": username},
        {"$set": {"last_login": datetime.now(_VN_TZ).isoformat()}},
    )

    role  = user.get("role", "operator")
    token = _create_token({"sub": username, "role": role})

    logger.info(f"Login OK: {username} ({role})")
    return TokenResponse(
        access_token=token,
        username=username,
        role=role,
        expires_in=_EXPIRE_MIN * 60,
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """FastAPI Dependency: decode JWT từ Authorization header.

    Returns:
        dict {"username": str, "role": str}

    Raises:
        HTTPException 401 nếu token thiếu, hết hạn, hoặc không hợp lệ.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Cần đăng nhập (thiếu token)",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return decode_access_token(credentials.credentials)


def require_role(*roles: str):
    """FastAPI Dependency factory: yêu cầu user có role trong danh sách.

    Dùng:
        @router.post("/admin-only")
        def admin_endpoint(user = Depends(require_role("admin"))):
            ...
    """
    def _check(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cần quyền: {', '.join(roles)}",
            )
        return user
    return _check


# ── User management (dùng cho settings) ──────────────────────────────────

def get_user_info(username: str) -> dict | None:
    """Lấy thông tin user (không có hashed_password)."""
    col = get_col(_USERS_COL)
    doc = col.find_one({"username": username}, {"hashed_password": 0})
    return doc_to_dict(doc) if doc else None


def change_password(username: str, old_password: str, new_password: str) -> bool:
    """Đổi mật khẩu. Trả True nếu thành công."""
    col  = get_col(_USERS_COL)
    user = col.find_one({"username": username})
    if not user or not verify_password(old_password, user.get("hashed_password", "")):
        return False
    col.update_one(
        {"username": username},
        {"$set": {"hashed_password": hash_password(new_password)}},
    )
    logger.info(f"Đổi mật khẩu OK: {username}")
    return True