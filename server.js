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
const SEGMENT_W = 360; // Player segment width

const BASE_HP_PER_PLAYER = 5;

const BULLET_R = 2.5;
const BULLET_SPEED = 700;
const BULLET_COOLDOWN = 0.72; 
const BULLET_DAMAGE = 1;

const ASTEROID_R_MIN = 8;
const ASTEROID_R_MAX = 16;

const WAVE_BASE_COUNT = 5;
const WAVE_COUNT_SCALE = 3;

const MAX_AIM_ANGLE = (80 * Math.PI) / 180;

// ===== Tower Definitions =====
const TOWER_TYPES = {
  0: { name: "Gatling", cost: 50,  damage: 1,   cooldown: 0.3,  rangeMult: 0.8, color: "#ffff00" },
  1: { name: "Sniper",  cost: 120, damage: 5,   cooldown: 1.5,  rangeMult: 1.5, color: "#00ff00" },
  2: { name: "Missile", cost: 250, damage: 8,   cooldown: 2.0,  rangeMult: 1.0, color: "#ff0000", explosive: 1 }
};

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

// Calculate 4 slots + Main Center
function turretPositions(slot) {
  const { x0 } = segmentBounds(slot);
  const cx = x0 + SEGMENT_W / 2;
  
  // 4 Slots: Outer Left, Inner Left, Inner Right, Outer Right
  // Spacing: 50px between inner/outer, 60px from center
  return {
    main: { x: cx, y: GROUND_Y },
    // Array index 0, 1, 2, 3
    slots: [
      { x: cx - 110, y: GROUND_Y }, // 0: Outer Left
      { x: cx - 50,  y: GROUND_Y }, // 1: Inner Left
      { x: cx + 50,  y: GROUND_Y }, // 2: Inner Right
      { x: cx + 110, y: GROUND_Y }  // 3: Outer Right
    ]
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

// ===== Roguelike Upgrades System =====
const RARITY_CONFIG = {
  common:    { weight: 60, color: "#ffffff", scale: 1.0, label: "COMMON" },
  rare:      { weight: 25, color: "#00ffff", scale: 1.5, label: "RARE" },
  epic:      { weight: 10, color: "#bf00ff", scale: 2.5, label: "EPIC" },
  legendary: { weight: 5,  color: "#ffaa00", scale: 4.0, label: "LEGENDARY" },
};

const UPGRADE_DEFS = [
  { id: "dmg", name: "Heavy Rounds", cat: "offense", icon: "💥", desc: "+{val} Damage", stat: "damageAdd", base: 1, type: "add" },
  { id: "spd", name: "Velocity", cat: "offense", icon: "💨", desc: "+{val}% Bullet Speed", stat: "bulletSpeedMult", base: 0.15, type: "mult" },
  { id: "fire", name: "Rapid Fire", cat: "offense", icon: "⚡", desc: "+{val}% Fire Rate", stat: "fireRateMult", base: 0.20, type: "mult" },
  { id: "multi", name: "Multishot", cat: "offense", icon: "⚔️", desc: "+{val} Bullets", stat: "multishot", base: 1, type: "add" },
  { id: "crit", name: "Crit Scope", cat: "offense", icon: "🎯", desc: "+{val}% Crit Chance", stat: "critChance", base: 0.10, type: "add_cap", cap: 1.0 },
  { id: "boom", name: "Explosive", cat: "offense", icon: "💣", desc: "Explosions size +{val}", stat: "explosive", base: 1, type: "add" },
  { id: "rico", name: "Ricochet", cat: "utility", icon: "🎱", desc: "Bounces {val} times", stat: "ricochet", base: 1, type: "add" },
  { id: "pierce", name: "Railgun", cat: "utility", icon: "📌", desc: "Pierces {val} enemies", stat: "pierce", base: 1, type: "add" },
  { id: "homing", name: "Magnetism", cat: "utility", icon: "🧲", desc: "Homing Strength", stat: "magnet", base: 1, type: "bool" },
  { id: "chain", name: "Tesla Coil", cat: "utility", icon: "⚡", desc: "Chain Lightning", stat: "chain", base: 1, type: "bool" },
  { id: "range", name: "Long Range", cat: "turret", icon: "📡", desc: "Shoot Neighbors", stat: "range", base: 1, type: "bool" },
  { id: "shield", name: "Shield Gen", cat: "defense", icon: "🛡️", desc: "Block {val} Hits/Wave", stat: "shield", base: 1, type: "add" },
  { id: "slow", name: "Grav Field", cat: "defense", icon: "🌀", desc: "Slow Enemies", stat: "slowfield", base: 1, type: "bool" },
];

function rollRarity() {
  const rand = Math.random() * 100;
  let accum = 0;
  if ((accum += RARITY_CONFIG.common.weight) >= rand) return "common";
  if ((accum += RARITY_CONFIG.rare.weight) >= rand) return "rare";
  if ((accum += RARITY_CONFIG.epic.weight) >= rand) return "epic";
  return "legendary";
}

function makeUpgradeOptions(player) {
  const opts = [];
  for(let i=0; i<3; i++) {
    const def = UPGRADE_DEFS[Math.floor(Math.random() * UPGRADE_DEFS.length)];
    if (opts.find(o => o.defId === def.id)) { i--; continue; } 
    if (def.type === "bool" && player.upgrades[def.stat]) { i--; continue; } 
    if (def.stat === "critChance" && (player.upgrades.critChance || 0) >= 1) { i--; continue; } 

    const rarityKey = rollRarity();
    const rarity = RARITY_CONFIG[rarityKey];

    let val = def.base;
    if (def.type === "add" || def.type === "mult" || def.type === "add_cap") {
      val = def.base * rarity.scale;
      if (def.stat === "multishot" || def.stat === "shield" || def.stat === "ricochet" || def.stat === "pierce") {
        val = Math.max(1, Math.round(val)); 
      } else if (def.type === "mult" || def.stat === "critChance") {
        val = Math.round(val * 100); 
      } else {
        val = Math.round(val * 10) / 10;
      }
    }

    let desc = def.desc.replace("{val}", val);
    
    opts.push({
      key: uid(), 
      defId: def.id,
      title: def.name,
      desc: desc,
      category: def.cat,
      icon: def.icon,
      rarity: rarityKey,
      rarityLabel: rarity.label,
      rarityColor: rarity.color,
      effect: { stat: def.stat, val: def.type === "mult" || def.stat === "critChance" ? val/100 : val, type: def.type }
    });
  }
  return opts;
}

function applyUpgrade(player, card) {
  if (!player.upgrades) player.upgrades = {};
  const u = player.upgrades;
  const eff = card.effect;

  if (eff.type === "add" || eff.type === "add_cap") {
    u[eff.stat] = (u[eff.stat] || 0) + eff.val;
  } else if (eff.type === "mult") {
    u[eff.stat] = (u[eff.stat] || 1) * (1 + eff.val);
  } else if (eff.type === "bool") {
    u[eff.stat] = true;
  }
  if (eff.stat === "shield") {
    u.shieldActive = u.shield;
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

    const vx = rand(-10 - wave * 0.5, 10 + wave * 0.5);
    const baseVy = rand(20, 36);
    const vy = baseVy * (1 + wave * 0.02);

    const type = r > 14 ? "large" : r > 10 ? "medium" : "small";
    const baseHpVal = type === "large" ? 4 : type === "medium" ? 2 : 1;
    
    const waveHpBonus = Math.floor(wave * 0.8);

    missiles.push({
      id: uid(),
      x, y, vx, vy, r, type,
      hp: baseHpVal + waveHpBonus,
      maxHp: baseHpVal + waveHpBonus,
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
      // 4 Slots: [0, 1, 2, 3]
      p.towers = [null, null, null, null];
      p.gold = 0;
      p.cooldown = 0;
      p.targetX = null;
      p.targetY = null;
      p.manualShooting = false;
      p.turretAngle = -Math.PI / 2;
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
  try {
    console.log("Resetting to lobby...");
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
      p.towers = [null, null, null, null];
      p.gold = 0;
    });

    hostId = players.size ? Array.from(players.keys())[0] : null;
    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  } catch (err) {
    console.error("Error in resetToLobby:", err);
  }
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
function fireBullet(owner, originX, originY, targetX, targetY, angleOffset = 0, overrideProps = null) {
  let dmg, speed, isCrit, explosive;
  
  if (overrideProps) {
    dmg = overrideProps.damage + (owner.upgrades?.damageAdd ?? 0);
    speed = BULLET_SPEED; 
    isCrit = Math.random() < (owner.upgrades?.critChance ?? 0);
    explosive = overrideProps.explosive || (owner.upgrades?.explosive ?? 0);
  } else {
    dmg = BULLET_DAMAGE + (owner.upgrades?.damageAdd ?? 0);
    speed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);
    isCrit = Math.random() < (owner.upgrades?.critChance ?? 0);
    explosive = owner.upgrades?.explosive ?? 0;
  }
  
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
    explosive: explosive,
    magnet: !!owner.upgrades?.magnet,
    chain: !!owner.upgrades?.chain,
    ricochet: owner.upgrades?.ricochet || 0,
    pierce: owner.upgrades?.pierce || 0,
    hitList: [], 
  });
}

function fireWithMultishot(owner, originX, originY, targetX, targetY) {
  const shots = owner.upgrades?.multishot ?? 1;
  const spread = 0.10; 
  fireBullet(owner, originX, originY, targetX, targetY, 0);
  for (let i = 1; i < shots; i++) {
    const side = (i % 2 === 1) ? -1 : 1;
    const layer = Math.ceil(i / 2);
    const offset = side * layer * spread;
    fireBullet(owner, originX, originY, targetX, targetY, offset);
  }
}

function findBestTarget(x0, x1, turretX, turretY, rangeMult = 1.0) {
  let best = null;
  let bestScore = -Infinity;
  const extend = (rangeMult > 1.2); 
  const searchX0 = extend ? Math.max(0, x0 - SEGMENT_W) : x0;
  const searchX1 = extend ? Math.min(worldW, x1 + SEGMENT_W) : x1;
  
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
  damageNumbers.push({ x, y, amount, isCrit, life: 1.0, vy: -60 });
}

function tick() {
  if (phase !== "playing") return;

  particles = particles.filter(p => {
    p.x += p.vx * DT; p.y += p.vy * DT; p.life -= DT; p.vx *= 0.95; p.vy *= 0.95; return p.life > 0;
  });
  damageNumbers = damageNumbers.filter(d => {
    d.y += d.vy * DT; d.life -= DT * 1.5; return d.life > 0;
  });

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p) continue;

    p.cooldown = Math.max(0, (p.cooldown ?? 0) - DT);
    
    // Tower Cooldowns (Loop through array of 4)
    if (p.towers) {
      p.towers.forEach(t => {
        if (t) t.cd = Math.max(0, (t.cd || 0) - DT);
      });
    }

    const slot = p.slot;
    const { x0, x1 } = segmentBounds(slot);
    const pos = turretPositions(slot);
    const canExtend = !!p.upgrades?.range;
    const baseCooldown = BULLET_COOLDOWN / (p.upgrades?.fireRateMult ?? 1);

    // Main Gun
    let targetX, targetY, clamped;
    if (p.manualShooting && p.targetX != null && p.targetY != null) {
      clamped = clampAimAngle(pos.main.x, pos.main.y, p.targetX, p.targetY);
      targetX = clamped.x; targetY = clamped.y;
    } else {
      const target = findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend ? 1.5 : 1.0);
      if (target) {
        clamped = clampAimAngle(pos.main.x, pos.main.y, target.x, target.y);
      } else {
        clamped = clampAimAngle(pos.main.x, pos.main.y, pos.main.x, 50);
      }
      targetX = clamped.x; targetY = clamped.y;
    }
    p.turretAngle = clamped.angle;
    const shouldFire = p.manualShooting || findBestTarget(x0, x1, pos.main.x, pos.main.y, canExtend ? 1.5 : 1.0);
    if (shouldFire && p.cooldown <= 0) {
      p.cooldown = baseCooldown;
      fireWithMultishot(p, pos.main.x, pos.main.y, clamped.x, clamped.y);
    }

    // Mini Towers Logic (4 Slots)
    if (p.towers) {
      p.towers.forEach((tower, idx) => {
        if (!tower) return;
        if (tower.cd > 0) return;
        
        // Get physical position of this slot
        const towerPos = pos.slots[idx];
        if (!towerPos) return;

        const stats = TOWER_TYPES[tower.type];
        const rangeMult = (stats.rangeMult || 1.0) * (canExtend ? 1.5 : 1.0);
        
        const target = findBestTarget(x0, x1, towerPos.x, towerPos.y, rangeMult);
        if (target) {
          tower.cd = stats.cooldown / (p.upgrades?.fireRateMult ?? 1);
          const aim = clampAimAngle(towerPos.x, towerPos.y, target.x, target.y);
          fireBullet(p, towerPos.x, towerPos.y, aim.x, aim.y, 0, stats);
        }
      });
    }
  }

  // Missiles
  for (const m of missiles) {
    let speedMult = 1;
    for (const id of lockedSlots) {
      const p = players.get(id);
      if (!p?.upgrades?.slowfield) continue;
      const { x0, x1 } = segmentBounds(p.slot);
      if (m.x >= x0 && m.x <= x1) { speedMult = 0.75; break; }
    }

    m.x += m.vx * DT * speedMult; m.y += m.vy * DT * speedMult; m.rotation += m.rotSpeed * DT;
    if (m.x - m.r < 0) { m.x = m.r; m.vx = Math.abs(m.vx); }
    if (m.x + m.r > worldW) { m.x = worldW - m.r; m.vx = -Math.abs(m.vx); }

    if (m.y + m.r >= GROUND_Y) {
      let blocked = false;
      for (const id of lockedSlots) {
        const p = players.get(id);
        if (!p?.upgrades?.shieldActive) continue;
        const { x0, x1 } = segmentBounds(p.slot);
        if (m.x >= x0 && m.x <= x1 && p.upgrades.shieldActive > 0) {
          p.upgrades.shieldActive--; blocked = true; createExplosion(m.x, GROUND_Y - 5, 30, "#0ff"); break;
        }
      }
      m.dead = true;
      if (!blocked) { baseHp -= 1; createExplosion(m.x, GROUND_Y - 5, 40, "#f44"); }
    }
  }

  // Bullets
  for (const b of bullets) {
    if (b.magnet) {
      let nearest = null; let nearestDist = 150;
      for (const m of missiles) {
        if (m.dead) continue; const d = Math.hypot(m.x - b.x, m.y - b.y);
        if (d < nearestDist) { nearestDist = d; nearest = m; }
      }
      if (nearest) {
        const dx = nearest.x - b.x; const dy = nearest.y - b.y; const len = Math.hypot(dx, dy) || 1;
        b.vx += (dx / len) * 500 * DT; b.vy += (dy / len) * 500 * DT;
        const speed = Math.hypot(b.vx, b.vy); const targetSpeed = BULLET_SPEED * 1.1;
        b.vx = (b.vx / speed) * targetSpeed; b.vy = (b.vy / speed) * targetSpeed;
      }
    }
    b.x += b.vx * DT; b.y += b.vy * DT;
    
    let didRicochet = false;
    if (b.x < 0) { if (b.ricochet > 0) { b.x = 0; b.vx = -b.vx; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
    else if (b.x > worldW) { if (b.ricochet > 0) { b.x = worldW; b.vx = -b.vx; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
    if (b.y < -50) { if (b.ricochet > 0 && b.y < -50) { b.y = -50; b.vy = -b.vy; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
    if (b.y > GROUND_Y) { if (b.ricochet > 0) { b.y = GROUND_Y; b.vy = -b.vy; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
    if (didRicochet) b.hitList = [];
  }

  // Collisions
  for (const b of bullets) {
    if (b.dead) continue;
    for (const m of missiles) {
      if (m.dead) continue; if (b.hitList && b.hitList.includes(m.id)) continue;
      const dx = m.x - b.x; const dy = m.y - b.y; const rr = m.r + b.r;
      if (dx * dx + dy * dy <= rr * rr) {
        m.hp -= b.dmg;
        if (!b.hitList) b.hitList = []; b.hitList.push(m.id);
        if (b.pierce > 0) { b.pierce--; } else { b.dead = true; }
        addDamageNumber(m.x, m.y - m.r, b.dmg, b.isCrit);
        const owner = players.get(b.ownerId);
        if (m.hp <= 0) {
          m.dead = true; createExplosion(m.x, m.y, 25, "#fa0");
          if (owner) {
            owner.score = (owner.score || 0) + 50;
            const goldReward = m.type === "large" ? 3 : m.type === "medium" ? 2 : 1;
            owner.gold = (owner.gold || 0) + goldReward;
          }
        } else { if (owner) owner.score = (owner.score || 0) + b.dmg * 10; }

        if (b.explosive > 0) {
          createExplosion(b.x, b.y, 35, "#fa0");
          for (const m2 of missiles) {
            if (m2.dead || m2 === m) continue; const d = Math.hypot(m2.x - b.x, m2.y - b.y);
            if (d < 35 + m2.r) { m2.hp -= 1; if (m2.hp <= 0) m2.dead = true; }
          }
        }
        if (b.chain && m.hp <= 0) {
          for (const m2 of missiles) {
            if (m2.dead || m2 === m) continue; const d = Math.hypot(m2.x - m.x, m2.y - m.y);
            if (d < 70) {
              m2.hp -= 1; addDamageNumber(m2.x, m2.y - m2.r, 1, false); if (m2.hp <= 0) m2.dead = true;
              particles.push({ x: m.x, y: m.y, vx: (m2.x - m.x)*3, vy: (m2.y - m.y)*3, life: 0.12, maxLife: 0.12, color: "#ff0", size: 2 });
              break;
            }
          }
        }
        createExplosion(b.x, b.y, 15, b.isCrit ? "#ff0" : "#0ff"); if (b.dead) break;
      }
    }
  }

  missiles = missiles.filter((m) => !m.dead);
  bullets = bullets.filter((b) => !b.dead);

  if (baseHp <= 0) { endGame(); return; }
  if (missiles.length === 0) { beginUpgradePhase(); return; }

  broadcast({
    t: "state",
    ts: Date.now(),
    phase,
    wave,
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
    baseHp,
    maxBaseHp,
    missiles: missiles.map((m) => ({
      id: m.id, x: m.x, y: m.y, r: m.r, hp: m.hp, maxHp: m.maxHp, type: m.type, rotation: m.rotation, vertices: m.vertices,
    })),
    bullets: bullets.map((b) => ({
      id: b.id, x: b.x, y: b.y, r: b.r, vx: b.vx, vy: b.vy, slot: b.ownerSlot, isCrit: b.isCrit,
    })),
    particles: particles.map((p) => ({
      x: p.x, y: p.y, life: p.life, maxLife: p.maxLife, color: p.color, size: p.size,
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
        gold: p.gold || 0,
        turretAngle: p.turretAngle || -Math.PI / 2,
        isManual: !!p.manualShooting,
        towers: p.towers, // Array of 4
        upgrades: {
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

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => { clearInterval(interval); });

wss.on("connection", (ws) => {
  if (phase === "gameover") resetToLobby();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  if (phase !== "lobby") { safeSend(ws, { t: "reject", reason: "Game in progress" }); ws.close(); return; }

  const slot = assignSlot();
  if (slot < 0) { safeSend(ws, { t: "reject", reason: "Game full (max 4)" }); ws.close(); return; }

  const id = uid();
  const player = {
    id, ws, slot,
    name: `Player ${slot + 1}`,
    targetX: 0, targetY: 0,
    manualShooting: false,
    upgrades: {},
    towers: [null, null, null, null], // 4 slots
    gold: 0, cooldown: 0, score: 0, ready: false,
  };

  players.set(id, player);
  if (!hostId) hostId = id;

  recomputeWorld();

  safeSend(ws, { t: "welcome", id, slot, isHost: id === hostId, world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, phase });

  broadcast({ t: "lobby", ...lobbySnapshot() });

  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = players.get(id); if (!p) return;

    if (msg.t === "setName") { p.name = (msg.name || "").toString().slice(0, 16).trim() || p.name; broadcast({ t: "lobby", ...lobbySnapshot() }); return; }
    if (msg.t === "ready" && phase === "lobby") { p.ready = !p.ready; broadcast({ t: "lobby", ...lobbySnapshot() }); return; }
    if (msg.t === "start") { if (id === hostId && phase === "lobby") { const snap = lobbySnapshot(); if (snap.allReady) startGame(); } return; }
    if (msg.t === "input" && phase === "playing") { p.targetX = Number(msg.x)||0; p.targetY = Number(msg.y)||0; p.manualShooting = !!msg.shooting; return; }
    
    if (msg.t === "pickUpgrade" && phase === "upgrades") {
      const pickKey = (msg.key || "").toString();
      const pickObj = upgradePicks.get(id);
      if (!pickObj || pickObj.pickedKey) return;
      const opt = pickObj.options.find((o) => o.key === pickKey);
      if (!opt) return;
      pickObj.pickedKey = pickKey;
      applyUpgrade(p, opt); 
      safeSend(p.ws, { t: "picked", key: pickKey });
      const waiting = [];
      for (const pid of lockedSlots) {
        const po = upgradePicks.get(pid);
        if (!po || !po.pickedKey) { const pl = players.get(pid); if (pl) waiting.push(pl.name); }
      }
      broadcast({ t: "upgradeWaiting", waiting });
      maybeEndUpgradePhase();
      return;
    }

    if (msg.t === "buyTower" && phase === "playing") {
      const { slotIndex, type } = msg; // expect 0, 1, 2, 3
      if (!TOWER_TYPES[type]) return;
      if (slotIndex < 0 || slotIndex > 3) return;
      if (p.towers[slotIndex]) return; // Occupied
      
      const cost = TOWER_TYPES[type].cost;
      if (p.gold >= cost) {
        p.gold -= cost;
        p.towers[slotIndex] = { type, cd: 0 };
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    if (hostId === id) hostId = players.size ? Array.from(players.keys())[0] : null;
    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  });
});

setInterval(() => { tick(); }, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Rogue Asteroid server: http://localhost:${PORT}`); });
