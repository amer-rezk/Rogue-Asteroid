// server.js (Node + Express + ws)
// Authoritative simulation: server owns missiles/bullets/waves/upgrades.

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

// ===== Game constants =====
const MAX_PLAYERS = 4;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

const WORLD_H = 600;
const GROUND_Y = 560;
const SEGMENT_W = 360; // each player's “field” width

const BASE_HP_PER_PLAYER = 4;

const BULLET_R = 3;
const BULLET_SPEED = 600;
const BULLET_COOLDOWN = 0.22; // seconds (before upgrades)
const BULLET_DAMAGE = 1;

const MISSILE_R_MIN = 10;
const MISSILE_R_MAX = 18;

const WAVE_BASE_COUNT = 8;
const WAVE_COUNT_SCALE = 2;

// ===== Server state =====
const app = express();
app.use(express.static(path.join(__dirname, "docs")));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** @type {Map<string, any>} */
const players = new Map();

let hostId = null;
let phase = "lobby"; // lobby | playing | upgrades | gameover

let lockedSlots = null; // array of playerIds in slot order once started
let worldW = SEGMENT_W;
let baseHp = BASE_HP_PER_PLAYER;
let wave = 0;

/** @type {Array<any>} */
let missiles = [];
/** @type {Array<any>} */
let bullets = [];

let upgradePicks = new Map(); // playerId -> { options, pickedKey|null }

// ===== Utilities =====
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(2);
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
function rand(a, b) {
  return a + Math.random() * (b - a);
}

function safeSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  for (const p of players.values()) safeSend(p.ws, obj);
}

function getActivePlayerIds() {
  if (phase === "lobby") return Array.from(players.keys());
  return lockedSlots ? lockedSlots.slice() : Array.from(players.keys());
}

function recomputeWorld() {
  const ids = getActivePlayerIds();
  const count = Math.max(1, Math.min(MAX_PLAYERS, ids.length));
  worldW = SEGMENT_W * count;
  baseHp = BASE_HP_PER_PLAYER * count;
}

function slotForPlayer(id) {
  const p = players.get(id);
  return p ? p.slot : -1;
}

function segmentBounds(slot) {
  const x0 = slot * SEGMENT_W;
  const x1 = x0 + SEGMENT_W;
  return { x0, x1 };
}

function turretPositions(slot) {
  const { x0 } = segmentBounds(slot);
  const cx = x0 + SEGMENT_W / 2;
  const offset = SEGMENT_W * 0.22;
  return {
    main: { x: cx, y: GROUND_Y },
    miniL1: { x: cx - offset, y: GROUND_Y },
    miniL2: { x: cx - offset * 2, y: GROUND_Y },
    miniR1: { x: cx + offset, y: GROUND_Y },
    miniR2: { x: cx + offset * 2, y: GROUND_Y },
  };
}

function lobbySnapshot() {
  const list = Array.from(players.values())
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ id: p.id, slot: p.slot, name: p.name || `P${p.slot + 1}` }));
  return { players: list, hostId };
}

// ===== Upgrade system =====
const UPGRADE_POOL = [
  { key: "firerate", title: "Faster firing", desc: "Reduces cooldown between shots." },
  { key: "bulletspeed", title: "Faster bullets", desc: "Bullets travel faster." },
  { key: "damage", title: "More damage", desc: "Bullets deal +1 damage." },
  { key: "mini_left", title: "Unlock mini turret (left)", desc: "Activates a left mini turret that auto-fires in your segment." },
  { key: "mini_right", title: "Unlock mini turret (right)", desc: "Activates a right mini turret that auto-fires in your segment." },
];

function makeUpgradeOptions() {
  const pool = UPGRADE_POOL.slice();
  const opts = [];
  while (opts.length < 3 && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    opts.push(pool.splice(i, 1)[0]);
  }
  return opts;
}

function applyUpgrade(player, key) {
  if (!player.upgrades) player.upgrades = {};
  const u = player.upgrades;
  switch (key) {
    case "firerate":
      u.fireRateMult = (u.fireRateMult ?? 1) * 1.18;
      break;
    case "bulletspeed":
      u.bulletSpeedMult = (u.bulletSpeedMult ?? 1) * 1.12;
      break;
    case "damage":
      u.damageAdd = (u.damageAdd ?? 0) + 1;
      break;
    case "mini_left":
      u.miniLeft = true;
      break;
    case "mini_right":
      u.miniRight = true;
      break;
  }
}

