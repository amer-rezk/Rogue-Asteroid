// server.js - Rogue Asteroid
// Authoritative game server with ready system

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
const SEGMENT_W = 360;

const BASE_HP_PER_PLAYER = 5;

const BULLET_R = 2.5;
const BULLET_SPEED = 700;
const BULLET_COOLDOWN = 0.18;
const BULLET_DAMAGE = 1;

const ASTEROID_R_MIN = 8;
const ASTEROID_R_MAX = 16;

const WAVE_BASE_COUNT = 5;
const WAVE_COUNT_SCALE = 3;

const MAX_AIM_ANGLE = (80 * Math.PI) / 180;

// ===== Server state =====
const app = express();
app.use(express.static(path.join(__dirname, "docs")));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const players = new Map();

let hostId = null;
let phase = "lobby";

let lockedSlots = null;
let worldW = SEGMENT_W;
let baseHp = BASE_HP_PER_PLAYER;
let maxBaseHp = BASE_HP_PER_PLAYER;
let wave = 0;

let missiles = [];
let bullets = [];
let particles = [];
let damageNumbers = [];

let upgradePicks = new Map();

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
  maxBaseHp = baseHp;
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
  const offset = SEGMENT_W * 0.20;
  return {
    main: { x: cx, y: GROUND_Y },
    miniL1: { x: cx - offset, y: GROUND_Y },
    miniR1: { x: cx + offset, y: GROUND_Y },
  };
}

function lobbySnapshot() {
  const list = Array.from(players.values())
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ 
      id: p.id, 
      slot: p.slot, 
      name: p.name || `Player ${p.slot + 1}`,
      ready: !!p.ready
    }));
  const allReady = list.length > 0 && list.every(p => p.ready);
  return { players: list, hostId, allReady };
}

// ===== Roguelike Upgrades =====
const UPGRADE_POOL = [
  { key: "firerate", title: "Rapid Fire", desc: "Fire 25% faster", category: "offense", icon: "⚡" },
  { key: "bulletspeed", title: "Hypervelocity", desc: "Bullets 20% faster", category: "offense", icon: "💨" },
  { key: "damage", title: "Armor Piercing", desc: "+1 bullet damage", category: "offense", icon: "💥" },
  { key: "multishot", title: "Twin Cannons", desc: "Fire 2 bullets", category: "offense", icon: "⚔️" },
  { key: "explosive", title: "Blast Radius", desc: "Bullets explode", category: "offense", icon: "💣" },
  { key: "critchance", title: "Lucky Shot", desc: "20% crit chance", category: "offense", icon: "🎯" },
  { key: "mini_left", title: "Left Turret", desc: "Auto-turret left", category: "turret", icon: "🔧" },
  { key: "mini_right", title: "Right Turret", desc: "Auto-turret right", category: "turret", icon: "🔧" },
  { key: "range", title: "Long Range", desc: "Shoot neighbors", category: "turret", icon: "📡" },
  { key: "shield", title: "Shield", desc: "Block 1 hit/wave", category: "defense", icon: "🛡️" },
  { key: "slowfield", title: "Gravity Field", desc: "Slow asteroids 25%", category: "defense", icon: "🌀" },
  { key: "magnet", title: "Homing Bullets", desc: "Bullets track", category: "utility", icon: "🧲" },
  { key: "chain", title: "Chain Damage", desc: "Hits spread", category: "utility", icon: "⛓️" },
];

function makeUpgradeOptions(player) {
  const owned = player.upgrades || {};
  const pool = UPGRADE_POOL.filter(u => {
    if (u.key === "mini_left" && owned.miniLeft) return false;
    if (u.key === "mini_right" && owned.miniRight) return false;
    if (u.key === "range" && owned.range) return false;
    if (u.key === "slowfield" && owned.slowfield) return false;
    if (u.key === "magnet" && owned.magnet) return false;
    if (u.key === "chain" && owned.chain) return false;
    return true;
  });
  
  const opts = [];
  const available = pool.slice();
  while (opts.length < 3 && available.length) {
    const i = Math.floor(Math.random() * available.length);
    opts.push(available.splice(i, 1)[0]);
  }
  return opts;
}

