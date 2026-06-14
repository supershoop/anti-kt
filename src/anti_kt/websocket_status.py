from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

import websockets
from websockets.server import WebSocketServerProtocol


@dataclass(frozen=True)
class StatusEvent:
    timestamp: datetime
    status: str
    cheating_suspected: bool
    label: str
    confidence: float
    consecutive_risky_frames: int

    def to_json(self) -> str:
        payload: dict[str, Any] = asdict(self)
        payload["timestamp"] = self.timestamp.isoformat(timespec="milliseconds")
        payload["type"] = "status"
        return json.dumps(payload)


class WebSocketStatusServer:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self._clients: set[WebSocketServerProtocol] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._server: websockets.server.Serve | None = None
        self._latest_message: str | None = None
        self._ready = threading.Event()

    @property
    def url(self) -> str:
        print(self.host);
        return f"ws://{self.host}:{self.port}/status"

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run_loop, name="status-websocket", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)
        if self._loop is None:
            raise RuntimeError("WebSocket server failed to start")

    def broadcast(self, event: StatusEvent) -> None:
        self._latest_message = event.to_json()
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._broadcast_latest(), self._loop)

    def stop(self) -> None:
        if self._loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._stop_server(), self._loop)
        future.result(timeout=5)
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._start_server())
        self._ready.set()
        self._loop.run_forever()
        self._loop.close()

    async def _start_server(self) -> None:
        self._server = await websockets.serve(self._handle_client, self.host, self.port)

    async def _stop_server(self) -> None:
        for client in set(self._clients):
            await client.close(code=1001, reason="Classifier shutting down")
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle_client(self, websocket: WebSocketServerProtocol) -> None:
        self._clients.add(websocket)
        try:
            if self._latest_message is not None:
                await websocket.send(self._latest_message)
            await websocket.wait_closed()
        finally:
            self._clients.discard(websocket)

    async def _broadcast_latest(self) -> None:
        if self._latest_message is None:
            return
        stale_clients: list[WebSocketServerProtocol] = []
        for client in set(self._clients):
            try:
                await client.send(self._latest_message)
            except websockets.ConnectionClosed:
                stale_clients.append(client)
        for client in stale_clients:
            self._clients.discard(client)
