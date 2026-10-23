from __future__ import annotations

import json
import secrets
import sqlite3
import string
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "discussion.db"

app = FastAPI(title="Immersive Discussion", version="0.1.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db() -> None:
    with closing(connect_db()) as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            topic TEXT NOT NULL,
            environment TEXT NOT NULL DEFAULT 'seminar',
            admin_token TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            username TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            username TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """)
        con.commit()


@app.on_event("startup")
def on_startup() -> None:
    init_db()


def room_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "topic": row["topic"],
        "environment": row["environment"],
        "created_at": row["created_at"],
    }


class CreateRoom(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    topic: str = Field(min_length=2, max_length=240)
    environment: str = Field(default="seminar", max_length=30)


class UpdateRoom(BaseModel):
    topic: str = Field(min_length=2, max_length=240)
    name: str = Field(min_length=2, max_length=80)
    environment: str = Field(default="seminar", max_length=30)
    admin_token: str


@app.get("/")
def home() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/rooms")
def list_rooms() -> list[dict[str, Any]]:
    with closing(connect_db()) as con:
        rows = con.execute(
            "SELECT id, name, topic, environment, created_at FROM rooms ORDER BY created_at DESC"
        ).fetchall()
    return [room_dict(row) for row in rows]


@app.post("/api/rooms")
def create_room(payload: CreateRoom) -> dict[str, Any]:
    room_id = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
    admin_token = secrets.token_urlsafe(24)
    with closing(connect_db()) as con:
        while con.execute("SELECT 1 FROM rooms WHERE id = ?", (room_id,)).fetchone():
            room_id = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
        con.execute(
            "INSERT INTO rooms (id, name, topic, environment, admin_token, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (room_id, payload.name.strip(), payload.topic.strip(), payload.environment, admin_token, now_iso()),
        )
        con.commit()
    return {
        "room": {
            "id": room_id,
            "name": payload.name.strip(),
            "topic": payload.topic.strip(),
            "environment": payload.environment,
        },
        "admin_token": admin_token,
        "invite_url": f"/?room={room_id}",
    }


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str) -> dict[str, Any]:
    with closing(connect_db()) as con:
        row = con.execute(
            "SELECT id, name, topic, environment, created_at FROM rooms WHERE id = ?",
            (room_id.upper(),),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Room not found")
        messages = con.execute(
            "SELECT username, body, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 100",
            (room_id.upper(),),
        ).fetchall()
        notes = con.execute(
            "SELECT id, username, body, created_at FROM notes WHERE room_id = ? ORDER BY id DESC LIMIT 100",
            (room_id.upper(),),
        ).fetchall()
    return {
        "room": room_dict(row),
        "messages": [dict(r) for r in reversed(messages)],
        "notes": [dict(r) for r in reversed(notes)],
    }


@app.patch("/api/rooms/{room_id}")
def update_room(room_id: str, payload: UpdateRoom) -> dict[str, Any]:
    with closing(connect_db()) as con:
        row = con.execute(
            "SELECT admin_token FROM rooms WHERE id = ?", (room_id.upper(),)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Room not found")
        if not secrets.compare_digest(row["admin_token"], payload.admin_token):
            raise HTTPException(status_code=403, detail="Admin authorization failed")
        con.execute(
            "UPDATE rooms SET name = ?, topic = ?, environment = ? WHERE id = ?",
            (payload.name.strip(), payload.topic.strip(), payload.environment, room_id.upper()),
        )
        con.commit()
        updated = con.execute(
            "SELECT id, name, topic, environment, created_at FROM rooms WHERE id = ?",
            (room_id.upper(),),
        ).fetchone()
    return {"room": room_dict(updated)}


class RoomHub:
    def __init__(self) -> None:
        self.connections: dict[str, dict[WebSocket, dict[str, Any]]] = {}

    async def connect(self, room_id: str, websocket: WebSocket, username: str) -> None:
        await websocket.accept()
        self.connections.setdefault(room_id, {})[websocket] = {
            "username": username,
            "x": 0.0,
            "z": 0.0,
            "color": "#" + secrets.token_hex(3),
        }
        await self.broadcast_presence(room_id)

    def disconnect(self, room_id: str, websocket: WebSocket) -> None:
        room = self.connections.get(room_id, {})
        room.pop(websocket, None)
        if not room and room_id in self.connections:
            self.connections.pop(room_id, None)

    async def send(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        await websocket.send_text(json.dumps(payload))

    async def broadcast(self, room_id: str, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.connections.get(room_id, {})):
            try:
                await self.send(ws, payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(room_id, ws)

    async def broadcast_presence(self, room_id: str) -> None:
        participants = [
            {"username": info["username"], "x": info["x"], "z": info["z"], "color": info["color"]}
            for info in self.connections.get(room_id, {}).values()
        ]
        await self.broadcast(room_id, {"type": "presence", "participants": participants})


hub = RoomHub()


@app.websocket("/ws/{room_id}")
async def websocket_room(websocket: WebSocket, room_id: str, username: str = "Guest") -> None:
    room_id = room_id.upper()
    username = " ".join(username.strip().split())[:24] or "Guest"
    with closing(connect_db()) as con:
        exists = con.execute("SELECT 1 FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not exists:
        await websocket.close(code=1008)
        return

    await hub.connect(room_id, websocket, username)
    await hub.send(websocket, {"type": "welcome", "username": username})
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = data.get("type")

            if kind == "chat":
                body = str(data.get("body", "")).strip()[:1000]
                if not body:
                    continue
                created_at = now_iso()
                with closing(connect_db()) as con:
                    con.execute(
                        "INSERT INTO messages (room_id, username, body, created_at) VALUES (?, ?, ?, ?)",
                        (room_id, username, body, created_at),
                    )
                    con.commit()
                await hub.broadcast(room_id, {
                    "type": "chat", "username": username, "body": body, "created_at": created_at
                })

            elif kind == "note":
                body = str(data.get("body", "")).strip()[:1000]
                if not body:
                    continue
                created_at = now_iso()
                with closing(connect_db()) as con:
                    cur = con.execute(
                        "INSERT INTO notes (room_id, username, body, created_at) VALUES (?, ?, ?, ?)",
                        (room_id, username, body, created_at),
                    )
                    note_id = cur.lastrowid
                    con.commit()
                await hub.broadcast(room_id, {
                    "type": "note", "id": note_id, "username": username,
                    "body": body, "created_at": created_at
                })

            elif kind == "move":
                try:
                    x = max(-8.0, min(8.0, float(data.get("x", 0))))
                    z = max(-8.0, min(8.0, float(data.get("z", 0))))
                except (ValueError, TypeError):
                    continue
                info = hub.connections.get(room_id, {}).get(websocket)
                if info:
                    info["x"], info["z"] = x, z
                    await hub.broadcast_presence(room_id)

    except WebSocketDisconnect:
        hub.disconnect(room_id, websocket)
        await hub.broadcast_presence(room_id)
    except Exception:
        hub.disconnect(room_id, websocket)
        try:
            await hub.broadcast_presence(room_id)
        except Exception:
            pass
