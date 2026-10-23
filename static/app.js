import * as THREE from "three";

const $ = (id) => document.getElementById(id);
const state = {
  room: null, username: "", ws: null, adminToken: "", isAdmin: false,
  scene: null, camera: null, renderer: null, animationId: null,
  avatarMeshes: new Map(), ownMesh: null, keys: new Set(),
  position: { x: 0, z: 0 }, lastMoveSent: 0, drag: null, yaw: 0,
  participants: [], toastTimer: null
};

const palette = ["#4e9d77", "#d59b50", "#7a85c8", "#d47c78", "#4b9da6", "#a17ac2"];

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function setStatus(id, message, isError = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("error", isError);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map(x => x[0] || "").join("").toUpperCase();
}
function roomUrl(id) {
  return `${location.origin}/?room=${encodeURIComponent(id)}`;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
  return data;
}

async function loadRooms() {
  const host = $("roomList");
  try {
    const rooms = await api("/api/rooms");
    if (!rooms.length) {
      host.innerHTML = '<p class="muted">No worlds yet. Create one and invite your group.</p>';
      return;
    }
    host.innerHTML = rooms.map(room => `
      <div class="room-item">
        <div><strong>${escapeHtml(room.name)}</strong><span>${escapeHtml(room.topic)}</span></div>
        <button type="button" data-join-room="${escapeHtml(room.id)}">Join ↗</button>
      </div>`).join("");
    host.querySelectorAll("[data-join-room]").forEach(button => {
      button.addEventListener("click", () => {
        $("joinCode").value = button.dataset.joinRoom;
        if (!$("joinName").value.trim()) $("joinName").value = state.username || "Guest";
        $("joinName").focus();
      });
    });
  } catch (error) {
    host.innerHTML = `<p class="muted">Could not load rooms: ${escapeHtml(error.message)}</p>`;
  }
}

$("refreshRooms").addEventListener("click", loadRooms);

$("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("createStatus", "Creating your world…");
  const payload = {
    name: $("roomName").value.trim(),
    topic: $("roomTopic").value.trim(),
    environment: $("environment").value
  };
  try {
    const result = await api("/api/rooms", { method: "POST", body: JSON.stringify(payload) });
    state.adminToken = result.admin_token;
    state.isAdmin = true;
    sessionStorage.setItem(`admin:${result.room.id}`, result.admin_token);
    toast(`World created. Save your admin key: ${result.admin_token}`);
    await navigator.clipboard?.writeText(result.admin_token).catch(() => {});
    await enterRoom(result.room.id, $("joinName").value.trim() || "Admin", true);
    setStatus("createStatus", "World created. Admin key was copied if clipboard access was available.");
    await loadRooms();
  } catch (error) {
    setStatus("createStatus", error.message, true);
  }
});

$("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("joinCode").value.trim().toUpperCase();
  const username = $("joinName").value.trim();
  if (!code || !username) return;
  setStatus("joinStatus", "Joining world…");
  try {
    await enterRoom(code, username, false);
  } catch (error) {
    setStatus("joinStatus", error.message, true);
  }
});

async function enterRoom(roomId, username, isAdmin = false) {
  const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
  state.room = data.room;
  state.username = username.slice(0, 24);
  state.isAdmin = isAdmin || Boolean(sessionStorage.getItem(`admin:${state.room.id}`));
  state.adminToken = sessionStorage.getItem(`admin:${state.room.id}`) || state.adminToken || "";
  $("homeView").classList.add("hidden");
  $("roomView").classList.remove("hidden");
  $("worldName").textContent = state.room.name;
  $("worldTopic").textContent = state.room.topic;
  $("manageName").value = state.room.name;
  $("manageTopic").value = state.room.topic;
  $("manageEnvironment").value = state.room.environment;
  $("adminToken").value = state.adminToken;
  $("manageTab").classList.toggle("hidden", !state.isAdmin);
  $("chatMessages").innerHTML = "";
  $("notesList").innerHTML = "";
  data.messages.forEach(renderMessage);
  data.notes.forEach(renderNote);
  if (!data.messages.length) $("chatMessages").innerHTML = '<div class="empty-state">Start the conversation. Your messages will appear here.</div>';
  if (!data.notes.length) $("notesList").innerHTML = '<div class="empty-state">No shared notes yet.</div>';
  initWorld(state.room.environment);
  connectSocket();
  activateTab("chat");
  history.replaceState({}, "", `/?room=${encodeURIComponent(state.room.id)}`);
  setStatus("joinStatus", "");
}