function applyUpgrade(player, key) {
  if (!player.upgrades) player.upgrades = {};
  const u = player.upgrades;
  
  switch (key) {
    case "firerate": u.fireRateMult = (u.fireRateMult ?? 1) * 1.25; break;
    case "bulletspeed": u.bulletSpeedMult = (u.bulletSpeedMult ?? 1) * 1.20; break;
    case "damage": u.damageAdd = (u.damageAdd ?? 0) + 1; break;
    case "multishot": u.multishot = (u.multishot ?? 1) + 1; break;
    case "explosive": u.explosive = (u.explosive ?? 0) + 1; break;
    case "critchance": u.critChance = Math.min(0.6, (u.critChance ?? 0) + 0.20); break;
    case "mini_left": u.miniLeft = true; break;
    case "mini_right": u.miniRight = true; break;
    case "range": u.range = true; break;
    case "shield": u.shield = (u.shield ?? 0) + 1; u.shieldActive = (u.shieldActive ?? 0) + 1; break;
    case "slowfield": u.slowfield = true; break;
    case "magnet": u.magnet = true; break;
    case "chain": u.chain = true; break;
  }
}

// ===== Spawning =====
function spawnWave() {
  missiles = [];
  bullets = [];
  particles = [];
  damageNumbers = [];

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p && p.upgrades?.shield) {
      p.upgrades.shieldActive = p.upgrades.shield;
    }
  }

  const count = WAVE_BASE_COUNT + wave * WAVE_COUNT_SCALE;
  for (let i = 0; i < count; i++) {
    const r = rand(ASTEROID_R_MIN, ASTEROID_R_MAX);
    const x = rand(r + 20, worldW - r - 20);
    const y = rand(-WORLD_H * 0.8, -r - 50);

    const vx = rand(-20 - wave * 1.5, 20 + wave * 1.5);
    const vy = rand(50 + wave * 5, 90 + wave * 7);

    const type = r > 14 ? "large" : r > 10 ? "medium" : "small";
    const baseHpVal = type === "large" ? 4 : type === "medium" ? 2 : 1;

    missiles.push({
      id: uid(),
      x, y, vx, vy, r, type,
      hp: baseHpVal + Math.floor(wave / 3),
      maxHp: baseHpVal + Math.floor(wave / 3),
      rotation: rand(0, Math.PI * 2),
      rotSpeed: rand(-3, 3),
      vertices: generateAsteroidShape(r),
    });
  }
}

function generateAsteroidShape(baseRadius) {
  const points = [];
  const numPoints = 10 + Math.floor(Math.random() * 4);
  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    const variance = 0.6 + Math.random() * 0.4;
    points.push({ angle, dist: variance });
  }
  return points;
}

// ===== Game phases =====
function startGame() {
  if (phase !== "lobby") return;

  const ids = Array.from(players.keys()).sort((a, b) => slotForPlayer(a) - slotForPlayer(b));
  if (ids.length < 1) return;

  lockedSlots = ids.slice(0, MAX_PLAYERS);
  recomputeWorld();

  phase = "playing";
  wave = 1;
  baseHp = BASE_HP_PER_PLAYER * lockedSlots.length;
  maxBaseHp = baseHp;

  upgradePicks = new Map();
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p) {
      p.upgrades = {};
      p.cooldown = 0;
      p.aimX = 0.5;
      p.manualShooting = false;
      p.turretAngle = -Math.PI / 2;
      p.miniCooldownL = 0;
      p.miniCooldownR = 0;
      p.score = 0;
      p.ready = false;
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
    const options = makeUpgradeOptions(p);
    upgradePicks.set(id, { options, pickedKey: null });
    safeSend(p.ws, { t: "upgrade", options });
  }
  
  broadcast({ t: "upgradePhase" });
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

function resetToLobby() {
  phase = "lobby";
  lockedSlots = null;
  missiles = [];
  bullets = [];
  particles = [];
  damageNumbers = [];
  upgradePicks = new Map();
  wave = 0;

  const arr = Array.from(players.values()).sort((a, b) => a.slot - b.slot);
  arr.forEach((p, i) => {
    p.slot = i;
    p.ready = false;
  });

  hostId = players.size ? Array.from(players.keys())[0] : null;
  recomputeWorld();
  broadcast({ t: "lobby", ...lobbySnapshot() });
}

function endGame() {
  phase = "gameover";
  
  const scores = lockedSlots.map(id => {
    const p = players.get(id);
    return { id, name: p?.name || "???", score: p?.score || 0, slot: p?.slot || 0 };
  }).sort((a, b) => b.score - a.score);
  
  broadcast({ t: "gameOver", wave, scores });

  setTimeout(() => {
    if (phase === "gameover") resetToLobby();
  }, 6000);
}

