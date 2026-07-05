"""
cloud_backend/services/mongo_service.py
Singleton kết nối MongoDB Atlas cho Cloud Backend.

Tái sử dụng cùng database với Edge Backend (CNC_Database trên MongoDB Atlas).
Cloud Backend chỉ ĐỌC dữ liệu do Edge đẩy lên, và VIẾT vào các collection
thuộc phạm vi Cloud (settings, theme, chat_jobs...).

Collections dùng trong Cloud Backend:
  - Sensor_Data         : actual sensor (Edge đẩy lên, Cloud đọc)
  - Simulation_Data     : MATLAB simulation (Edge đẩy lên, Cloud đọc)
  - Alarms              : alarm events (Edge đẩy lên, Cloud đọc + resolve)
  - Chat_Messages       : lịch sử chat (cả hai bên đọc/ghi)
  - Chat_Jobs           : AI job queue (Cloud tạo, Edge worker poll)
  - GCode_Files         : G-code history (cả hai bên)
  - Uploaded_Images     : ảnh phôi (Cloud nhận upload)
  - Machine_Config      : cấu hình máy (Cloud đọc/ghi, Edge đọc)
  - Theme_Config        : cấu hình theme HMI
  - HMI_Settings        : cấu hình AI provider, network...
  - Users               : tài khoản đăng nhập

Sử dụng:
    from cloud_backend.services.mongo_service import get_col, ping
    col = get_col("Sensor_Data")
"""

from __future__ import annotations

import os
import threading
from typing import Any

from bson import ObjectId
from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.database import Database

# ── Logger đơn giản (cloud backend không dùng edge_backend.utils) ──────────
import logging
logger = logging.getLogger("cloud_backend.mongo_service")

_DEFAULT_DB      = "CNC_Database"
_TIMEOUT_MS      = 3_000    # fail fast thay vì treo 10s
_DEFAULT_URI_ENV = "MONGO_URI"


class _MongoService:
    """Singleton MongoClient cho Cloud Backend."""

    def __init__(self) -> None:
        self._client: MongoClient | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure(self) -> MongoClient:
        with self._lock:
            if self._client is None:
                uri = os.getenv(_DEFAULT_URI_ENV, "")
                if not uri:
                    raise RuntimeError(
                        "MONGO_URI chưa được cấu hình trong biến môi trường (.env)"
                    )
                self._client = MongoClient(
                    uri,
                    serverSelectionTimeoutMS=_TIMEOUT_MS,
                    connectTimeoutMS=_TIMEOUT_MS,
                    socketTimeoutMS=_TIMEOUT_MS * 2
                )
                logger.info("MongoClient (cloud) khởi tạo OK")
            return self._client

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def get_db(self, db_name: str = _DEFAULT_DB) -> Database:
        return self._ensure()[db_name]

    def get_col(self, collection: str, db_name: str = _DEFAULT_DB) -> Collection:
        return self.get_db(db_name)[collection]

    def ping(self) -> bool:
        try:
            self._ensure().admin.command("ping")
            logger.info("MongoDB ping OK")
            return True
        except Exception as e:
            logger.error(f"MongoDB ping lỗi: {e}")
            return False

    def close(self) -> None:
        with self._lock:
            if self._client:
                self._client.close()
                self._client = None
                logger.info("MongoClient (cloud) đã đóng")


# ── Singleton ─────────────────────────────────────────────────────────────
_svc = _MongoService()


# ── Shortcut functions (dùng trong routes) ────────────────────────────────

def get_col(collection: str, db_name: str = _DEFAULT_DB) -> Collection:
    """Trả về Collection theo tên.

    Args:
        collection: Tên collection, ví dụ "Sensor_Data".
        db_name:    Tên database, mặc định "CNC_Database".
    """
    return _svc.get_col(collection, db_name)


def get_db(db_name: str = _DEFAULT_DB) -> Database:
    """Trả về Database object."""
    return _svc.get_db(db_name)


def ping() -> bool:
    """Kiểm tra kết nối MongoDB."""
    return _svc.ping()


# ── Serialization helper ──────────────────────────────────────────────────

def doc_to_dict(doc: dict | None) -> dict | None:
    """Chuyển MongoDB document thành plain dict JSON-serializable.

    Chuyển ObjectId → str. Trả None nếu doc là None.
    """
    if doc is None:
        return None
    result: dict[str, Any] = {}
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            result[k] = str(v)
        elif isinstance(v, dict):
            result[k] = doc_to_dict(v)
        elif isinstance(v, list):
            result[k] = [
                doc_to_dict(i) if isinstance(i, dict) else
                str(i) if isinstance(i, ObjectId) else i
                for i in v
            ]
        else:
            result[k] = v
    return result


def docs_to_list(cursor) -> list[dict]:
    """Chuyển pymongo cursor thành list[dict] JSON-serializable."""
    return [doc_to_dict(d) for d in cursor if d is not None]