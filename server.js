const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PLAYER_MAX_HP = 100;
const PLAYER_RADIUS_N = 0.022;
const FIRE_COOLDOWN_MS = 100;
const DEFAULT_DAMAGE = 10;
const DUEL_SITE_URL = process.env.DUEL_SITE_URL || "";
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

const app = express();
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path !== "/" && !req.path.endsWith(".html")) return next();

  const queryBuild = typeof req.query.v === "string" ? req.query.v : "";
  if (queryBuild === BUILD_ID) return next();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "v") continue;
    if (Array.isArray(value)) {
      for (const part of value) {
        if (typeof part === "string") params.append(key, part);
      }
      continue;
    }
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  params.set("v", BUILD_ID);

  res.redirect(302, req.path + "?" + params.toString());
});
app.use(
  express.static(path.join(__dirname), {
    etag: false,
    lastModified: false
  })
);
app.get("/__build", (_req, res) => {
  res.json({ buildId: BUILD_ID });
});
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let nextId = 1;

const sockets = new Map(); // id -> WebSocket
const lobbyPlayers = new Map(); // id -> player data
const matchQueue = []; // id[]
const pendingRooms = new Map(); // roomId -> { slots: [{ token, claimedBy, name }] }
const duelRooms = new Map(); // roomId -> { players: Map<id, player> }

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomSpawn() {
  return {
    x: 0.1 + Math.random() * 0.8,
    y: 0.1 + Math.random() * 0.8
  };
}

function createId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, 18);
}

function isNameTaken(name, requesterId) {
  const normalized = name.toLowerCase();
  for (const [id, player] of lobbyPlayers.entries()) {
    if (id === requesterId) continue;
    if ((player.name || "").toLowerCase() === normalized) return true;
  }

  for (const room of duelRooms.values()) {
    for (const player of room.players.values()) {
      if (player.id === requesterId) continue;
      if ((player.name || "").toLowerCase() === normalized) return true;
    }
  }

  return false;
}

function buildDuelUrl(roomId, token) {
  const query = "room=" + encodeURIComponent(roomId) + "&token=" + encodeURIComponent(token);
  if (DUEL_SITE_URL) {
    const joiner = DUEL_SITE_URL.includes("?") ? "&" : "?";
    return DUEL_SITE_URL + joiner + query;
  }
  return "/duel.html?" + query;
}

function rayHitsCircleNormalized(ox, oy, dx, dy, cx, cy, radius) {
  const length = Math.hypot(dx, dy);
  if (!length) return false;
  const ndx = dx / length;
  const ndy = dy / length;

  const relX = ox - cx;
  const relY = oy - cy;
  const b = 2 * (relX * ndx + relY * ndy);
  const c = relX * relX + relY * relY - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return false;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / 2;
  const t2 = (-b + sqrtDisc) / 2;
  return t1 >= 0 || t2 >= 0;
}

function sendTo(socket, payload) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function snapshotPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    hp: p.hp,
    maxHp: PLAYER_MAX_HP,
    keys: p.keys,
    aimX: p.aimX,
    aimY: p.aimY,
    firing: p.firing
  };
}

function sendQueueStatus() {
  const queued = matchQueue.filter((id) => sockets.has(id)).length;
  const payload = { type: "queueStatus", queued };
  for (const socket of sockets.values()) {
    if (socket.mode === "lobby") {
      sendTo(socket, payload);
    }
  }
}

function sendLobbyPlayers() {
  const players = Array.from(lobbyPlayers.values()).map(snapshotPlayer);
  const payload = { type: "players", players };
  for (const socket of sockets.values()) {
    if (socket.mode === "lobby") {
      sendTo(socket, payload);
    }
  }
}

function sendDuelPlayers(roomId) {
  const room = duelRooms.get(roomId);
  if (!room) return;
  const players = Array.from(room.players.values()).map(snapshotPlayer);
  const payload = { type: "duelPlayers", players };
  for (const id of room.players.keys()) {
    sendTo(sockets.get(id), payload);
  }
}

function broadcastDuel(roomId, payload) {
  const room = duelRooms.get(roomId);
  if (!room) return;
  for (const id of room.players.keys()) {
    sendTo(sockets.get(id), payload);
  }
}

function removeFromQueue(id) {
  let removed = false;
  for (let i = matchQueue.length - 1; i >= 0; i -= 1) {
    if (matchQueue[i] === id) {
      matchQueue.splice(i, 1);
      removed = true;
    }
  }
  if (removed) {
    const socket = sockets.get(id);
    sendTo(socket, { type: "queueLeft" });
  }
  return removed;
}