// ===== Simulation =====
function fireBullet(owner, originX, originY, targetX, targetY, angleOffset = 0) {
  const dmg = BULLET_DAMAGE + (owner.upgrades?.damageAdd ?? 0);
  const speed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);
  const isCrit = Math.random() < (owner.upgrades?.critChance ?? 0);
  const finalDmg = isCrit ? dmg * 3 : dmg;

  let dx = targetX - originX;
  let dy = targetY - originY;
  let len = Math.hypot(dx, dy) || 1;
  
  if (angleOffset !== 0) {
    const angle = Math.atan2(dy, dx) + angleOffset;
    dx = Math.cos(angle) * len;
    dy = Math.sin(angle) * len;
  }
  
  const vx = (dx / len) * speed;
  const vy = (dy / len) * speed;

  bullets.push({
    id: uid(),
    ownerId: owner.id,
    ownerSlot: owner.slot,
    x: originX,
    y: originY - 6,
    vx, vy,
    r: BULLET_R,
    dmg: finalDmg,
    isCrit,
    explosive: owner.upgrades?.explosive ?? 0,
    magnet: !!owner.upgrades?.magnet,
    chain: !!owner.upgrades?.chain,
  });
}

function fireWithMultishot(owner, originX, originY, targetX, targetY) {
  const shots = owner.upgrades?.multishot ?? 1;
  if (shots === 1) {
    fireBullet(owner, originX, originY, targetX, targetY);
  } else {
    const spread = 0.12;
    const startOffset = -((shots - 1) / 2) * spread;
    for (let i = 0; i < shots; i++) {
      fireBullet(owner, originX, originY, targetX, targetY, startOffset + i * spread);
    }
  }
}

