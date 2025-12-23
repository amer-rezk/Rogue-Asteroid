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
const SEGMENT_W = 360;

const BASE_HP_PER_PLAYER = 5;

const BULLET_R = 4;
const BULLET_SPEED = 650;
const BULLET_COOLDOWN = 0.20;
const BULLET_DAMAGE = 1;

const MISSILE_R_MIN = 12;
const MISSILE_R_MAX = 22;

const WAVE_BASE_COUNT = 6;
const WAVE_COUNT_SCALE = 3;

// Shooting angle limits (160 degrees = ±80 from vertical)
const MAX_AIM_ANGLE = (80 * Math.PI) / 180; // radians from vertical

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
let wave = 0;

let missiles = [];
let bullets = [];
let particles = []; // For explosion effects

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

// ===== Expanded Roguelike Upgrade System =====
const UPGRADE_POOL = [
  // Offensive upgrades
  { key: "firerate", title: "Rapid Fire", desc: "Fire 20% faster", category: "offensive", icon: "⚡" },
  { key: "bulletspeed", title: "Velocity Rounds", desc: "Bullets travel 15% faster", category: "offensive", icon: "💨" },
  { key: "damage", title: "Piercing Shots", desc: "Bullets deal +1 damage", category: "offensive", icon: "💥" },
  { key: "multishot", title: "Split Shot", desc: "Fire 2 bullets in a spread", category: "offensive", icon: "🔱" },
  { key: "explosive", title: "Explosive Rounds", desc: "Bullets explode on impact (small AoE)", category: "offensive", icon: "💣" },
  { key: "critchance", title: "Critical Strike", desc: "15% chance to deal 3x damage", category: "offensive", icon: "🎯" },
  
  // Turret upgrades
  { key: "mini_left", title: "Left Drone", desc: "Deploy auto-turret on left", category: "turret", icon: "🤖" },
  { key: "mini_right", title: "Right Drone", desc: "Deploy auto-turret on right", category: "turret", icon: "🤖" },
  { key: "range", title: "Extended Range", desc: "Can shoot into neighboring zones", category: "turret", icon: "📡" },
  
  // Defensive upgrades
  { key: "shield", title: "Energy Shield", desc: "Block 1 asteroid per wave", category: "defensive", icon: "🛡️" },
  { key: "slowfield", title: "Gravity Well", desc: "Asteroids in your zone move 20% slower", category: "defensive", icon: "🌀" },
  
  // Utility upgrades
  { key: "magnet", title: "Bullet Magnet", desc: "Bullets slightly curve toward asteroids", category: "utility", icon: "🧲" },
  { key: "chain", title: "Chain Lightning", desc: "Hits can arc to nearby asteroids", category: "utility", icon: "⚡" },
];

function makeUpgradeOptions(player) {
  // Filter out upgrades player already has (for one-time upgrades)
  const owned = player.upgrades || {};
  const pool = UPGRADE_POOL.filter(u => {
    if (u.key === "mini_left" && owned.miniLeft) return false;
    if (u.key === "mini_right" && owned.miniRight) return false;
    if (u.key === "shield" && owned.shield) return false;
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
    case "firerate":
      u.fireRateMult = (u.fireRateMult ?? 1) * 1.20;
      break;
    case "bulletspeed":
      u.bulletSpeedMult = (u.bulletSpeedMult ?? 1) * 1.15;
      break;
    case "damage":
      u.damageAdd = (u.damageAdd ?? 0) + 1;
      break;
    case "multishot":
      u.multishot = (u.multishot ?? 1) + 1;
      break;
    case "explosive":
      u.explosive = (u.explosive ?? 0) + 1;
      break;
    case "critchance":
      u.critChance = Math.min(0.6, (u.critChance ?? 0) + 0.15);
      break;
    case "mini_left":
      u.miniLeft = true;
      break;
    case "mini_right":
      u.miniRight = true;
      break;
    case "range":
      u.range = true;
      break;
    case "shield":
      u.shield = (u.shield ?? 0) + 1;
      u.shieldActive = (u.shieldActive ?? 0) + 1;
      break;
    case "slowfield":
      u.slowfield = true;
      break;
    case "magnet":
      u.magnet = true;
      break;
    case "chain":
      u.chain = true;
      break;
  }
}

// ===== Spawning =====
function spawnWave() {
  missiles = [];
  bullets = [];
  particles = [];

  // Reset shields for the wave
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p && p.upgrades?.shield) {
      p.upgrades.shieldActive = p.upgrades.shield;
    }
  }

  const count = WAVE_BASE_COUNT + wave * WAVE_COUNT_SCALE;
  for (let i = 0; i < count; i++) {
    const r = rand(MISSILE_R_MIN, MISSILE_R_MAX);
    const x = rand(r, worldW - r);
    const y = rand(-WORLD_H * 0.9, -r);

    const vx = rand(-25 - wave * 2, 25 + wave * 2);
    const vy = rand(60 + wave * 6, 100 + wave * 8);

    // Asteroid types based on size
    const type = r > 18 ? "large" : r > 14 ? "medium" : "small";
    const baseHp = type === "large" ? 4 : type === "medium" ? 2 : 1;

    missiles.push({
      id: uid(),
      x,
      y,
      vx,
      vy,
      r,
      type,
      hp: baseHp + Math.floor(wave / 2),
      maxHp: baseHp + Math.floor(wave / 2),
      rotation: rand(0, Math.PI * 2),
      rotSpeed: rand(-2, 2),
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
  upgradePicks = new Map();
  wave = 0;

  const arr = Array.from(players.values()).sort((a, b) => a.slot - b.slot);
  arr.forEach((p, i) => (p.slot = i));

  hostId = players.size ? Array.from(players.keys())[0] : null;
  recomputeWorld();
  broadcast({ t: "lobby", ...lobbySnapshot() });
}

function endGame() {
  phase = "gameover";
  
  // Calculate scores
  const scores = lockedSlots.map(id => {
    const p = players.get(id);
    return { id, name: p?.name || "???", score: p?.score || 0 };
  }).sort((a, b) => b.score - a.score);
  
  broadcast({ t: "gameOver", wave, scores });

  setTimeout(() => {
    if (phase === "gameover") resetToLobby();
  }, 5000);
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
  
  // Apply angle offset for multishot
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
    x: originX,
    y: originY - 8,
    vx,
    vy,
    r: BULLET_R,
    dmg: finalDmg,
    isCrit,
    explosive: owner.upgrades?.explosive ?? 0,
    magnet: !!owner.upgrades?.magnet,
    chain: !!owner.upgrades?.chain,
    color: isCrit ? "#ff0" : "#0ff",
  });
}

