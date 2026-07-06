"""Realtime pose relay for the HMI 3D Digital Twin.

Edge is still the single source of selected motion through Sync Epoch + Control
Selector.  The Cloud backend only relays the selected pose to browser clients;
it does not decide who owns NX MCD and it does not write commands to the machine.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field

router = APIRouter()
_VN_TZ = timezone(timedelta(hours=7))
_SYNC_KEY_ENV = "SYNC_API_KEY"
_DEFAULT_KEY = "cnc_edge_sync_key_change_in_production"
_SYNC_KEY_HEADER = APIKeyHeader(name="X-Sync-Key", auto_error=False)


def _verify_sync_key(key: str | None = Depends(_SYNC_KEY_HEADER)) -> str:
    expected = os.getenv(_SYNC_KEY_ENV, _DEFAULT_KEY)
    if not key or key != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Sync-Key không hợp lệ",
        )
    return key


def _now_str() -> str:
    return datetime.now(_VN_TZ).isoformat()


class PosePublishRequest(BaseModel):
    """Selected pose packet pushed by Edge after Control Selector arbitration."""

    type: str = "pose"
    payload: dict[str, Any] = Field(default_factory=dict)


class _PoseHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.latest: dict[str, Any] = {
            "type": "pose",
            "payload": {
                "source": "cloud_boot",
                "control_owner": "unknown",
                "sync_epoch_id": None,
                "sync_status": "UNKNOWN",
                "run_permission": "UNKNOWN",
                "mpos": {"x": 0.0, "y": 0.0, "z": 0.0},
                "timestamp": _now_str(),
            },
        }

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)
        await websocket.send_json(self.latest)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    async def publish(self, packet: dict[str, Any]) -> int:
        packet.setdefault("type", "pose")
        payload = packet.setdefault("payload", {})
        payload.setdefault("timestamp", _now_str())
        payload.setdefault("source", payload.get("control_owner", "unknown"))
        payload.setdefault("mpos", {"x": 0.0, "y": 0.0, "z": 0.0})
        self.latest = packet

        async with self._lock:
            clients = list(self._clients)
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_json(packet)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
        return len(clients) - len(dead)


pose_hub = _PoseHub()


@router.post("/api/pose/publish", summary="Edge push selected 3D pose for HMI relay")
async def publish_pose(body: PosePublishRequest, _: str = Depends(_verify_sync_key)) -> dict[str, Any]:
    viewers = await pose_hub.publish(body.model_dump() if hasattr(body, "model_dump") else body.dict())
    return {"status": "ok", "viewers": viewers}


@router.get("/api/pose/latest", summary="Latest selected 3D pose packet")
def latest_pose() -> dict[str, Any]:
    return pose_hub.latest


@router.websocket("/ws/pose")
async def pose_ws(websocket: WebSocket) -> None:
    await pose_hub.connect(websocket)
    try:
        while True:
            # Keep the connection alive. Browser messages are optional; Edge
            # updates always arrive through POST /api/pose/publish.
            await websocket.receive_text()
    except WebSocketDisconnect:
        await pose_hub.disconnect(websocket)
    except Exception:
        await pose_hub.disconnect(websocket)
