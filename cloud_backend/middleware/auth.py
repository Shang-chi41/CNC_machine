"""
cloud_backend/middleware/auth.py
FastAPI middleware + dependency helpers cho authentication.

Không phải middleware thuần (không wrap toàn bộ request stack) —
thay vào đó export các Depends() thường dùng để route có thể import
gọn và nhất quán.

Import trong route:
    from cloud_backend.middleware.auth import (
        CurrentUser,       # Depends: bất kỳ user đã đăng nhập
        AdminUser,         # Depends: chỉ admin
        OperatorUser,      # Depends: admin hoặc operator
    )

    @router.get("/data")
    def get_data(user: CurrentUser):
        return {"by": user["username"]}
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from cloud_backend.services.auth_service import get_current_user, require_role

# ── Typed Depends aliases ─────────────────────────────────────────────────
# Dùng Annotated để FastAPI tự sinh OpenAPI security scheme đúng chỗ

CurrentUser  = Annotated[dict, Depends(get_current_user)]
AdminUser    = Annotated[dict, Depends(require_role("admin"))]
OperatorUser = Annotated[dict, Depends(require_role("admin", "operator"))]