// ===== Spawning =====
function spawnWave() {
  missiles = [];
  bullets = [];

  const count = WAVE_BASE_COUNT + wave * WAVE_COUNT_SCALE;
  for (let i = 0; i < count; i++) {
    const r = rand(MISSILE_R_MIN, MISSILE_R_MAX);
    const x = rand(r, worldW - r);
    const y = rand(-WORLD_H * 0.8, -r);

    const vx = rand(-20 - wave * 2, 20 + wave * 2);
    const vy = rand(70 + wave * 8, 120 + wave * 10);

    missiles.push({
      id: uid(),
      x,
      y,
      vx,
      vy,
      r,
      hp: Math.ceil(r / 8) + Math.floor(wave / 3),
    });
  }
}

// ===== Game phase controls =====
function startGame() {
  if (phase !== "lobby") return;

  const ids = Array.from(players.keys()).sort((a, b) => slotForPlayer(a) - slotForPlayer(b));
  if (ids.length < 1) return;

  lockedSlots = ids.slice(0, MAX_PLAYERS);
  recomputeWorld();

  phase = "playing";
  wave = 1;
  baseHp = BASE_HP_PER_PLAYER * lockedSlots.length;

  // reset upgrades/picks
  upgradePicks = new Map();
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p) {
      p.upgrades = {};
      p.cooldown = 0;
      p.aimX = 0.5;
      p.shooting = false;
      p.turretAngle = -Math.PI / 2;
      p.miniCooldownL = 0;
      p.miniCooldownR = 0;
    }
  }

  spawnWave();
  broadcast({ t: "started", world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, wave });
}

function beginUpgradePhase() {
  phase = "upgrades";
  upgradePicks = new Map();

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p) continue;
    const options = makeUpgradeOptions();
    upgradePicks.set(id, { options, pickedKey: null });
    safeSend(p.ws, { t: "upgrade", options });
  }
}

function maybeEndUpgradePhase() {
  for (const id of lockedSlots) {
    const pickObj = upgradePicks.get(id);
    if (!pickObj || !pickObj.pickedKey) return;
  }

  wave += 1;
  phase = "playing";
  spawnWave();
  broadcast({ t: "wave", wave });
}

function endGame() {
  phase = "gameover";
  broadcast({ t: "gameOver", wave });
}

// ===== Simulation =====
function fireBullet(owner, originX, originY, aimXWorld) {
  const dmg = BULLET_DAMAGE + (owner.upgrades?.damageAdd ?? 0);
  const speed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);

  const aimY = 120;
  const dx = aimXWorld - originX;
  const dy = aimY - originY;
  const len = Math.hypot(dx, dy) || 1;
  const vx = (dx / len) * speed;
  const vy = (dy / len) * speed;

  bullets.push({
    id: uid(),
    ownerId: owner.id,
    x: originX,
    y: originY - 8,
    vx,
    vy,
    r: BULLET_R,
    dmg,
  });
}

function nearestMissileInSegment(x0, x1) {
  let best = null;
  let bestScore = -Infinity;
  for (const m of missiles) {
    if (m.x < x0 || m.x > x1) continue;
    if (m.y > bestScore) {
      bestScore = m.y; // closest to ground = larger y
      best = m;
    }
  }
  return best;
}

