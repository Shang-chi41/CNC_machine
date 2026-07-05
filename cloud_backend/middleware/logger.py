"""
cloud_backend/middleware/logger.py
FastAPI middleware ghi log mọi HTTP request/response.

Đăng ký trong main.py:
    from cloud_backend.middleware.logger import RequestLoggerMiddleware
    app.add_middleware(RequestLoggerMiddleware)

Log format:
    INFO  [GET  ] /api/monitor/sensor  →  200  (12ms)  user=admin
    WARN  [POST ] /api/ai/chat         →  422  (3ms)   user=?
    ERROR [POST ] /api/sync/sensors    →  500  (45ms)  user=edge_sync
"""

from __future__ import annotations

import logging
import time
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger("cloud_backend.http")

# Các path không cần log (health check, static...)
_SKIP_PATHS = {"/health", "/ping", "/favicon.ico", "/docs", "/openapi.json", "/redoc"}


class RequestLoggerMiddleware(BaseHTTPMiddleware):
    """Middleware ghi log request + response time cho mọi API call."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path

        # Bỏ qua các path không cần log
        if path in _SKIP_PATHS or path.startswith("/static"):
            return await call_next(request)

        method  = request.method
        t_start = time.perf_counter()

        # Lấy username từ header nếu có (token đã được decode ở route)
        # Middleware chạy trước auth, nên chỉ lấy được raw header
        auth_header = request.headers.get("authorization", "")
        user_hint   = "?" if not auth_header else "~authed"

        try:
            response = await call_next(request)
            elapsed  = (time.perf_counter() - t_start) * 1000  # ms
            status   = response.status_code

            log_fn = logger.info if status < 400 else (
                logger.warning if status < 500 else logger.error
            )
            log_fn(
                f"[{method:<6}] {path:<40}  →  {status}  ({elapsed:.0f}ms)  user={user_hint}"
            )
            return response

        except Exception as exc:
            elapsed = (time.perf_counter() - t_start) * 1000
            logger.error(
                f"[{method:<6}] {path:<40}  →  EXCEPTION ({elapsed:.0f}ms): {exc}"
            )
            raise


def setup_logging(level: str = "INFO") -> None:
    """Cấu hình logging cơ bản cho Cloud Backend.

    Gọi một lần trong main.py trước khi khởi động FastAPI:
        from cloud_backend.middleware.logger import setup_logging
        setup_logging()
    """
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Tắt bớt noise từ thư viện ngoài
    logging.getLogger("pymongo").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logger.info("Logging đã được cấu hình")