function fireWithMultishot(owner, originX, originY, targetX, targetY) {
  const shots = owner.upgrades?.multishot ?? 1;
  if (shots === 1) {
    fireBullet(owner, originX, originY, targetX, targetY);
  } else {
    const spread = 0.15; // radians between shots
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
    if (m.y < 0) continue; // Skip missiles not yet on screen
    
    // Prioritize by: closeness to ground (danger), then distance to turret
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
  
  // Vertical is -PI/2, so we measure from that
  const fromVertical = angle - (-Math.PI / 2);
  const clampedFromVertical = clamp(fromVertical, -MAX_AIM_ANGLE, MAX_AIM_ANGLE);
  const clampedAngle = -Math.PI / 2 + clampedFromVertical;
  
  // Return clamped target position
  const dist = Math.hypot(dx, dy);
  return {
    x: turretX + Math.cos(clampedAngle) * dist,
    y: turretY + Math.sin(clampedAngle) * dist,
    angle: clampedAngle
  };
}

function createExplosion(x, y, radius) {
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * 100,
      vy: Math.sin(angle) * 100,
      life: 0.5,
      color: "#f80",
    });
  }
  
  // Damage nearby missiles
  for (const m of missiles) {
    if (m.dead) continue;
    const dist = Math.hypot(m.x - x, m.y - y);
    if (dist < radius + m.r) {
      m.hp -= 1;
      if (m.hp <= 0) m.dead = true;
    }
  }
}

