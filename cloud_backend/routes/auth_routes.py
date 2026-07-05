"""
cloud_backend/routes/auth_routes.py
Endpoint xác thực: đăng nhập, đăng xuất, đổi mật khẩu.

LƯU Ý: file này TRƯỚC ĐÂY chứa nhầm nội dung của main.py (bootstrap FastAPI
app) thay vì router thật — gây ImportError vòng tròn khi main.py tự import
chính nó. Đã viết lại đúng vai trò: APIRouter cho /api/auth/*, khớp với
cloud_backend/services/auth_service.py (đã viết đầy đủ, không cần sửa) và
frontend/js/auth.js (login/logout/changePassword).

Endpoints:
    POST /api/auth/login            { username, password } -> TokenResponse
    POST /api/auth/logout           (JWT stateless — chỉ trả 200 OK)
    POST /api/auth/change-password  { old_password, new_password } -> { status, message }
"""

from __future__ import annotations

from fastapi import APIRouter

from cloud_backend.middleware.auth import CurrentUser
from cloud_backend.services.auth_service import (
    LoginRequest,
    TokenResponse,
    change_password,
    login_user,
)

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest):
    """Đăng nhập, trả về JWT access token."""
    return login_user(body.username, body.password)


@router.post("/logout")
def logout(user: CurrentUser):
    """Đăng xuất.

    JWT là stateless (không lưu session ở server) nên thực chất không có gì
    để "huỷ" phía backend — token sẽ tự hết hạn theo JWT_EXPIRE_MINUTES.
    Endpoint này tồn tại để frontend có chỗ gọi đúng quy ước REST và để dễ
    mở rộng sau này (vd: thêm blacklist token) mà không cần đổi API contract.
    """
    return {"status": "ok", "message": f"Đã đăng xuất: {user['username']}"}


@router.post("/change-password")
def change_password_endpoint(body: dict, user: CurrentUser):
    """Đổi mật khẩu cho user hiện tại.

    Body: { old_password: str, new_password: str }
    """
    old_password = body.get("old_password", "")
    new_password = body.get("new_password", "")

    if not old_password or not new_password:
        return {"status": "error", "message": "Thiếu old_password hoặc new_password"}
    if len(new_password) < 6:
        return {"status": "error", "message": "Mật khẩu mới cần tối thiểu 6 ký tự"}

    ok = change_password(user["username"], old_password, new_password)
    if not ok:
        return {"status": "error", "message": "Mật khẩu cũ không đúng"}
    return {"status": "ok", "message": "Đổi mật khẩu thành công"}
