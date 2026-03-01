const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PLAYER_MAX_HP = 100;
const PLAYER_RADIUS_N = 0.022;
const FIRE_COOLDOWN_MS = 100;
const DEFAULT_DAMAGE = 10;

const app = express();
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let nextId = 1;
const players = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomSpawn() {
  return {
    x: 0.1 + Math.random() * 0.8,
    y: 0.1 + Math.random() * 0.8
  };
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

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(raw);
    }
  }
}

function snapshotPlayers() {
  return Array.from(players.values()).map((p) => ({
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
  }));
}

function sendTo(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

wss.on("connection", (socket) => {
  const id = String(nextId++);
  const spawn = randomSpawn();
  const newPlayer = {
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
  };
  players.set(id, newPlayer);
  socket.playerId = id;

  sendTo(socket, {
    type: "welcome",
    id,
    player: {
      id: newPlayer.id,
      name: newPlayer.name,
      x: newPlayer.x,
      y: newPlayer.y,
      hp: newPlayer.hp,
      maxHp: PLAYER_MAX_HP,
      keys: newPlayer.keys
    }
  });
  broadcast({ type: "players", players: snapshotPlayers() });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const me = players.get(socket.playerId);
    if (!me) return;

    if (message.type === "join") {
      if (typeof message.name === "string") {
        const clean = message.name.trim().slice(0, 18);
        if (clean.length > 0) {
          me.name = clean;
        }
      }
      return;
    }

    if (message.type === "state") {
      if (Number.isFinite(message.x)) me.x = clamp(message.x, 0.02, 0.98);
      if (Number.isFinite(message.y)) me.y = clamp(message.y, 0.02, 0.98);
      if (Number.isFinite(message.aimX)) me.aimX = clamp(message.aimX, 0, 1);
      if (Number.isFinite(message.aimY)) me.aimY = clamp(message.aimY, 0, 1);
      me.firing = Boolean(message.firing);
      return;
    }

    if (message.type === "setHp" && Number.isFinite(message.hp)) {
      me.hp = clamp(Math.round(message.hp), 0, PLAYER_MAX_HP);
      return;
    }

    if (message.type === "addKey" && Number.isFinite(message.amount)) {
      me.keys = Math.max(0, me.keys + Math.round(message.amount));
      return;
    }

    if (message.type === "shoot") {
      const now = Date.now();
      if (now - me.lastShotAt < FIRE_COOLDOWN_MS) return;
      me.lastShotAt = now;

      const ox = Number.isFinite(message.ox) ? message.ox : me.x;
      const oy = Number.isFinite(message.oy) ? message.oy : me.y;
      const dx = Number.isFinite(message.dx) ? message.dx : 0;
      const dy = Number.isFinite(message.dy) ? message.dy : 0;
      const damage = clamp(
        Number.isFinite(message.damage) ? Math.round(message.damage) : DEFAULT_DAMAGE,
        1,
        100
      );

      broadcast({
        type: "shotFired",
        shooterId: me.id,
        ox,
        oy,
        dx,
        dy
      });

      for (const target of players.values()) {
        if (target.id === me.id) continue;
        if (target.hp <= 0) continue;

        if (!rayHitsCircleNormalized(ox, oy, dx, dy, target.x, target.y, PLAYER_RADIUS_N)) {
          continue;
        }

        target.hp = clamp(target.hp - damage, 0, PLAYER_MAX_HP);
        broadcast({
          type: "damagePopup",
          targetId: target.id,
          amount: damage
        });

        if (target.hp <= 0) {
          me.keys += 1;
          target.hp = PLAYER_MAX_HP;
          const respawn = randomSpawn();
          target.x = respawn.x;
          target.y = respawn.y;
          broadcast({
            type: "kill",
            killerId: me.id,
            targetId: target.id
          });
        }
      }
    }
  });

  socket.on("close", () => {
    players.delete(id);
    broadcast({ type: "players", players: snapshotPlayers() });
  });
});

setInterval(() => {
  broadcast({ type: "players", players: snapshotPlayers() });
}, 50);

server.listen(PORT, () => {
  console.log("RIVALS INCREMENTAL server running on http://localhost:" + PORT);
});