function findBestTarget(x0, x1, turretX, turretY, canExtend) {
  let best = null;
  let bestScore = -Infinity;
  
  const searchX0 = canExtend ? Math.max(0, x0 - SEGMENT_W) : x0;
  const searchX1 = canExtend ? Math.min(worldW, x1 + SEGMENT_W) : x1;
  
  for (const m of missiles) {
    if (m.x < searchX0 || m.x > searchX1) continue;
    if (m.y < 0) continue;
    
    const danger = m.y / GROUND_Y;
    const dist = Math.hypot(m.x - turretX, m.y - turretY);
    const score = danger * 1000 - dist * 0.1;
    
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function clampAimAngle(turretX, turretY, targetX, targetY) {
  const dx = targetX - turretX;
  const dy = targetY - turretY;
  let angle = Math.atan2(dy, dx);
  
  const fromVertical = angle - (-Math.PI / 2);
  const clampedFromVertical = clamp(fromVertical, -MAX_AIM_ANGLE, MAX_AIM_ANGLE);
  const clampedAngle = -Math.PI / 2 + clampedFromVertical;
  
  const dist = Math.hypot(dx, dy);
  return {
    x: turretX + Math.cos(clampedAngle) * dist,
    y: turretY + Math.sin(clampedAngle) * dist,
    angle: clampedAngle
  };
}

function createExplosion(x, y, radius, color) {
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
    particles.push({
      x, y,
      vx: Math.cos(angle) * rand(60, 120),
      vy: Math.sin(angle) * rand(60, 120),
      life: rand(0.3, 0.5),
      maxLife: 0.5,
      color: color || "#f80",
      size: rand(2, 4),
    });
  }
}

function addDamageNumber(x, y, amount, isCrit) {
  damageNumbers.push({
    x, y,
    amount,
    isCrit,
    life: 1.0,
    vy: -60,
  });
}

function tick() {
  if (phase !== "playing") return;

  // Update particles
  particles = particles.filter(p => {
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    p.life -= DT;
    p.vx *= 0.95;
    p.vy *= 0.95;
    return p.life > 0;
  });

  // Update damage numbers
  damageNumbers = damageNumbers.filter(d => {
    d.y += d.vy * DT;
    d.life -= DT * 1.5;
    return d.life > 0;
  });

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
    const canExtend = !!p.upgrades?.range;

    const baseCooldown = BULLET_COOLDOWN / (p.upgrades?.fireRateMult ?? 1);

    let targetX, targetY;
    
    if (p.manualShooting) {
      targetX = x0 + clamp(p.aimX ?? 0.5, 0, 1) * SEGMENT_W;
      targetY = 50;
    } else {
      const target = findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
      if (target) {
        targetX = target.x;
        targetY = target.y;
      } else {
        targetX = pos.main.x;
        targetY = 50;
      }
    }

    const clamped = clampAimAngle(pos.main.x, pos.main.y, targetX, targetY);
    p.turretAngle = clamped.angle;

    const shouldFire = p.manualShooting || findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
    
    if (shouldFire && p.cooldown <= 0) {
      p.cooldown = baseCooldown;
      fireWithMultishot(p, pos.main.x, pos.main.y, clamped.x, clamped.y);
    }

    const autoTarget = findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
    if (autoTarget) {
      if (p.upgrades?.miniLeft && p.miniCooldownL <= 0) {
        p.miniCooldownL = baseCooldown * 0.85;
        const miniClamped = clampAimAngle(pos.miniL1.x, pos.miniL1.y, autoTarget.x, autoTarget.y);
        fireBullet(p, pos.miniL1.x, pos.miniL1.y, miniClamped.x, miniClamped.y);
      }
      if (p.upgrades?.miniRight && p.miniCooldownR <= 0) {
        p.miniCooldownR = baseCooldown * 0.85;
        const miniClamped = clampAimAngle(pos.miniR1.x, pos.miniR1.y, autoTarget.x, autoTarget.y);
        fireBullet(p, pos.miniR1.x, pos.miniR1.y, miniClamped.x, miniClamped.y);
      }
    }
  }

  // Missiles
  for (const m of missiles) {
    let speedMult = 1;
    for (const id of lockedSlots) {
      const p = players.get(id);
      if (!p?.upgrades?.slowfield) continue;
      const { x0, x1 } = segmentBounds(p.slot);
      if (m.x >= x0 && m.x <= x1) {
        speedMult = 0.75;
        break;
      }
    }

    m.x += m.vx * DT * speedMult;
    m.y += m.vy * DT * speedMult;
    m.rotation += m.rotSpeed * DT;

    if (m.x - m.r < 0) { m.x = m.r; m.vx = Math.abs(m.vx); }
    if (m.x + m.r > worldW) { m.x = worldW - m.r; m.vx = -Math.abs(m.vx); }

    if (m.y + m.r >= GROUND_Y) {
      let blocked = false;
      for (const id of lockedSlots) {
        const p = players.get(id);
        if (!p?.upgrades?.shieldActive) continue;
        const { x0, x1 } = segmentBounds(p.slot);
        if (m.x >= x0 && m.x <= x1 && p.upgrades.shieldActive > 0) {
          p.upgrades.shieldActive--;
          blocked = true;
          createExplosion(m.x, GROUND_Y - 5, 30, "#0ff");
          break;
        }
      }
      
      m.dead = true;
      if (!blocked) {
        baseHp -= 1;
        createExplosion(m.x, GROUND_Y - 5, 40, "#f44");
      }
    }
  }

  // Bullets with magnet
  for (const b of bullets) {
    if (b.magnet) {
      let nearest = null;
      let nearestDist = 150;
      for (const m of missiles) {
        if (m.dead) continue;
        const d = Math.hypot(m.x - b.x, m.y - b.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = m;
        }
      }
      if (nearest) {
        const dx = nearest.x - b.x;
        const dy = nearest.y - b.y;
        const len = Math.hypot(dx, dy) || 1;
        b.vx += (dx / len) * 500 * DT;
        b.vy += (dy / len) * 500 * DT;
        const speed = Math.hypot(b.vx, b.vy);
        const targetSpeed = BULLET_SPEED * 1.1;
        b.vx = (b.vx / speed) * targetSpeed;
        b.vy = (b.vy / speed) * targetSpeed;
      }
    }

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
        
        addDamageNumber(m.x, m.y - m.r, b.dmg, b.isCrit);
        
        const owner = players.get(b.ownerId);
        if (owner) {
          owner.score = (owner.score || 0) + b.dmg * 10;
          if (m.hp <= 0) owner.score += 50;
        }
        
        if (b.explosive > 0) {
          createExplosion(b.x, b.y, 35, "#fa0");
          for (const m2 of missiles) {
            if (m2.dead || m2 === m) continue;
            const d = Math.hypot(m2.x - b.x, m2.y - b.y);
            if (d < 35 + m2.r) {
              m2.hp -= 1;
              if (m2.hp <= 0) m2.dead = true;
            }
          }
        }
        
        if (b.chain && m.hp <= 0) {
          for (const m2 of missiles) {
            if (m2.dead || m2 === m) continue;
            const d = Math.hypot(m2.x - m.x, m2.y - m.y);
            if (d < 70) {
              m2.hp -= 1;
              addDamageNumber(m2.x, m2.y - m2.r, 1, false);
              if (m2.hp <= 0) m2.dead = true;
              particles.push({
                x: m.x, y: m.y,
                vx: (m2.x - m.x) * 3,
                vy: (m2.y - m.y) * 3,
                life: 0.12, maxLife: 0.12,
                color: "#ff0", size: 2,
              });
              break;
            }
          }
        }
        
        createExplosion(b.x, b.y, 15, b.isCrit ? "#ff0" : "#0ff");
        
        if (m.hp <= 0) {
          m.dead = true;
          createExplosion(m.x, m.y, 25, "#fa0");
        }
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
    maxBaseHp,
    missiles: missiles.map((m) => ({
      id: m.id, x: m.x, y: m.y, r: m.r,
      hp: m.hp, maxHp: m.maxHp, type: m.type,
      rotation: m.rotation, vertices: m.vertices,
    })),
    bullets: bullets.map((b) => ({
      id: b.id, x: b.x, y: b.y, r: b.r,
      vx: b.vx, vy: b.vy,
      slot: b.ownerSlot, isCrit: b.isCrit,
    })),
    particles: particles.map((p) => ({
      x: p.x, y: p.y, life: p.life, maxLife: p.maxLife,
      color: p.color, size: p.size,
    })),
    damageNumbers: damageNumbers.map((d) => ({
      x: d.x, y: d.y, amount: d.amount, isCrit: d.isCrit, life: d.life,
    })),
    players: lockedSlots.map((id) => {
      const p = players.get(id);
      if (!p) return { id, slot: -1 };
      return {
        id: p.id, slot: p.slot,
        name: p.name || `Player ${p.slot + 1}`,
        score: p.score || 0,
        turretAngle: p.turretAngle || -Math.PI / 2,
        isManual: !!p.manualShooting,
        upgrades: {
          miniLeft: !!p.upgrades?.miniLeft,
          miniRight: !!p.upgrades?.miniRight,
          shieldActive: p.upgrades?.shieldActive ?? 0,
          range: !!p.upgrades?.range,
          slowfield: !!p.upgrades?.slowfield,
        },
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
  if (phase === "gameover") resetToLobby();
  
  if (phase !== "lobby") {
    safeSend(ws, { t: "reject", reason: "Game in progress" });
    ws.close();
    return;
  }

  const slot = assignSlot();
  if (slot < 0) {
    safeSend(ws, { t: "reject", reason: "Game full (max 4)" });
    ws.close();
    return;
  }

  const id = uid();
  const player = {
    id, ws, slot,
    name: `Player ${slot + 1}`,
    aimX: 0.5,
    manualShooting: false,
    upgrades: {},
    cooldown: 0,
    score: 0,
    ready: false,
  };

  players.set(id, player);
  if (!hostId) hostId = id;

  recomputeWorld();

  safeSend(ws, {
    t: "welcome",
    id, slot,
    isHost: id === hostId,
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
    phase,
  });

  broadcast({ t: "lobby", ...lobbySnapshot() });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const p = players.get(id);
    if (!p) return;

    if (msg.t === "setName") {
      const nm = (msg.name || "").toString().slice(0, 16).trim();
      if (nm) p.name = nm;
      broadcast({ t: "lobby", ...lobbySnapshot() });
      return;
    }

    if (msg.t === "ready" && phase === "lobby") {
      p.ready = !p.ready;
      broadcast({ t: "lobby", ...lobbySnapshot() });
      return;
    }

    if (msg.t === "start") {
      if (id === hostId && phase === "lobby") {
        const snap = lobbySnapshot();
        if (snap.allReady) startGame();
      }
      return;
    }

    if (msg.t === "input" && phase === "playing") {
      const aimXNorm = Number(msg.aimXNorm);
      p.aimX = Number.isFinite(aimXNorm) ? clamp(aimXNorm, 0, 1) : 0.5;
      p.manualShooting = !!msg.shooting;
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
      
      const waiting = [];
      for (const pid of lockedSlots) {
        const po = upgradePicks.get(pid);
        if (!po || !po.pickedKey) {
          const pl = players.get(pid);
          if (pl) waiting.push(pl.name);
        }
      }
      broadcast({ t: "upgradeWaiting", waiting });
      
      maybeEndUpgradePhase();
      return;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    if (hostId === id) hostId = players.size ? Array.from(players.keys())[0] : null;
    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  });
});

setInterval(() => {
  tick();
  if (phase === "lobby") broadcast({ t: "lobby", ...lobbySnapshot() });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rogue Asteroid server: http://localhost:${PORT}`);
});