function pullNextQueuedId() {
  while (matchQueue.length > 0) {
    const id = matchQueue.shift();
    const socket = sockets.get(id);
    if (!socket || socket.mode !== "lobby" || socket.readyState !== socket.OPEN) continue;
    return id;
  }
  return null;
}

function runMatchmaker() {
  while (true) {
    const aId = pullNextQueuedId();
    const bId = pullNextQueuedId();
    if (!aId || !bId) {
      if (aId) {
        matchQueue.unshift(aId);
      }
      break;
    }

    const aPlayer = lobbyPlayers.get(aId);
    const bPlayer = lobbyPlayers.get(bId);
    const aSocket = sockets.get(aId);
    const bSocket = sockets.get(bId);
    if (!aPlayer || !bPlayer || !aSocket || !bSocket) continue;

    const roomId = createId("room_");
    const slotA = { token: createId("tok_"), claimedBy: null, name: aPlayer.name };
    const slotB = { token: createId("tok_"), claimedBy: null, name: bPlayer.name };
    pendingRooms.set(roomId, {
      createdAt: Date.now(),
      slots: [slotA, slotB]
    });

    sendTo(aSocket, {
      type: "matchFound",
      roomId,
      url: buildDuelUrl(roomId, slotA.token)
    });
    sendTo(bSocket, {
      type: "matchFound",
      roomId,
      url: buildDuelUrl(roomId, slotB.token)
    });
  }

  sendQueueStatus();
}

function handleDuelJoin(socket, message) {
  const roomId = typeof message.room === "string" ? message.room : "";
  const token = typeof message.token === "string" ? message.token : "";
  if (!roomId || !token) {
    sendTo(socket, { type: "duelError", reason: "Missing room/token" });
    return;
  }

  const pending = pendingRooms.get(roomId);
  if (!pending) {
    sendTo(socket, { type: "duelError", reason: "Room expired" });
    return;
  }

  const slot = pending.slots.find((s) => s.token === token && !s.claimedBy);
  if (!slot) {
    sendTo(socket, { type: "duelError", reason: "Invalid token" });
    return;
  }

  let room = duelRooms.get(roomId);
  if (!room) {
    room = { players: new Map() };
    duelRooms.set(roomId, room);
  }
  if (room.players.size >= 2) {
    sendTo(socket, { type: "duelError", reason: "Room full" });
    return;
  }

  socket.mode = "duel";
  socket.roomId = roomId;
  const lobbyMe = lobbyPlayers.get(socket.playerId);
  removeFromQueue(socket.playerId);
  lobbyPlayers.delete(socket.playerId);

  const spawnX = room.players.size === 0 ? 0.2 : 0.8;
  const duelPlayer = {
    id: socket.playerId,
    name: slot.name || "Player" + socket.playerId,
    x: spawnX,
    y: 0.5,
    aimX: spawnX + (spawnX < 0.5 ? 0.15 : -0.15),
    aimY: 0.5,
    firing: false,
    hp: PLAYER_MAX_HP,
    keys: lobbyMe ? Math.max(0, Math.floor(lobbyMe.keys || 0)) : 0,
    lastShotAt: 0
  };

  room.players.set(socket.playerId, duelPlayer);
  slot.claimedBy = socket.playerId;

  if (pending.slots.every((s) => Boolean(s.claimedBy))) {
    pendingRooms.delete(roomId);
  }

  sendTo(socket, {
    type: "duelWelcome",
    id: socket.playerId,
    roomId
  });
  sendDuelPlayers(roomId);
  sendLobbyPlayers();
  sendQueueStatus();
}

function cleanupFromDuel(socket, reason) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const room = duelRooms.get(roomId);
  if (!room) return;

  room.players.delete(socket.playerId);

  if (room.players.size === 0) {
    duelRooms.delete(roomId);
    return;
  }

  for (const otherId of room.players.keys()) {
    const otherSocket = sockets.get(otherId);
    if (otherSocket) {
      otherSocket.mode = "lobby";
      otherSocket.roomId = null;
      otherSocket.hasChosenName = true;
      const spawn = randomSpawn();
      lobbyPlayers.set(otherId, {
        id: otherId,
        name: room.players.get(otherId).name,
        x: spawn.x,
        y: spawn.y,
        aimX: spawn.x + 0.1,
        aimY: spawn.y,
        firing: false,
        hp: PLAYER_MAX_HP,
        keys: room.players.get(otherId).keys || 0,
        lastShotAt: room.players.get(otherId).lastShotAt || 0
      });
      sendTo(otherSocket, { type: "duelEnded", reason });
    }
  }

  duelRooms.delete(roomId);
  sendLobbyPlayers();
}