function tick() {
  if (phase !== "playing") return;

  // Players & shooting
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p) continue;

    p.cooldown = Math.max(0, (p.cooldown ?? 0) - DT);
    p.miniCooldownL = Math.max(0, (p.miniCooldownL ?? 0) - DT);
    p.miniCooldownR = Math.max(0, (p.miniCooldownR ?? 0) - DT);

    const slot = p.slot;
    const { x0, x1 } = segmentBounds(slot);
    const pos = turretPositions(slot);

    const aimXWorld = x0 + clamp(p.aimX ?? 0.5, 0, 1) * SEGMENT_W;

    p.turretAngle = Math.atan2(120 - pos.main.y, aimXWorld - pos.main.x);

    const baseCooldown = BULLET_COOLDOWN / (p.upgrades?.fireRateMult ?? 1);

    if (p.shooting && p.cooldown <= 0) {
      p.cooldown = baseCooldown;
      fireBullet(p, pos.main.x, pos.main.y, aimXWorld);
    }

    const target = nearestMissileInSegment(x0, x1);
    if (target) {
      if (p.upgrades?.miniLeft && p.miniCooldownL <= 0) {
        p.miniCooldownL = baseCooldown * 0.95;
        fireBullet(p, pos.miniL1.x, pos.miniL1.y, target.x);
      }
      if (p.upgrades?.miniRight && p.miniCooldownR <= 0) {
        p.miniCooldownR = baseCooldown * 0.95;
        fireBullet(p, pos.miniR1.x, pos.miniR1.y, target.x);
      }
    }
  }

  // Missiles
  for (const m of missiles) {
    m.x += m.vx * DT;
    m.y += m.vy * DT;

    if (m.x - m.r < 0) {
      m.x = m.r;
      m.vx = Math.abs(m.vx);
    }
    if (m.x + m.r > worldW) {
      m.x = worldW - m.r;
      m.vx = -Math.abs(m.vx);
    }

    if (m.y + m.r >= GROUND_Y) {
      m.dead = true;
      baseHp -= 1;
    }
  }

  // Bullets
  for (const b of bullets) {
    b.x += b.vx * DT;
    b.y += b.vy * DT;

    if (b.y < -50 || b.y > WORLD_H + 50 || b.x < -50 || b.x > worldW + 50) b.dead = true;
  }

  // Collisions
  for (const b of bullets) {
    if (b.dead) continue;
    for (const m of missiles) {
      if (m.dead) continue;
      const dx = m.x - b.x;
      const dy = m.y - b.y;
      const rr = m.r + b.r;
      if (dx * dx + dy * dy <= rr * rr) {
        m.hp -= b.dmg;
        b.dead = true;
        if (m.hp <= 0) m.dead = true;
        break;
      }
    }
  }

  missiles = missiles.filter((m) => !m.dead);
  bullets = bullets.filter((b) => !b.dead);

  if (baseHp <= 0) {
    endGame();
    return;
  }
  if (missiles.length === 0) {
    beginUpgradePhase();
    return;
  }

  broadcast({
    t: "state",
    ts: Date.now(),
    phase,
    wave,
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
    baseHp,
    missiles: missiles.map((m) => ({ id: m.id, x: m.x, y: m.y, r: m.r, hp: m.hp })),
    bullets: bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, r: b.r })),
    players: lockedSlots.map((id) => {
      const p = players.get(id);
      if (!p) return { id, slot: -1 };
      return {
        id: p.id,
        slot: p.slot,
        name: p.name || `P${p.slot + 1}`,
        turretAngle: p.turretAngle || -Math.PI / 2,
        upgrades: { miniLeft: !!p.upgrades?.miniLeft, miniRight: !!p.upgrades?.miniRight },
      };
    }),
  });
}

// ===== Networking =====
function assignSlot() {
  const used = new Set(Array.from(players.values()).map((p) => p.slot));
  for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return -1;
}

wss.on("connection", (ws) => {
  if (phase !== "lobby") {
    safeSend(ws, { t: "reject", reason: "Game already running. (Baseline: join only in lobby)" });
    ws.close();
    return;
  }

  const slot = assignSlot();
  if (slot < 0) {
    safeSend(ws, { t: "reject", reason: "Lobby is full (max 4)." });
    ws.close();
    return;
  }

  const id = uid();
  const player = {
    id,
    ws,
    slot,
    name: `P${slot + 1}`,
    aimX: 0.5,
    shooting: false,
    upgrades: {},
    cooldown: 0,
  };

  players.set(id, player);
  if (!hostId) hostId = id;

  recomputeWorld();

  safeSend(ws, {
    t: "welcome",
    id,
    slot,
    isHost: id === hostId,
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
    phase,
  });

  broadcast({ t: "lobby", ...lobbySnapshot() });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.t === "hello") {
      const nm = (msg.name || "").toString().slice(0, 16).trim();
      if (nm) p.name = nm;
      broadcast({ t: "lobby", ...lobbySnapshot() });
      return;
    }

    if (msg.t === "start") {
      if (id === hostId && phase === "lobby") startGame();
      return;
    }

    if (msg.t === "input" && phase === "playing") {
      const aimXNorm = Number(msg.aimXNorm);
      p.aimX = Number.isFinite(aimXNorm) ? clamp(aimXNorm, 0, 1) : 0.5;
      p.shooting = !!msg.shooting;
      return;
    }

    if (msg.t === "pickUpgrade" && phase === "upgrades") {
      const pickKey = (msg.key || "").toString();
      const pickObj = upgradePicks.get(id);
      if (!pickObj || pickObj.pickedKey) return;
      if (!pickObj.options.some((o) => o.key === pickKey)) return;

      pickObj.pickedKey = pickKey;
      applyUpgrade(p, pickKey);
      safeSend(p.ws, { t: "picked", key: pickKey });
      maybeEndUpgradePhase();
      return;
    }
  });

  ws.on("close", () => {
    // Lobby only: remove player + host reassign
    players.delete(id);
    if (hostId === id) hostId = players.size ? Array.from(players.keys())[0] : null;
    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  });
});

// Tick loop
setInterval(() => {
  tick();
  if (phase === "lobby") broadcast({ t: "lobby", ...lobbySnapshot() });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}/ws`);
});
