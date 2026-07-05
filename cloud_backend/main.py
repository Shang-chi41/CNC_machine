"""
cloud_backend/main.py
Entry point FastAPI cho Cloud Backend — deploy trên Render.

Khởi động:
    uvicorn cloud_backend.main:app --host 0.0.0.0 --port 8000

Env vars cần có trong .env (hoặc Render dashboard):
    MONGO_URI                MongoDB Atlas connection string
    JWT_SECRET               Secret key cho JWT
    JWT_EXPIRE_MINUTES       Thời gian hết hạn token (mặc định 480 = 8h)
    SYNC_API_KEY             API key cho Edge SyncWorker
    TELEGRAM_BOT_TOKEN       Token bot từ @BotFather
    TELEGRAM_CHAT_ID         Chat ID của operator
    TELEGRAM_WEBHOOK_SECRET  Secret xác minh webhook (tuỳ chọn)
    CORS_ORIGINS             Origins HMI, phân tách bằng dấu phẩy
    LOG_LEVEL                DEBUG / INFO / WARNING (mặc định INFO)
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from cloud_backend.middleware.logger import RequestLoggerMiddleware, setup_logging
from cloud_backend.services.mongo_service import ping as mongo_ping
from cloud_backend.services.auth_service import seed_default_users

from cloud_backend.routes.auth_routes      import router as auth_router
from cloud_backend.routes.monitor_routes   import router as monitor_router
from cloud_backend.routes.settings_routes  import router as settings_router
from cloud_backend.routes.ai_routes        import router as ai_router
from cloud_backend.routes.gcode_routes     import router as gcode_router
from cloud_backend.routes.control_routes   import router as control_router
from cloud_backend.routes.sync_routes      import router as sync_router
from cloud_backend.routes.telegram_routes  import router as telegram_router

setup_logging(os.getenv("LOG_LEVEL", "INFO"))

app = FastAPI(
    title       = "CNC Digital Twin — Cloud Backend",
    description = (
        "REST API cho HMI, Edge sync và AI chat.\n\n"
        "**HMI auth:** JWT Bearer — đăng nhập qua `POST /api/auth/login`\n"
        "**Edge sync:** Header `X-Sync-Key` — set trong `.env` SYNC_API_KEY\n"
        "**Telegram:** Webhook tự động nhận lệnh từ operator"
    ),
    version  = "1.0.0",
    docs_url = "/docs",
    redoc_url= "/redoc",
)

# ── CORS ──────────────────────────────────────────────────────────────────
_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins     = _ORIGINS,
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)

app.add_middleware(RequestLoggerMiddleware)

# ── Startup ────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup() -> None:
    if not mongo_ping():
        raise RuntimeError("❌ Không kết nối được MongoDB — Cloud Backend dừng lại")
    seed_default_users()

# ── Health ─────────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
def health():
    return {"status": "ok", "service": "cloud_backend"}

# ── Routers ────────────────────────────────────────────────────────────────
app.include_router(auth_router,     prefix="/api/auth",     tags=["Auth"])
app.include_router(monitor_router,  prefix="/api/monitor",  tags=["Monitor"])
app.include_router(settings_router, prefix="/api/settings", tags=["Settings"])
app.include_router(ai_router,       prefix="/api/ai",       tags=["AI Chat"])
app.include_router(gcode_router,    prefix="/api/gcode",    tags=["G-Code"])
app.include_router(control_router,  prefix="/api/control",  tags=["Control"])
app.include_router(sync_router,     prefix="/api/sync",     tags=["Edge Sync"])
app.include_router(telegram_router, prefix="/api/telegram", tags=["Telegram"])

# ── Static files (Frontend) ─────────────────────────────────────────────────
# Khớp với các đường dẫn HTML hiện có trong frontend/pages/*.html:
#   /static/css/...                  ← frontend/css
#   /static/js/...                   ← frontend/js
#   /static/images/...               ← frontend/assets/icons (logo HUST, Vimes)
#   /static/models/...               ← frontend/assets/models (file .stp cho 3D viewer)
#   /static/cnc_viewer.html, ...     ← frontend/pages (mount gốc, đăng ký SAU CÙNG
#                                       vì là catch-all, không được che các mount con ở trên)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app.mount("/static/css",    StaticFiles(directory=str(_FRONTEND_DIR / "css")),    name="static-css")
app.mount("/static/js",     StaticFiles(directory=str(_FRONTEND_DIR / "js")),     name="static-js")
app.mount("/static/images", StaticFiles(directory=str(_FRONTEND_DIR / "assets" / "icons")),  name="static-images")
app.mount("/static/models", StaticFiles(directory=str(_FRONTEND_DIR / "assets" / "models")), name="static-models")
app.mount("/static",        StaticFiles(directory=str(_FRONTEND_DIR / "pages")), name="static-pages")

# ── Page routes (serve HTML trực tiếp, khớp với href trong navbar base.html) ─
_PAGES_DIR = _FRONTEND_DIR / "pages"


def _serve_page(filename: str) -> FileResponse:
    return FileResponse(str(_PAGES_DIR / filename))


@app.get("/", tags=["Pages"], include_in_schema=False)
def page_home():
    return _serve_page("base.html")


@app.get("/login", tags=["Pages"], include_in_schema=False)
def page_login():
    return _serve_page("login.html")


@app.get("/monitor", tags=["Pages"], include_in_schema=False)
def page_monitor():
    return _serve_page("monitor.html")


@app.get("/control", tags=["Pages"], include_in_schema=False)
def page_control():
    return _serve_page("control.html")


@app.get("/history", tags=["Pages"], include_in_schema=False)
def page_history():
    return _serve_page("history.html")


@app.get("/settings", tags=["Pages"], include_in_schema=False)
def page_settings():
    return _serve_page("settings.html")

@app.get("/cnc3d", tags=["Pages"], include_in_schema=False)
def page_cnc3d():
    return _serve_page("cnc_viewer_glb_realtime.html")
