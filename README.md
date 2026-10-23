# Immersive Discussion (localhost prototype)

A free, browser-based shared 3D discussion room. An admin creates a room and topic, shares the room code/link, and participants join with a display name. Features include 3D environments, moving avatars, live chat, shared notes, room settings, and a local SQLite database.

## Requirements

- Python 3.10+
- VS Code (recommended)
- Internet connection for the first load of Three.js and Google Fonts from their free public CDNs. No API keys or paid APIs are used.

## Run on Windows

Open this project folder in VS Code. In the integrated terminal, run:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn app:app --reload
```

If PowerShell blocks activation, either run this once in the terminal session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Or skip activation and run the virtual-environment Python directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --reload
```

## Run on macOS/Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn app:app --reload
```

Open http://127.0.0.1:8000 in your browser.

## Test multiplayer on one computer

1. Create a world on the home page.
2. Save the admin key shown after creation. It is also copied to the clipboard if the browser permits it.
3. Copy the invitation link or room code.
4. Open a second browser window or an incognito window at http://127.0.0.1:8000.
5. Enter the room code and a different display name.
6. Test avatar movement, chat, shared notes, and room presence.

For the first local test, use separate browser profiles or an incognito window to avoid sharing the same stored display name.

## Data and privacy

- Room, chat, and note data are stored in `discussion.db` in this folder.
- The database file is created automatically when the app starts.
- To reset the prototype, stop the server and delete `discussion.db`; the data will be recreated on next start.
- Do not use this development prototype with sensitive or confidential discussions. It has no production authentication, rate limiting, moderation, encryption beyond localhost, or abuse protection.
- Admin keys are capability tokens. Keep them private.

## Current limitations

- Three.js is loaded from a public CDN, so the first browser load requires internet access. The Python backend itself does not call paid APIs.
- Participants can join from the same computer. To let other devices join, configure local-network access and firewall rules; do not expose this development server directly to the public internet.
- Avatar position is synchronized, but avatar orientation, animations, spatial voice, and VR headset controls are not implemented yet.
- The admin can edit room details and environment. This version does not yet include a drag-and-drop world builder or AI-generated worlds.
- The world uses simple procedural 3D shapes to keep the project free and self-contained.

## Project structure

```text
immersive_discussion_local/
├── app.py
├── requirements.txt
├── README.md
├── discussion.db          # created on first run
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```

## API overview

- `GET /api/rooms` — list rooms
- `POST /api/rooms` — create a room
- `GET /api/rooms/{room_id}` — get room and recent messages/notes
- `PATCH /api/rooms/{room_id}` — update room settings using the admin key
- `WS /ws/{room_id}?username=...` — live presence, chat, and notes
# VRImmersiveDiscussion