function tick() {
  if (phase !== "playing") return;

  // Update particles
  particles = particles.filter(p => {
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    p.life -= DT;
    return p.life > 0;
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

    // Determine target - manual aim or auto-target
    let targetX, targetY;
    
    if (p.manualShooting) {
      // Manual aiming - use player's aim position
      targetX = x0 + clamp(p.aimX ?? 0.5, 0, 1) * SEGMENT_W;
      targetY = 50; // Aim toward top
    } else {
      // Auto-targeting - find best target
      const target = findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
      if (target) {
        targetX = target.x;
        targetY = target.y;
      } else {
        targetX = pos.main.x;
        targetY = 50;
      }
    }

    // Clamp aim angle to 160 degrees
    const clamped = clampAimAngle(pos.main.x, pos.main.y, targetX, targetY);
    p.turretAngle = clamped.angle;

    // Fire main turret (auto-fire always, or manual when clicking)
    const shouldFire = p.manualShooting || findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
    
    if (shouldFire && p.cooldown <= 0) {
      p.cooldown = baseCooldown;
      fireWithMultishot(p, pos.main.x, pos.main.y, clamped.x, clamped.y);
    }

    // Mini turrets auto-fire at nearest target in segment
    const autoTarget = findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend);
    if (autoTarget) {
      if (p.upgrades?.miniLeft && p.miniCooldownL <= 0) {
        p.miniCooldownL = baseCooldown * 0.9;
        const miniClamped = clampAimAngle(pos.miniL1.x, pos.miniL1.y, autoTarget.x, autoTarget.y);
        fireBullet(p, pos.miniL1.x, pos.miniL1.y, miniClamped.x, miniClamped.y);
      }
      if (p.upgrades?.miniRight && p.miniCooldownR <= 0) {
        p.miniCooldownR = baseCooldown * 0.9;
        const miniClamped = clampAimAngle(pos.miniR1.x, pos.miniR1.y, autoTarget.x, autoTarget.y);
        fireBullet(p, pos.miniR1.x, pos.miniR1.y, miniClamped.x, miniClamped.y);
      }
    }
  }

  // Missiles
  for (const m of missiles) {
    // Check for slow field effect
    let speedMult = 1;
    for (const id of lockedSlots) {
      const p = players.get(id);
      if (!p?.upgrades?.slowfield) continue;
      const { x0, x1 } = segmentBounds(p.slot);
      if (m.x >= x0 && m.x <= x1) {
        speedMult = 0.8;
        break;
      }
    }

    m.x += m.vx * DT * speedMult;
    m.y += m.vy * DT * speedMult;
    m.rotation += m.rotSpeed * DT;

    if (m.x - m.r < 0) {
      m.x = m.r;
      m.vx = Math.abs(m.vx);
    }
    if (m.x + m.r > worldW) {
      m.x = worldW - m.r;
      m.vx = -Math.abs(m.vx);
    }

    if (m.y + m.r >= GROUND_Y) {
      // Check for shield
      let blocked = false;
      for (const id of lockedSlots) {
        const p = players.get(id);
        if (!p?.upgrades?.shieldActive) continue;
        const { x0, x1 } = segmentBounds(p.slot);
        if (m.x >= x0 && m.x <= x1 && p.upgrades.shieldActive > 0) {
          p.upgrades.shieldActive--;
          blocked = true;
          // Create shield effect
          for (let i = 0; i < 12; i++) {
            particles.push({
              x: m.x,
              y: GROUND_Y,
              vx: rand(-80, 80),
              vy: rand(-150, -50),
              life: 0.6,
              color: "#0ff",
            });
          }
          break;
        }
      }
      
      m.dead = true;
      if (!blocked) {
        baseHp -= 1;
        // Impact particles
        for (let i = 0; i < 6; i++) {
          particles.push({
            x: m.x,
            y: GROUND_Y,
            vx: rand(-60, 60),
            vy: rand(-100, -30),
            life: 0.4,
            color: "#f55",
          });
        }
      }
    }
  }

  // Bullets with magnet effect
  for (const b of bullets) {
    if (b.magnet) {
      // Find nearest missile and curve toward it slightly
      let nearest = null;
      let nearestDist = 200;
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
        b.vx += (dx / len) * 400 * DT;
        b.vy += (dy / len) * 400 * DT;
        // Renormalize speed
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
        
        // Score for owner
        const owner = players.get(b.ownerId);
        if (owner) {
          owner.score = (owner.score || 0) + b.dmg * 10;
          if (m.hp <= 0) owner.score += 50; // Kill bonus
        }
        
        // Explosion effect
        if (b.explosive > 0) {
          createExplosion(b.x, b.y, 40 + b.explosive * 15);
        }
        
        // Chain lightning
        if (b.chain && m.hp <= 0) {
          for (const m2 of missiles) {
            if (m2.dead || m2 === m) continue;
            const d = Math.hypot(m2.x - m.x, m2.y - m.y);
            if (d < 80) {
              m2.hp -= 1;
              if (m2.hp <= 0) m2.dead = true;
              // Chain visual
              particles.push({
                x: m.x,
                y: m.y,
                vx: (m2.x - m.x) * 2,
                vy: (m2.y - m.y) * 2,
                life: 0.15,
                color: "#ff0",
              });
              break; // Only chain once
            }
          }
        }
        
        // Hit particles
        for (let i = 0; i < 4; i++) {
          particles.push({
            x: b.x,
            y: b.y,
            vx: rand(-50, 50),
            vy: rand(-50, 50),
            life: 0.3,
            color: b.isCrit ? "#ff0" : "#0ff",
          });
        }
        
        if (m.hp <= 0) {
          m.dead = true;
          // Death explosion
          for (let i = 0; i < 8; i++) {
            particles.push({
              x: m.x,
              y: m.y,
              vx: rand(-80, 80),
              vy: rand(-80, 80),
              life: 0.5,
              color: "#fa0",
            });
          }
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
    maxBaseHp: BASE_HP_PER_PLAYER * lockedSlots.length,
    missiles: missiles.map((m) => ({
      id: m.id,
      x: m.x,
      y: m.y,
      r: m.r,
      hp: m.hp,
      maxHp: m.maxHp,
      type: m.type,
      rotation: m.rotation,
    })),
    bullets: bullets.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      r: b.r,
      color: b.color,
      isCrit: b.isCrit,
    })),
    particles: particles.map((p) => ({
      x: p.x,
      y: p.y,
      life: p.life,
      color: p.color,
    })),
    players: lockedSlots.map((id) => {
      const p = players.get(id);
      if (!p) return { id, slot: -1 };
      return {
        id: p.id,
        slot: p.slot,
        name: p.name || `P${p.slot + 1}`,
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
  if (phase === "gameover") {
    resetToLobby();
  }
  if (phase !== "lobby") {
    safeSend(ws, { t: "reject", reason: "Game already running." });
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
    manualShooting: false,
    upgrades: {},
    cooldown: 0,
    score: 0,
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
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}/ws`);
});