$("backHome").addEventListener("click", () => {
  if (state.ws) state.ws.close();
  stopWorld();
  state.room = null;
  $("roomView").classList.add("hidden");
  $("homeView").classList.remove("hidden");
  history.replaceState({}, "", "/");
  loadRooms();
});

$("copyInvite").addEventListener("click", async () => {
  if (!state.room) return;
  const invite = roomUrl(state.room.id);
  try {
    await navigator.clipboard.writeText(invite);
    toast("Invite link copied. Share the room code " + state.room.id + " with your group.");
  } catch {
    prompt("Copy this invite link:", invite);
  }
});

function connectSocket() {
  if (state.ws) state.ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws/${encodeURIComponent(state.room.id)}?username=${encodeURIComponent(state.username)}`;
  state.ws = new WebSocket(url);
  state.ws.addEventListener("open", () => toast("Connected to the discussion"));
  state.ws.addEventListener("message", (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleSocketMessage(data);
  });
  state.ws.addEventListener("close", () => {
    if (state.room) toast("Disconnected from the room. Return home and rejoin to reconnect.");
  });
  state.ws.addEventListener("error", () => toast("Connection error. Check that the local server is running."));
}
function sendSocket(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}
function handleSocketMessage(data) {
  if (data.type === "presence") {
    state.participants = data.participants || [];
    updatePresence();
    updateAvatarMeshes();
  } else if (data.type === "chat") {
    const empty = $("chatMessages").querySelector(".empty-state");
    if (empty) empty.remove();
    renderMessage(data);
  } else if (data.type === "note") {
    const empty = $("notesList").querySelector(".empty-state");
    if (empty) empty.remove();
    renderNote(data);
  }
}
function updatePresence() {
  const people = state.participants;
  $("participantCount").textContent = `${people.length} ${people.length === 1 ? "explorer" : "explorers"} in this world`;
  $("miniAvatars").innerHTML = people.slice(0, 6).map((person, i) =>
    `<span class="mini-avatar" title="${escapeHtml(person.username)}" style="background:${person.color || palette[i % palette.length]}">${escapeHtml(initials(person.username))}</span>`
  ).join("");
}
function renderMessage(message) {
  const empty = $("chatMessages").querySelector(".empty-state");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "message";
  const color = palette[Math.abs(hashCode(message.username || "")) % palette.length];
  const time = message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";
  el.innerHTML = `
    <div class="message-avatar" style="background:${color}">${escapeHtml(initials(message.username))}</div>
    <div class="message-content"><div class="message-meta"><strong>${escapeHtml(message.username)}</strong><time>${escapeHtml(time)}</time></div><div class="message-body">${escapeHtml(message.body)}</div></div>`;
  $("chatMessages").appendChild(el);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}
function renderNote(note) {
  const empty = $("notesList").querySelector(".empty-state");
  if (empty) empty.remove();
  const el = document.createElement("article");
  el.className = "note-card";
  el.innerHTML = `<p>${escapeHtml(note.body)}</p><span>Added by ${escapeHtml(note.username)}${note.created_at ? " · " + escapeHtml(new Date(note.created_at).toLocaleString()) : ""}</span>`;
  $("notesList").prepend(el);
}
function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = $("chatInput").value.trim();
  if (!body) return;
  if (state.ws?.readyState !== WebSocket.OPEN) return toast("Not connected yet.");
  sendSocket({ type: "chat", body });
  $("chatInput").value = "";
  $("chatInput").focus();
});
$("noteForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = $("noteInput").value.trim();
  if (!body) return;
  sendSocket({ type: "note", body });
  $("noteInput").value = "";
});
$("manageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("manageStatus", "Saving…");
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(state.room.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("manageName").value.trim(),
        topic: $("manageTopic").value.trim(),
        environment: $("manageEnvironment").value,
        admin_token: $("adminToken").value.trim()
      })
    });
    state.room = result.room;
    state.adminToken = $("adminToken").value.trim();
    state.isAdmin = true;
    sessionStorage.setItem(`admin:${state.room.id}`, state.adminToken);
    $("worldName").textContent = state.room.name;
    $("worldTopic").textContent = state.room.topic;
    initWorld(state.room.environment);
    setStatus("manageStatus", "Settings saved.");
    toast("World settings updated");
  } catch (error) {
    setStatus("manageStatus", error.message, true);
  }
});

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});
function activateTab(name) {
  document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  ["chat", "notes", "manage"].forEach(tab => $(`${tab}Panel`).classList.toggle("hidden", tab !== name));
}

function initWorld(environment) {
  stopWorld();
  const container = $("worldCanvas");
  $("worldLoading").classList.remove("hidden");
  const oldCanvas = container.querySelector("canvas");
  if (oldCanvas) oldCanvas.remove();
  const width = Math.max(320, container.clientWidth);
  const height = Math.max(280, container.clientHeight);
  const scene = new THREE.Scene();
  const bg = environment === "space" ? 0x17243d : environment === "garden" ? 0xc6dfc7 : 0xd4e5d8;
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 22, 55);
  const camera = new THREE.PerspectiveCamera(54, width / height, 0.1, 100);
  camera.position.set(0, 5.8, 10.5);
  camera.lookAt(0, 0, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;

  const hemi = new THREE.HemisphereLight(environment === "space" ? 0x9db7ff : 0xffffff, 0x627c68, 2.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(-5, 10, 6);
  sun.castShadow = true;
  scene.add(sun);

  const mat = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
  const floorColor = environment === "space" ? 0x263551 : environment === "garden" ? 0x88ae7c : 0xb8cbb9;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), mat(floorColor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.03;
  floor.receiveShadow = true;
  scene.add(floor);

  // Subtle floor grid makes movement and spatial orientation easier.
  const grid = new THREE.GridHelper(30, 30, environment === "space" ? 0x6c82b7 : 0x7f9e87, environment === "space" ? 0x405176 : 0xa5b9a8);
  grid.position.y = 0.005;
  scene.add(grid);

  if (environment === "seminar") buildSeminar(scene, mat);
  else if (environment === "space") buildSpace(scene, mat);
  else buildGarden(scene, mat);

  // Shared topic board.
  const boardGroup = new THREE.Group();
  boardGroup.position.set(0, 2.5, -5.2);
  const board = new THREE.Mesh(new THREE.BoxGeometry(6.8, 2.8, 0.16), mat(environment === "space" ? 0x263d5b : 0x244d3e, 0.45));
  board.castShadow = true;
  boardGroup.add(board);
  const boardText = makeTextPlane(state.room?.topic || "Group discussion", 6.2, 1.9, environment === "space" ? "#dce8ff" : "#f2ffe9");
  boardText.position.z = 0.095;
  boardGroup.add(boardText);
  scene.add(boardGroup);

  const avatars = new Map();
  state.scene = scene;
  state.camera = camera;
  state.renderer = renderer;
  state.avatarMeshes = avatars;
  state.ownMesh = null;
  state.position = { x: 0, z: 1.2 };
  state.yaw = 0;

  function resize() {
    if (!state.renderer || !container.isConnected) return;
    const w = Math.max(320, container.clientWidth);
    const h = Math.max(280, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  state.resizeHandler = resize;
  window.addEventListener("resize", resize);

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());

  function animate() {
    state.animationId = requestAnimationFrame(animate);
    const moving = state.keys.size > 0;
    if (moving) moveStep();
    const own = state.ownMesh;
    if (own) {
      own.position.x = state.position.x;
      own.position.z = state.position.z;
      own.rotation.y = state.yaw;
    }
    // A third-person camera follows the local avatar.
    const targetX = state.position.x + Math.sin(state.yaw) * 7.5;
    const targetZ = state.position.z + Math.cos(state.yaw) * 7.5;
    camera.position.lerp(new THREE.Vector3(targetX, 5.7, targetZ), 0.065);
    camera.lookAt(state.position.x, 1.2, state.position.z - 0.5);
    const now = performance.now();
    if (moving && now - state.lastMoveSent > 70) {
      state.lastMoveSent = now;
      sendSocket({ type: "move", x: state.position.x, z: state.position.z });
    }
    renderer.render(scene, camera);
  }
  state.animateFn = animate;
  buildLocalAvatar();
  updateAvatarMeshes();
  animate();
  $("worldLoading").classList.add("hidden");
}

function makeTextPlane(text, width, height, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 320;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = "600 44px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > 900 && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  const maxLines = 3;
  const visible = lines.slice(0, maxLines);
  const startY = canvas.height / 2 - (visible.length - 1) * 35;
  visible.forEach((value, i) => ctx.fillText(value, canvas.width / 2, startY + i * 70));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }));
  return mesh;
}
function buildSeminar(scene, mat) {
  const wood = mat(0x9b7554), chairMat = mat(0x3e6b56), metal = mat(0x485a52);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.22, 48), wood);
  table.position.set(0, 1.15, 0);
  table.castShadow = true; scene.add(table);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.38, 1.05, 20), metal);
  leg.position.set(0, 0.55, 0); scene.add(leg);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const x = Math.sin(a) * 3.4, z = Math.cos(a) * 3.4;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.18, 0.82), chairMat);
    seat.position.set(x, 0.65, z); seat.rotation.y = a; seat.castShadow = true; scene.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.9, 0.15), chairMat);
    back.position.set(x - Math.sin(a) * 0.35, 1.1, z - Math.cos(a) * 0.35); back.rotation.y = a; scene.add(back);
    const chairLeg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), metal);
    chairLeg.position.set(x, 0.3, z); scene.add(chairLeg);
  }
  addPlant(scene, -7, -3, mat(0x397c59), mat(0xb37b4b));
  addPlant(scene, 7, -3, mat(0x397c59), mat(0xb37b4b));
}
function buildSpace(scene, mat) {
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1.25, 40, 32), mat(0x6b8ec7, 0.5));
  planet.position.set(-7, 3.4, -6); scene.add(planet);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.06, 8, 80), mat(0xd8e4ff));
  ring.position.copy(planet.position); ring.rotation.x = 1.1; scene.add(ring);
  for (let i = 0; i < 22; i++) {
    const star = new THREE.Mesh(new THREE.SphereGeometry(0.045 + Math.random() * 0.06, 8, 8), mat(0xe7edff));
    star.position.set((Math.random() - .5) * 28, 2 + Math.random() * 10, -10 + Math.random() * 24);
    scene.add(star);
  }
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.35, 48), mat(0x40516e));
  platform.position.set(0, 0.18, 0); scene.add(platform);
}
function buildGarden(scene, mat) {
  const path = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 18), mat(0xc8b995));
  path.position.set(0, 0.01, 0); scene.add(path);
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1;
    const z = -7 + Math.floor(i / 2) * 2.5;
    addPlant(scene, side * (2.4 + Math.random() * 1.2), z, mat(i % 3 ? 0x54845b : 0x6e9e70), mat(0x927354));
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + Math.random() * .25), mat(0x9da9a0));
    rock.position.set(side * (4 + Math.random()), 0.2, z + .5); scene.add(rock);
  }
  const pond = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, .08, 40), mat(0x6baeb2, .25));
  pond.position.set(5.7, 0.02, 5); scene.add(pond);
}
function addPlant(scene, x, z, leafMat, potMat) {
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(.35, .25, .65, 16), potMat);
  pot.position.set(x, .32, z); scene.add(pot);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.08, .1, 1.2, 10), matColor(0x6b4e36));
  trunk.position.set(x, 1.15, z); scene.add(trunk);
  for (let i = 0; i < 4; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(.48, 12, 12), leafMat);
    leaf.scale.set(1, 1.2, .85);
    leaf.position.set(x + Math.sin(i * 1.7) * .35, 1.65 + (i % 2) * .4, z + Math.cos(i * 1.7) * .3);
    scene.add(leaf);
  }
}
function matColor(color) { return new THREE.MeshStandardMaterial({ color, roughness: .9 }); }

function createAvatar(color = "#4e9d77") {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: .7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe5b99a, roughness: .85 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.32, .62, 4, 8), material);
  body.position.y = 1.02; body.castShadow = true; group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.28, 16, 12), skin);
  head.position.y = 1.68; head.castShadow = true; group.add(head);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x24382f });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(.025, 8, 8), eyeMat);
    eye.position.set(side * .09, 1.7, .255); group.add(eye);
  }
  const nameTag = makeTextPlane("", 1.8, .5, "#ffffff");
  nameTag.position.y = 2.25;
  nameTag.userData.isNameTag = true;
  group.add(nameTag);
  group.userData.nameTag = nameTag;
  return group;
}
function updateNameTag(group, username) {
  const old = group.userData.nameTag;
  if (old) group.remove(old);
  const tag = makeTextPlane(username, 1.8, .5, "#173629");
  tag.position.y = 2.25;
  group.add(tag);
  group.userData.nameTag = tag;
}
function buildLocalAvatar() {
  if (!state.scene) return;
  const mesh = createAvatar("#276b53");
  updateNameTag(mesh, state.username);
  mesh.position.set(state.position.x, 0, state.position.z);
  state.scene.add(mesh);
  state.ownMesh = mesh;
}
function updateAvatarMeshes() {
  if (!state.scene) return;
  const active = new Set();
  state.participants.forEach((person, index) => {
    active.add(person.username);
    if (person.username === state.username) {
      if (state.ownMesh) {
        state.ownMesh.position.x = person.x;
        state.ownMesh.position.z = person.z;
      }
      return;
    }
    let mesh = state.avatarMeshes.get(person.username);
    if (!mesh) {
      mesh = createAvatar(person.color || palette[index % palette.length]);
      updateNameTag(mesh, person.username);
      state.scene.add(mesh);
      state.avatarMeshes.set(person.username, mesh);
    }
    mesh.position.x = person.x;
    mesh.position.z = person.z;
  });
  for (const [username, mesh] of state.avatarMeshes.entries()) {
    if (!active.has(username)) {
      state.scene.remove(mesh);
      state.avatarMeshes.delete(username);
    }
  }
}

function onKeyDown(event) {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
    event.preventDefault();
    state.keys.add(key);
    moveStep();
  }
}
function onKeyUp(event) { state.keys.delete(event.key.toLowerCase()); }
function moveStep() {
  const speed = .18;
  let dx = 0, dz = 0;
  if (state.keys.has("w") || state.keys.has("arrowup")) dz -= speed;
  if (state.keys.has("s") || state.keys.has("arrowdown")) dz += speed;
  if (state.keys.has("a") || state.keys.has("arrowleft")) dx -= speed;
  if (state.keys.has("d") || state.keys.has("arrowright")) dx += speed;
  state.position.x = Math.max(-8, Math.min(8, state.position.x + dx));
  state.position.z = Math.max(-8, Math.min(8, state.position.z + dz));
}
function onPointerDown(event) {
  if (event.button !== 0) return;
  state.drag = { x: event.clientX, y: event.clientY };
}
function onPointerMove(event) {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.x;
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
  state.yaw += dx * .008;
}
function onPointerUp() { state.drag = null; }

function stopWorld() {
  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;
  if (state.resizeHandler) window.removeEventListener("resize", state.resizeHandler);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  if (state.renderer) {
    state.renderer.dispose();
    state.renderer.domElement.remove();
  }
  if (state.scene) {
    state.scene.traverse(object => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => {
          if (material.map) material.map.dispose();
          material.dispose();
        });
      }
    });
  }
  state.scene = null; state.camera = null; state.renderer = null; state.ownMesh = null;
  state.avatarMeshes = new Map(); state.keys.clear();
}

async function boot() {
  await loadRooms();
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room");
  if (roomId) {
    $("joinCode").value = roomId.toUpperCase();
    const token = sessionStorage.getItem(`admin:${roomId.toUpperCase()}`);
    if (token) {
      state.adminToken = token;
      state.isAdmin = true;
    }
    const rememberedName = localStorage.getItem("immersive-username") || "";
    $("joinName").value = rememberedName;
    if (rememberedName) {
      try { await enterRoom(roomId, rememberedName, Boolean(token)); }
      catch (error) { toast(error.message); }
    } else {
      $("joinName").focus();
      setStatus("joinStatus", "Enter your display name to join this world.");
    }
  }
  $("joinName").addEventListener("change", () => localStorage.setItem("immersive-username", $("joinName").value.trim()));
}
boot();