wss.on("connection", (socket) => {
  const id = String(nextId++);
  const spawn = randomSpawn();
  socket.playerId = id;
  socket.mode = "lobby";
  socket.roomId = null;
  socket.hasChosenName = false;

  sockets.set(id, socket);
  lobbyPlayers.set(id, {
    id,
    name: "Player" + id,
    x: spawn.x,
    y: spawn.y,
    aimX: spawn.x + 0.1,
    aimY: spawn.y,
    firing: false,
    hp: PLAYER_MAX_HP,
    keys: 0,
    lastShotAt: 0
  });

  sendTo(socket, {
    type: "welcome",
    id,
    player: snapshotPlayer(lobbyPlayers.get(id))
  });
  sendQueueStatus();
  sendLobbyPlayers();

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const lobbyMe = lobbyPlayers.get(id);
    const roomId = socket.roomId;
    const room = roomId ? duelRooms.get(roomId) : null;
    const duelMe = room ? room.players.get(id) : null;

    if (message.type === "duelJoin") {
      handleDuelJoin(socket, message);
      return;
    }

    if (message.type === "join" && socket.mode === "lobby" && lobbyMe) {
      const clean = sanitizeName(message.name);
      if (clean.length < 2) {
        sendTo(socket, { type: "nameRejected", reason: "Name must be at least 2 characters" });
        return;
      }
      if (isNameTaken(clean, id)) {
        sendTo(socket, { type: "nameRejected", reason: "That name is already in use" });
        return;
      }
      lobbyMe.name = clean;
      socket.hasChosenName = true;
      sendTo(socket, { type: "nameAccepted", name: clean });
      sendLobbyPlayers();
      return;
    }

    if (message.type === "joinQueue" && socket.mode === "lobby") {
      if (!socket.hasChosenName) {
        sendTo(socket, { type: "nameRequired", reason: "Choose a unique name first" });
        return;
      }
      if (!matchQueue.includes(id)) {
        matchQueue.push(id);
        sendTo(socket, { type: "queueJoined" });
      }
      runMatchmaker();
      return;
    }

    if (message.type === "syncProfile" && socket.mode === "lobby" && lobbyMe) {
      if (Number.isFinite(message.keys)) {
        lobbyMe.keys = clamp(Math.round(message.keys), 0, 1000000);
      }
      if (Number.isFinite(message.hp)) {
        lobbyMe.hp = clamp(Math.round(message.hp), 0, PLAYER_MAX_HP);
      }
      sendTo(socket, {
        type: "profileSynced",
        keys: lobbyMe.keys,
        hp: lobbyMe.hp
      });
      return;
    }

    if (message.type === "leaveQueue" && socket.mode === "lobby") {
      removeFromQueue(id);
      sendQueueStatus();
      return;
    }

    if (socket.mode === "duel" && duelMe) {
      if (message.type === "duelState") {
        if (Number.isFinite(message.x)) duelMe.x = clamp(message.x, 0.02, 0.98);
        if (Number.isFinite(message.y)) duelMe.y = clamp(message.y, 0.02, 0.98);
        if (Number.isFinite(message.aimX)) duelMe.aimX = clamp(message.aimX, 0, 1);
        if (Number.isFinite(message.aimY)) duelMe.aimY = clamp(message.aimY, 0, 1);
        duelMe.firing = Boolean(message.firing);
        return;
      }

      if (message.type === "duelSetHp" && Number.isFinite(message.hp)) {
        duelMe.hp = clamp(Math.round(message.hp), 0, PLAYER_MAX_HP);
        return;
      }

      if (message.type === "duelShoot") {
        const now = Date.now();
        if (now - duelMe.lastShotAt < FIRE_COOLDOWN_MS) return;
        duelMe.lastShotAt = now;

        const ox = Number.isFinite(message.ox) ? message.ox : duelMe.x;
        const oy = Number.isFinite(message.oy) ? message.oy : duelMe.y;
        const dx = Number.isFinite(message.dx) ? message.dx : 0;
        const dy = Number.isFinite(message.dy) ? message.dy : 0;
        const damage = clamp(
          Number.isFinite(message.damage) ? Math.round(message.damage) : DEFAULT_DAMAGE,
          1,
          100
        );

        broadcastDuel(roomId, {
          type: "duelShotFired",
          shooterId: duelMe.id,
          ox,
          oy,
          dx,
          dy
        });

        for (const target of room.players.values()) {
          if (target.id === duelMe.id) continue;
          if (target.hp <= 0) continue;
          if (!rayHitsCircleNormalized(ox, oy, dx, dy, target.x, target.y, PLAYER_RADIUS_N)) continue;

          target.hp = clamp(target.hp - damage, 0, PLAYER_MAX_HP);
          broadcastDuel(roomId, {
            type: "duelDamagePopup",
            targetId: target.id,
            amount: damage
          });

          if (target.hp <= 0) {
            duelMe.keys += 1;
            target.hp = PLAYER_MAX_HP;
            const respawn = randomSpawn();
            target.x = respawn.x;
            target.y = respawn.y;
            broadcastDuel(roomId, {
              type: "duelKill",
              killerId: duelMe.id,
              targetId: target.id
            });
          }
        }
        return;
      }

      return;
    }

    if (socket.mode === "lobby" && lobbyMe) {
      if (message.type === "state") {
        if (Number.isFinite(message.x)) lobbyMe.x = clamp(message.x, 0.02, 0.98);
        if (Number.isFinite(message.y)) lobbyMe.y = clamp(message.y, 0.02, 0.98);
        if (Number.isFinite(message.aimX)) lobbyMe.aimX = clamp(message.aimX, 0, 1);
        if (Number.isFinite(message.aimY)) lobbyMe.aimY = clamp(message.aimY, 0, 1);
        lobbyMe.firing = Boolean(message.firing);
        return;
      }

      if (message.type === "setHp" && Number.isFinite(message.hp)) {
        lobbyMe.hp = clamp(Math.round(message.hp), 0, PLAYER_MAX_HP);
        return;
      }

      if (message.type === "addKey" && Number.isFinite(message.amount)) {
        lobbyMe.keys = Math.max(0, lobbyMe.keys + Math.round(message.amount));
        return;
      }

      if (message.type === "shoot") {
        const now = Date.now();
        if (now - lobbyMe.lastShotAt < FIRE_COOLDOWN_MS) return;
        lobbyMe.lastShotAt = now;

        const ox = Number.isFinite(message.ox) ? message.ox : lobbyMe.x;
        const oy = Number.isFinite(message.oy) ? message.oy : lobbyMe.y;
        const dx = Number.isFinite(message.dx) ? message.dx : 0;
        const dy = Number.isFinite(message.dy) ? message.dy : 0;
        const damage = clamp(
          Number.isFinite(message.damage) ? Math.round(message.damage) : DEFAULT_DAMAGE,
          1,
          100
        );

        for (const target of lobbyPlayers.values()) {
          if (target.id === lobbyMe.id) continue;
          if (target.hp <= 0) continue;

          if (!rayHitsCircleNormalized(ox, oy, dx, dy, target.x, target.y, PLAYER_RADIUS_N)) {
            continue;
          }

          target.hp = clamp(target.hp - damage, 0, PLAYER_MAX_HP);
          for (const lobbySocket of sockets.values()) {
            if (lobbySocket.mode === "lobby") {
              sendTo(lobbySocket, {
                type: "damagePopup",
                targetId: target.id,
                amount: damage
              });
            }
          }

          if (target.hp <= 0) {
            lobbyMe.keys += 1;
            target.hp = PLAYER_MAX_HP;
            const respawn = randomSpawn();
            target.x = respawn.x;
            target.y = respawn.y;
            for (const lobbySocket of sockets.values()) {
              if (lobbySocket.mode === "lobby") {
                sendTo(lobbySocket, {
                  type: "kill",
                  killerId: lobbyMe.id,
                  targetId: target.id
                });
              }
            }
          }
        }

        for (const lobbySocket of sockets.values()) {
          if (lobbySocket.mode === "lobby") {
            sendTo(lobbySocket, {
              type: "shotFired",
              shooterId: lobbyMe.id,
              ox,
              oy,
              dx,
              dy
            });
          }
        }
      }
    }
  });

  socket.on("close", () => {
    removeFromQueue(id);
    cleanupFromDuel(socket, "Opponent disconnected");

    lobbyPlayers.delete(id);
    sockets.delete(id);

    sendLobbyPlayers();
    sendQueueStatus();
  });
});

setInterval(() => {
  sendLobbyPlayers();
  for (const roomId of duelRooms.keys()) {
    sendDuelPlayers(roomId);
  }

  const now = Date.now();
  for (const [roomId, room] of pendingRooms.entries()) {
    if (now - room.createdAt > 120000) {
      pendingRooms.delete(roomId);
    }
  }
}, 50);

server.listen(PORT, () => {
  console.log("RIVALS INCREMENTAL server running on http://localhost:" + PORT);
});
