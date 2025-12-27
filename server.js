// server.js - Rogue Asteroid PvP
// Competitive asteroid defense with attack purchasing

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

// ===== Game constants =====
const MAX_PLAYERS = 4;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

const WORLD_H = 600;
const GROUND_Y = 560;
const SEGMENT_W = 360;

const BASE_HP_PER_PLAYER = 8; // Increased for PvP

const BULLET_R = 2.5;
const BULLET_SPEED = 175; // Slowed to 25% of original (was 700)
const BULLET_COOLDOWN = 0.72;
const BULLET_DAMAGE = 1.25; // Base damage increased by +1
const BULLET_LIFESPAN = 6.0; // Increased for slower homing bullets

const ASTEROID_R_MIN = 8;
const ASTEROID_R_MAX = 16;

const WAVE_BASE_COUNT = 3; // Reduced base count since players send attacks
const WAVE_COUNT_SCALE = 2;

const MAX_AIM_ANGLE = (80 * Math.PI) / 180;

// ===== Tower Definitions =====
const TOWER_TYPES = {
  0: { name: "Gatling", cost: 50, damage: 1, cooldown: 0.25, rangeMult: 0.8, color: "#ffff00", upgradeCost: 40, bulletType: "gatling" },
  1: { name: "Sniper", cost: 120, damage: 5, cooldown: 1.2, rangeMult: 1.5, color: "#00ff00", upgradeCost: 80, bulletType: "sniper" },
  2: { name: "Missile", cost: 250, damage: 8, cooldown: 2.0, rangeMult: 1.0, color: "#ff0000", explosive: 1, upgradeCost: 150, bulletType: "missile" }
};
const MAX_TOWER_LEVEL = 5;

// ===== PvP Attack Units - Purchasable asteroids to send at opponents =====
const ATTACK_TYPES = {
  swarm: { 
    name: "Swarm", 
    cost: 15, 
    count: 4, // Increased from 3
    baseHp: 1,
    hpScale: 1.2, // Scales 20% faster than wave
    size: "small", 
    speed: 1.3,
    desc: "4 fast weak asteroids",
    color: "#ffcc00",
    icon: "🐝"
  },
  bruiser: { 
    name: "Bruiser", 
    cost: 45, 
    count: 1, 
    baseHp: 5,
    hpScale: 1.5, // Scales 50% faster than wave - very tanky
    size: "large", 
    speed: 0.6,
    desc: "Very tanky asteroid",
    color: "#ff4444",
    icon: "🪨"
  },
  bomber: { 
    name: "Bomber", 
    cost: 55, 
    count: 1, 
    baseHp: 3,
    hpScale: 1.0, // Normal scaling
    size: "medium", 
    speed: 1.0,
    explosive: true,
    explosionDamage: 2, // Damage dealt when exploding
    desc: "Explodes dealing damage",
    color: "#ff00ff",
    icon: "💣"
  },
  splitter: { 
    name: "Splitter", 
    cost: 50, 
    count: 1, 
    baseHp: 4,
    hpScale: 1.3, // Scales 30% faster
    size: "large", 
    speed: 0.75,
    splits: 4, // Now splits into 4
    desc: "Splits into 4 on death",
    color: "#00ffff",
    icon: "💎"
  },
  ghost: {
    name: "Ghost",
    cost: 40,
    count: 2,
    baseHp: 2,
    hpScale: 1.2,
    size: "medium",
    speed: 1.1,
    phasing: true,
    desc: "Phases through hits",
    color: "#8800ff",
    icon: "👻"
  }
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
let wave = 0;

let missiles = [];
let bullets = [];
let particles = [];
let damageNumbers = [];

let upgradePicks = new Map();
let attackQueue = new Map(); // Queued attacks for next wave: Map<targetSlot, attacks[]>
let upgradePhaseStart = 0; // Timestamp when upgrade phase started
const UPGRADE_TIMEOUT = 10; // Seconds to choose upgrade
let waveClearedTime = 0; // Timestamp when last asteroid was destroyed
const WAVE_CLEAR_DELAY = 1000; // 1 second delay before upgrade phase

// Staggered spawn system
let spawnQueue = []; // Asteroids waiting to spawn
let spawnTimer = 0; // Time until next spawn
const SPAWN_INTERVAL = 0.3; // Seconds between spawns (300ms)

// Leaderboard - persists to file (survives server restarts)
let leaderboard = []; // { name, score, kills, wave, date }
const MAX_LEADERBOARD_ENTRIES = 10;
const LEADERBOARD_FILE = path.join(__dirname, "leaderboard.json");

// Load leaderboard from file
function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const data = fs.readFileSync(LEADERBOARD_FILE, "utf8");
      leaderboard = JSON.parse(data);
      console.log(`Loaded ${leaderboard.length} leaderboard entries`);
    }
  } catch (err) {
    console.error("Failed to load leaderboard:", err);
    leaderboard = [];
  }
}

// Save leaderboard to file
function saveLeaderboard() {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
  } catch (err) {
    console.error("Failed to save leaderboard:", err);
  }
}

// Load leaderboard on startup
loadLeaderboard();

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
  return {
    main: { x: cx, y: GROUND_Y },
    slots: [
      { x: cx - 110, y: GROUND_Y },
      { x: cx - 50, y: GROUND_Y },
      { x: cx + 50, y: GROUND_Y },
      { x: cx + 110, y: GROUND_Y }
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
  return { players: list, hostId, allReady, leaderboard };
}

// ===== Roguelike Upgrades System =====
const RARITY_CONFIG = {
  common: { weight: 75, color: "#ffffff", scale: 1.0, label: "COMMON" },
  rare: { weight: 17, color: "#00ffff", scale: 1.5, label: "RARE" },
  epic: { weight: 6, color: "#bf00ff", scale: 2.5, label: "EPIC" },
  legendary: { weight: 2, color: "#ffaa00", scale: 4.0, label: "LEGENDARY" },
};

const UPGRADE_DEFS = [
  { id: "dmg", name: "Heavy Rounds", cat: "offense", icon: "💥", desc: "+{val} Damage", stat: "damageAdd", base: 0.5, type: "add" },
  { id: "spd", name: "Velocity", cat: "offense", icon: "💨", desc: "+{val}% Bullet Speed", stat: "bulletSpeedMult", base: 0.08, type: "mult" },
  { id: "fire", name: "Rapid Fire", cat: "offense", icon: "⚡", desc: "+{val}% Fire Rate", stat: "fireRateMult", base: 0.05, type: "mult" },
  { id: "multi", name: "Multishot", cat: "offense", icon: "⚔️", desc: "+{val} Bullets (-{penalty}% dmg)", stat: "multishot", base: 1, type: "multishot" },
  { id: "crit", name: "Crit Scope", cat: "offense", icon: "🎯", desc: "+{val}% Crit Chance", stat: "critChance", base: 0.05, type: "add_cap", cap: 1.0 },
  { id: "boom", name: "Explosive", cat: "offense", icon: "💣", desc: "Explosions size +{val}", stat: "explosive", base: 1, type: "add" },
  { id: "life", name: "Stabilizer", cat: "utility", icon: "⏱️", desc: "+{val}s Bullet Life", stat: "lifespanAdd", base: 0.75, type: "add" },
  { id: "rico", name: "Ricochet", cat: "utility", icon: "🎱", desc: "Bounces {val} times", stat: "ricochet", base: 1, type: "add" },
  { id: "pierce", name: "Railgun", cat: "utility", icon: "📌", desc: "Pierces {val} enemies", stat: "pierce", base: 1, type: "add" },
  { id: "chain", name: "Tesla Coil", cat: "utility", icon: "⚡", desc: "Chain Lightning", stat: "chain", base: 1, type: "bool" },
  { id: "shield", name: "Shield Gen", cat: "defense", icon: "🛡️", desc: "Block {val} Hits/Wave", stat: "shield", base: 1, type: "add" },
  { id: "slow", name: "Grav Field", cat: "defense", icon: "🌀", desc: "Slow Enemies", stat: "slowfield", base: 1, type: "bool" },
  // PvP specific upgrades
  { id: "income", name: "War Profiteer", cat: "economy", icon: "💰", desc: "+{val}% Gold Gain", stat: "goldMult", base: 0.12, type: "mult" },
  { id: "discount", name: "Arms Dealer", cat: "economy", icon: "🏷️", desc: "-{val}% Attack Cost", stat: "attackDiscount", base: 0.08, type: "add_cap", cap: 0.5 },
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
  for (let i = 0; i < 3; i++) {
    const def = UPGRADE_DEFS[Math.floor(Math.random() * UPGRADE_DEFS.length)];
    if (opts.find(o => o.defId === def.id)) { i--; continue; }
    if (def.type === "bool" && player.upgrades[def.stat]) { i--; continue; }
    if (def.stat === "critChance" && (player.upgrades.critChance || 0) >= 1) { i--; continue; }
    if (def.stat === "attackDiscount" && (player.upgrades.attackDiscount || 0) >= 0.5) { i--; continue; }

    const rarityKey = rollRarity();
    const rarity = RARITY_CONFIG[rarityKey];

    let val = def.base;
    let desc = def.desc;
    let effect = { stat: def.stat, type: def.type };
    
    if (def.type === "multishot") {
      // Multishot scales with rarity: 1/1/2/3
      val = rarityKey === "legendary" ? 3 : rarityKey === "epic" ? 2 : 1;
      // Damage penalty: +1 = 35%, +2 = 60%, +3 = 85%
      const penalty = val === 1 ? 35 : val === 2 ? 60 : 85;
      desc = def.desc.replace("{val}", val).replace("{penalty}", penalty);
      effect.val = val;
      effect.penalty = penalty / 100;
    } else if (def.type === "add" || def.type === "mult" || def.type === "add_cap") {
      val = def.base * rarity.scale;
      if (def.stat === "shield" || def.stat === "ricochet" || def.stat === "pierce") {
        val = Math.max(1, Math.round(val));
      } else if (def.type === "mult" || def.stat === "critChance" || def.stat === "attackDiscount") {
        val = Math.round(val * 100);
      } else {
        val = Math.round(val * 10) / 10;
      }
      desc = def.desc.replace("{val}", val);
      effect.val = def.type === "mult" || def.stat === "critChance" || def.stat === "attackDiscount" ? val / 100 : val;
    }

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
      effect: effect
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
  } else if (eff.type === "multishot") {
    // Add bullets but reduce damage
    u.multishot = (u.multishot || 0) + eff.val;
    // Apply damage penalty multiplicatively
    u.multishotDmgMult = (u.multishotDmgMult || 1) * (1 - eff.penalty);
  }
  if (eff.stat === "shield") {
    u.shieldActive = u.shield;
  }
}

// ===== Spawning =====
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

function createAsteroid(x, y, type, hp, targetSlot, attackType = null) {
  const sizeMap = { small: 10, medium: 13, large: 17 };
  const r = sizeMap[type] || 12;
  const speedMult = attackType ? (ATTACK_TYPES[attackType]?.speed || 1) : 1;
  
  // Speed increases 2% per wave starting from wave 5
  const waveSpeedBonus = wave >= 5 ? 1 + (wave - 5) * 0.02 : 1;
  const baseVy = rand(25, 40) * speedMult;
  const vy = baseVy * waveSpeedBonus;
  const vx = rand(-15, 15);

  // FTL entry - asteroids start in hyperspace mode
  const ftlThreshold = GROUND_Y * 0.1; // Exit FTL at 10% into field

  return {
    id: uid(),
    x, y, vx, vy, r, type,
    hp: hp,
    maxHp: hp,
    rotation: rand(0, Math.PI * 2),
    rotSpeed: rand(-3, 3),
    vertices: generateAsteroidShape(r),
    targetSlot: targetSlot,
    attackType: attackType,
    phaseTimer: attackType === "ghost" ? 0 : null,
    splits: attackType === "splitter" ? (ATTACK_TYPES.splitter?.splits || 4) : 0,
    explosive: attackType === "bomber",
    // FTL state
    inFTL: true,
    ftlThreshold: ftlThreshold,
    ftlTrail: [], // Trail points for visual effect
  };
}

function spawnWave() {
  missiles = [];
  bullets = [];
  particles = [];
  damageNumbers = [];
  spawnQueue = []; // Reset spawn queue
  spawnTimer = 0;

  // Reset shields
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p && p.upgrades?.shield) {
      p.upgrades.shieldActive = p.upgrades.shield;
    }
  }

  // Calculate wave HP bonus for natural asteroids (used for attack scaling reference)
  const waveHpScale = wave * 0.8;

  // Queue natural wave asteroids (fewer in PvP mode)
  const playerCount = lockedSlots.length;
  const baseCount = WAVE_BASE_COUNT + Math.floor(wave * WAVE_COUNT_SCALE * 0.5);
  
  for (let i = 0; i < baseCount; i++) {
    const targetSlot = Math.floor(Math.random() * playerCount);
    const { x0, x1 } = segmentBounds(targetSlot);
    
    // Weighted size selection - large asteroids are rarer, especially early
    const largeChance = Math.min(0.15 + wave * 0.015, 0.30);
    const mediumChance = 0.35;
    const sizeRoll = Math.random();
    let type, r;
    if (sizeRoll < largeChance) {
      type = "large";
      r = rand(15, ASTEROID_R_MAX);
    } else if (sizeRoll < largeChance + mediumChance) {
      type = "medium";
      r = rand(11, 14);
    } else {
      type = "small";
      r = rand(ASTEROID_R_MIN, 10);
    }
    
    const x = rand(x0 + r + 20, x1 - r - 20);
    const y = rand(-r - 10, -r);

    // Natural asteroid HP
    const baseHpVal = type === "large" ? 3 : type === "medium" ? 1.5 : 0.75;
    const hp = Math.ceil(baseHpVal + waveHpScale);

    // Queue for staggered spawning
    spawnQueue.push({ x, y, type, hp, targetSlot, attackType: null });
  }

  // Queue player-purchased attack asteroids (spawn slightly after natural ones)
  for (const [targetSlot, attacks] of attackQueue.entries()) {
    const { x0, x1 } = segmentBounds(targetSlot);
    
    for (const attack of attacks) {
      const attackDef = ATTACK_TYPES[attack.type];
      if (!attackDef) continue;

      for (let i = 0; i < attackDef.count; i++) {
        const sizeMap = { small: 10, medium: 13, large: 17 };
        const r = sizeMap[attackDef.size] || 12;
        const x = rand(x0 + r + 30, x1 - r - 30);
        const y = rand(-r - 20, -r);

        // Attack HP: base HP + (wave * hpScale)
        // hpScale > 1.0 means attack scales FASTER than natural asteroids
        const attackHp = Math.ceil(attackDef.baseHp + (wave * attackDef.hpScale));

        // Queue for staggered spawning
        spawnQueue.push({ x, y, type: attackDef.size, hp: attackHp, targetSlot, attackType: attack.type });
      }
    }
  }

  // Shuffle the spawn queue for variety
  for (let i = spawnQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spawnQueue[i], spawnQueue[j]] = [spawnQueue[j], spawnQueue[i]];
  }

  // Clear attack queue
  attackQueue.clear();
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

  upgradePicks = new Map();
  attackQueue = new Map();

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p) {
      p.upgrades = {};
      p.towers = [null, null, null, null];
      p.gold = 30; // Starting gold for PvP
      p.cooldown = 0;
      p.targetX = null;
      p.targetY = null;
      p.manualShooting = false;
      p.turretAngle = -Math.PI / 2;
      p.score = 0;
      p.kills = 0;
      p.damageDealt = 0;
      p.hp = BASE_HP_PER_PLAYER;
      p.maxHp = BASE_HP_PER_PLAYER;
      p.ready = false;
    }
  }

  spawnWave();
  broadcast({ t: "started", world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, wave });
}

function beginUpgradePhase() {
  phase = "upgrades";
  upgradePicks = new Map();
  upgradePhaseStart = Date.now();

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p || p.hp <= 0) continue;
    const options = makeUpgradeOptions(p);
    upgradePicks.set(id, { options, pickedKey: null });
    safeSend(p.ws, { t: "upgrade", options, deadline: upgradePhaseStart + UPGRADE_TIMEOUT * 1000 });
  }
  broadcast({ t: "upgradePhase", deadline: upgradePhaseStart + UPGRADE_TIMEOUT * 1000 });
}

function maybeEndUpgradePhase() {
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p || p.hp <= 0) continue;
    const pickObj = upgradePicks.get(id);
    if (!pickObj || !pickObj.pickedKey) return;
  }
  wave += 1;
  phase = "playing";
  upgradePhaseStart = 0;
  spawnWave();
  broadcast({ t: "wave", wave });
}

function resetToLobby() {
  try {
    phase = "lobby";
    lockedSlots = null;
    missiles = [];
    bullets = [];
    particles = [];
    damageNumbers = [];
    upgradePicks = new Map();
    attackQueue = new Map();
    wave = 0;

    const arr = Array.from(players.values()).sort((a, b) => a.slot - b.slot);
    arr.forEach((p, i) => {
      p.slot = i;
      p.ready = false;
      p.towers = [null, null, null, null];
      p.gold = 0;
      p.hp = BASE_HP_PER_PLAYER;
    });

    hostId = players.size ? Array.from(players.keys())[0] : null;
    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  } catch (err) {
    console.error("Error in resetToLobby:", err);
  }
}

function checkGameOver() {
  const alivePlayers = lockedSlots.filter(id => {
    const p = players.get(id);
    return p && p.hp > 0;
  });

  if (alivePlayers.length <= 1) {
    endGame(alivePlayers[0] || null);
    return true;
  }
  return false;
}

function endGame(winnerId) {
  phase = "gameover";
  const scores = lockedSlots.map(id => {
    const p = players.get(id);
    return { 
      id, 
      name: p?.name || "???", 
      score: p?.score || 0, 
      slot: p?.slot || 0,
      kills: p?.kills || 0,
      isWinner: id === winnerId
    };
  }).sort((a, b) => b.score - a.score);

  // Update leaderboard with all players' scores
  for (const s of scores) {
    if (s.score > 0) {
      leaderboard.push({
        name: s.name,
        score: s.score,
        kills: s.kills,
        wave: wave,
        date: Date.now()
      });
    }
  }
  // Sort and keep top entries
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, MAX_LEADERBOARD_ENTRIES);
  saveLeaderboard();

  broadcast({ t: "gameOver", wave, scores, winnerId });

  setTimeout(() => {
    if (phase === "gameover") resetToLobby();
  }, 8000);
}

// ===== Simulation =====
function fireBullet(owner, originX, originY, targetX, targetY, angleOffset = 0, overrideProps = null) {
  let dmg, speed, isCrit, explosive, lifespan, bulletType;

  if (overrideProps) {
    dmg = overrideProps.damage;
    speed = BULLET_SPEED * (overrideProps.bulletType === "sniper" ? 1.5 : 1);
    isCrit = false;
    explosive = overrideProps.explosive || 0;
    lifespan = BULLET_LIFESPAN;
    bulletType = overrideProps.bulletType || "tower";

    if (overrideProps.level) {
      dmg = Math.round(dmg * (1 + (overrideProps.level - 1) * 0.25));
    }
  } else {
    dmg = BULLET_DAMAGE + (owner.upgrades?.damageAdd ?? 0);
    // Apply multishot damage penalty
    dmg *= (owner.upgrades?.multishotDmgMult ?? 1);
    speed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);
    isCrit = Math.random() < (owner.upgrades?.critChance ?? 0);
    explosive = owner.upgrades?.explosive ?? 0;
    lifespan = BULLET_LIFESPAN + (owner.upgrades?.lifespanAdd ?? 0);
    bulletType = "main";
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

  const isPlayerBullet = !overrideProps;

  bullets.push({
    id: uid(),
    ownerId: owner.id,
    ownerSlot: owner.slot,
    x: originX,
    y: originY - 6,
    vx, vy,
    r: bulletType === "sniper" ? 4 : bulletType === "missile" ? 5 : BULLET_R,
    dmg: finalDmg,
    isCrit,
    explosive: explosive,
    lifespan: lifespan,
    isTowerBullet: !isPlayerBullet,
    bulletType: bulletType,
    magnet: true, // All bullets are now homing
    chain: isPlayerBullet && !!owner.upgrades?.chain,
    ricochet: isPlayerBullet ? (owner.upgrades?.ricochet || 0) : 0,
    pierce: isPlayerBullet ? (owner.upgrades?.pierce || 0) : (bulletType === "sniper" ? 1 : 0),
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

function findBestTarget(x0, x1, turretX, turretY, rangeMult = 1.0, ownerSlot = 0) {
  let best = null;
  let bestScore = -Infinity;
  // Always use the owner's segment bounds - no cross-lane targeting
  const { x0: segX0, x1: segX1 } = segmentBounds(ownerSlot);

  for (const m of missiles) {
    // Must be within owner's segment
    if (m.x < segX0 || m.x > segX1) continue;
    if (m.y < 0) continue;
    // Spawned mobs must be targeting this player
    if (m.attackType && m.targetSlot !== ownerSlot) continue;
    
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
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
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
  // Check upgrade phase timeout
  if (phase === "upgrades" && upgradePhaseStart > 0) {
    const elapsed = Date.now() - upgradePhaseStart;
    if (elapsed >= UPGRADE_TIMEOUT * 1000) {
      // Auto-pick for players who haven't chosen
      for (const id of lockedSlots) {
        const p = players.get(id);
        if (!p || p.hp <= 0) continue;
        const pickObj = upgradePicks.get(id);
        if (pickObj && !pickObj.pickedKey && pickObj.options.length > 0) {
          // Pick random upgrade
          const randomOpt = pickObj.options[Math.floor(Math.random() * pickObj.options.length)];
          pickObj.pickedKey = randomOpt.key;
          applyUpgrade(p, randomOpt);
          safeSend(p.ws, { t: "picked", key: randomOpt.key, auto: true });
        }
      }
      // Move to next wave
      wave += 1;
      phase = "playing";
      upgradePhaseStart = 0;
      spawnWave();
      broadcast({ t: "wave", wave });
      return;
    }
  }
  
  if (phase !== "playing") return;

  try {
    // Process spawn queue (staggered asteroid spawning)
    if (spawnQueue.length > 0) {
      spawnTimer -= DT;
      if (spawnTimer <= 0) {
        // Spawn 1-2 asteroids at a time for variety
        const spawnCount = Math.min(spawnQueue.length, Math.random() < 0.7 ? 1 : 2);
        for (let i = 0; i < spawnCount && spawnQueue.length > 0; i++) {
          const queued = spawnQueue.shift();
          missiles.push(createAsteroid(queued.x, queued.y, queued.type, queued.hp, queued.targetSlot, queued.attackType));
        }
        spawnTimer = SPAWN_INTERVAL + rand(-0.1, 0.1); // Add slight randomness
      }
    }

    particles = particles.filter(p => {
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      p.life -= DT;
      p.vx *= 0.95;
      p.vy *= 0.95;
      return p.life > 0;
    });
    damageNumbers = damageNumbers.filter(d => {
      d.y += d.vy * DT;
      d.life -= DT * 1.5;
      return d.life > 0;
    });

    for (const id of lockedSlots) {
      const p = players.get(id);
      if (!p || p.hp <= 0) continue;

      p.cooldown = Math.max(0, (p.cooldown ?? 0) - DT);

      if (p.towers) {
        // Tower cooldowns are now updated in the main tower loop below
      }

      const slot = p.slot;
      const { x0, x1 } = segmentBounds(slot);
      const pos = turretPositions(slot);
      const baseCooldown = BULLET_COOLDOWN / (p.upgrades?.fireRateMult ?? 1);

      let targetX, targetY, clamped;
      if (p.manualShooting && p.targetX != null && p.targetY != null) {
        clamped = clampAimAngle(pos.main.x, pos.main.y, p.targetX, p.targetY);
        targetX = clamped.x;
        targetY = clamped.y;
      } else {
        const target = findBestTarget(x0, x1, pos.main.x, pos.main.y, 1.0, p.slot);
        if (target) {
          clamped = clampAimAngle(pos.main.x, pos.main.y, target.x, target.y);
        } else {
          clamped = clampAimAngle(pos.main.x, pos.main.y, pos.main.x, 50);
        }
        targetX = clamped.x;
        targetY = clamped.y;
      }
      p.turretAngle = clamped.angle;
      const shouldFire = p.manualShooting || findBestTarget(x0, x1, pos.main.x, pos.main.y, 1.0, p.slot);
      if (shouldFire && p.cooldown <= 0) {
        p.cooldown = baseCooldown;
        fireWithMultishot(p, pos.main.x, pos.main.y, clamped.x, clamped.y);
      }

      if (p.towers) {
        p.towers.forEach((tower, idx) => {
          if (!tower) return;
          const towerPos = pos.slots[idx];
          if (!towerPos) return;

          const stats = TOWER_TYPES[tower.type];
          if (!stats) return;

          const rangeMult = stats.rangeMult || 1.0;
          const target = findBestTarget(x0, x1, towerPos.x, towerPos.y, rangeMult, p.slot);
          
          // Update tower angle even when not firing
          if (target) {
            const aim = clampAimAngle(towerPos.x, towerPos.y, target.x, target.y);
            tower.angle = aim.angle;
            
            // Fire if cooldown ready
            if (tower.cd <= 0) {
              const levelBonus = 1 + (tower.level - 1) * 0.15;
              tower.cd = stats.cooldown / levelBonus;
              fireBullet(p, towerPos.x, towerPos.y, aim.x, aim.y, 0, { ...stats, level: tower.level });
            }
          } else {
            // Default angle pointing up when no target
            tower.angle = -Math.PI / 2;
          }
          
          // Decrease cooldown
          tower.cd = Math.max(0, (tower.cd || 0) - DT);
        });
      }
    }

    // Update missiles
    for (const m of missiles) {
      // Ghost phasing logic
      if (m.phaseTimer !== null) {
        m.phaseTimer += DT;
        m.isPhased = Math.sin(m.phaseTimer * 4) > 0.5;
      }

      // FTL entry handling - asteroids move super fast until threshold
      if (m.inFTL) {
        const ftlSpeed = 8; // 8x normal speed during FTL
        m.y += m.vy * DT * ftlSpeed;
        // Minimal x movement during FTL (looks like straight-line entry)
        m.x += m.vx * DT * 0.3;
        m.rotation += m.rotSpeed * DT * 3; // Faster spin during FTL
        
        // Exit FTL when reaching threshold
        if (m.y >= m.ftlThreshold) {
          m.inFTL = false;
          // Create exit flash effect
          createExplosion(m.x, m.y, 15, "#88f");
        }
        continue; // Skip normal movement while in FTL
      }

      let speedMult = 1;
      for (const id of lockedSlots) {
        const p = players.get(id);
        if (!p?.upgrades?.slowfield) continue;
        const { x0, x1 } = segmentBounds(p.slot);
        if (m.x >= x0 && m.x <= x1) { speedMult = 0.75; break; }
      }
      
      m.x += m.vx * DT * speedMult;
      m.y += m.vy * DT * speedMult;
      m.rotation += m.rotSpeed * DT;
      
      // Spawned mobs (attackType set) are confined to their target segment
      // Natural asteroids can cross walls freely
      if (m.attackType) {
        const { x0: segX0, x1: segX1 } = segmentBounds(m.targetSlot);
        if (m.x - m.r < segX0) { m.x = segX0 + m.r; m.vx = Math.abs(m.vx); }
        if (m.x + m.r > segX1) { m.x = segX1 - m.r; m.vx = -Math.abs(m.vx); }
      } else {
        // Natural asteroids bounce off world edges only
        if (m.x - m.r < 0) { m.x = m.r; m.vx = Math.abs(m.vx); }
        if (m.x + m.r > worldW) { m.x = worldW - m.r; m.vx = -Math.abs(m.vx); }
      }
      
      // Hit ground - damage target player
      if (m.y + m.r >= GROUND_Y) {
        let blocked = false;
        const targetSlot = m.targetSlot !== undefined ? m.targetSlot : Math.floor(m.x / SEGMENT_W);
        
        for (const id of lockedSlots) {
          const p = players.get(id);
          if (!p?.upgrades?.shieldActive || p.slot !== targetSlot) continue;
          if (p.upgrades.shieldActive > 0) {
            p.upgrades.shieldActive--;
            blocked = true;
            createExplosion(m.x, GROUND_Y - 5, 30, "#0ff");
            break;
          }
        }
        
        m.dead = true;
        
        if (!blocked) {
          // Find player for this slot and damage them
          for (const id of lockedSlots) {
            const p = players.get(id);
            if (p && p.slot === targetSlot) {
              const damage = m.explosive ? 2 : 1;
              p.hp = Math.max(0, p.hp - damage);
              createExplosion(m.x, GROUND_Y - 5, m.explosive ? 60 : 40, m.explosive ? "#ff00ff" : "#f44");
              
              if (m.explosive) {
                // Bomber explosion damages nearby asteroids too
                for (const m2 of missiles) {
                  if (m2.dead || m2 === m) continue;
                  const d = Math.hypot(m2.x - m.x, m2.y - m.y);
                  if (d < 50) { m2.hp -= 2; if (m2.hp <= 0) m2.dead = true; }
                }
              }
              break;
            }
          }
        }
      }
    }

    // Bullet collision
    for (const b of bullets) {
      // All bullets now have perfect homing - but ONLY within owner's segment
      if (b.magnet) {
        let nearest = null;
        let nearestDist = 400; // Detection range
        const { x0: ownerX0, x1: ownerX1 } = segmentBounds(b.ownerSlot);
        
        for (const m of missiles) {
          if (m.dead || m.isPhased) continue;
          // Only target asteroids within the bullet owner's segment
          if (m.x < ownerX0 || m.x > ownerX1) continue;
          // Spawned mobs must also be targeting this player
          if (m.attackType && m.targetSlot !== b.ownerSlot) continue;
          
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
          // Strong homing - bullets curve sharply toward targets
          const homingStrength = 1500 * DT;
          b.vx += (dx / len) * homingStrength;
          b.vy += (dy / len) * homingStrength;
          // Normalize to maintain consistent speed
          const speed = Math.hypot(b.vx, b.vy);
          const targetSpeed = BULLET_SPEED * 1.2;
          b.vx = (b.vx / speed) * targetSpeed;
          b.vy = (b.vy / speed) * targetSpeed;
        }
      }
      b.x += b.vx * DT;
      b.y += b.vy * DT;

      b.lifespan -= DT;
      if (b.lifespan <= 0) { b.dead = true; continue; }

      let didRicochet = false;
      
      // Bullets can only exist in their owner's segment (hard walls)
      const { x0: ownerX0, x1: ownerX1 } = segmentBounds(b.ownerSlot);
      if (b.x < ownerX0) { 
        if (b.ricochet > 0) { b.x = ownerX0; b.vx = -b.vx; b.ricochet--; didRicochet = true; } 
        else { b.dead = true; } 
      }
      else if (b.x > ownerX1) { 
        if (b.ricochet > 0) { b.x = ownerX1; b.vx = -b.vx; b.ricochet--; didRicochet = true; } 
        else { b.dead = true; } 
      }
      if (b.y < -50) { if (b.ricochet > 0) { b.y = -50; b.vy = -b.vy; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
      if (b.y > GROUND_Y) { if (b.ricochet > 0) { b.y = GROUND_Y; b.vy = -b.vy; b.ricochet--; didRicochet = true; } else { b.dead = true; } }
      if (didRicochet) b.hitList = [];
    }

    for (const b of bullets) {
      if (b.dead) continue;
      const { x0: ownerX0, x1: ownerX1 } = segmentBounds(b.ownerSlot);
      for (const m of missiles) {
        if (m.dead) continue;
        // Bullets can only hit asteroids within their owner's segment
        if (m.x < ownerX0 || m.x > ownerX1) continue;
        // Spawned mobs must also be targeting this player
        if (m.attackType && m.targetSlot !== b.ownerSlot) continue;
        if (m.isPhased && Math.random() > 0.3) continue; // Phased asteroids have 70% evasion
        if (b.hitList && b.hitList.includes(m.id)) continue;
        const dx = m.x - b.x;
        const dy = m.y - b.y;
        const rr = m.r + b.r;
        if (dx * dx + dy * dy <= rr * rr) {
          m.hp -= b.dmg;
          if (!b.hitList) b.hitList = [];
          b.hitList.push(m.id);
          if (b.pierce > 0) { b.pierce--; } else { b.dead = true; }
          addDamageNumber(m.x, m.y - m.r, b.dmg, b.isCrit);
          const owner = players.get(b.ownerId);
          
          // Track damage dealt
          if (owner) {
            owner.damageDealt = (owner.damageDealt || 0) + b.dmg;
          }
          
          if (m.hp <= 0) {
            m.dead = true;
            createExplosion(m.x, m.y, 25, ATTACK_TYPES[m.attackType]?.color || "#fa0");
            
            if (owner) {
              owner.score = (owner.score || 0) + 50;
              owner.kills = (owner.kills || 0) + 1;
              // Only natural asteroids give gold, not player-spawned attacks
              if (!m.attackType) {
                const goldMult = owner.upgrades?.goldMult ?? 1;
                const goldReward = m.type === "large" ? 4 : m.type === "medium" ? 2 : 1;
                owner.gold = (owner.gold || 0) + Math.round(goldReward * goldMult);
              }
            }
            
            // Handle splitter
            if (m.splits > 0) {
              // Split children HP scales with wave (weaker than parent)
              const splitHp = Math.ceil(1 + wave * 0.4);
              for (let s = 0; s < m.splits; s++) {
                const nx = m.x + rand(-30, 30);
                const ny = m.y + rand(-20, 20);
                missiles.push(createAsteroid(nx, ny, "small", splitHp, m.targetSlot, null));
              }
            }
          } else {
            if (owner) owner.score = (owner.score || 0) + Math.round(b.dmg * 10);
          }
          
          if (b.explosive > 0) {
            createExplosion(b.x, b.y, 35, "#fa0");
            for (const m2 of missiles) {
              if (m2.dead || m2 === m) continue;
              const d = Math.hypot(m2.x - b.x, m2.y - b.y);
              if (d < 35 + m2.r) { m2.hp -= 1; if (m2.hp <= 0) m2.dead = true; }
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
                particles.push({ x: m.x, y: m.y, vx: (m2.x - m.x) * 3, vy: (m2.y - m.y) * 3, life: 0.12, maxLife: 0.12, color: "#ff0", size: 2 });
                break;
              }
            }
          }
          createExplosion(b.x, b.y, 15, b.isCrit ? "#ff0" : "#0ff");
          if (b.dead) break;
        }
      }
    }

    missiles = missiles.filter((m) => !m.dead);
    bullets = bullets.filter((b) => !b.dead);

    // Check for game over (PvP: last player standing)
    if (checkGameOver()) return;

    // Check if wave is complete (all asteroids destroyed AND spawn queue empty)
    if (missiles.length === 0 && spawnQueue.length === 0) {
      if (waveClearedTime === 0) {
        waveClearedTime = Date.now();
      } else if (Date.now() - waveClearedTime >= WAVE_CLEAR_DELAY) {
        waveClearedTime = 0; // Reset for next wave
        beginUpgradePhase();
        return;
      }
    } else {
      waveClearedTime = 0; // Reset if new asteroids appear or queue not empty
    }

    broadcast({
      t: "state",
      ts: Date.now(),
      phase,
      wave,
      world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
      missiles: missiles.map((m) => ({
        id: m.id, x: m.x, y: m.y, r: m.r, hp: m.hp, maxHp: m.maxHp, type: m.type,
        rotation: m.rotation, vertices: m.vertices, attackType: m.attackType, isPhased: m.isPhased,
        inFTL: m.inFTL
      })),
      bullets: bullets.map((b) => ({
        id: b.id, x: b.x, y: b.y, r: b.r, vx: b.vx, vy: b.vy,
        slot: b.ownerSlot, isCrit: b.isCrit, lifespan: b.lifespan,
        isTower: b.isTowerBullet, bulletType: b.bulletType
      })),
      particles: particles.map((p) => ({ x: p.x, y: p.y, life: p.life, maxLife: p.maxLife, color: p.color, size: p.size })),
      damageNumbers: damageNumbers.map((d) => ({ x: d.x, y: d.y, amount: d.amount, isCrit: d.isCrit, life: d.life })),
      players: lockedSlots.map((id) => {
        const p = players.get(id);
        if (!p) return { id, slot: -1 };
        return {
          id: p.id, slot: p.slot,
          name: p.name || `Player ${p.slot + 1}`,
          score: p.score || 0,
          gold: p.gold || 0,
          hp: p.hp,
          maxHp: p.maxHp,
          turretAngle: p.turretAngle || -Math.PI / 2,
          isManual: !!p.manualShooting,
          towers: p.towers,
          kills: p.kills || 0,
          damageDealt: p.damageDealt || 0,
          upgrades: {
            shieldActive: p.upgrades?.shieldActive ?? 0,
            slowfield: !!p.upgrades?.slowfield,
          },
        };
      }),
    });
  } catch (err) {
    console.error("Game loop error:", err);
  }
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
    towers: [null, null, null, null],
    gold: 0, cooldown: 0, score: 0, ready: false, damageDealt: 0,
    hp: BASE_HP_PER_PLAYER,
    maxHp: BASE_HP_PER_PLAYER,
    kills: 0,
  };

  players.set(id, player);
  if (!hostId) hostId = id;

  recomputeWorld();
  safeSend(ws, { 
    t: "welcome", id, slot, isHost: id === hostId, 
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, 
    phase,
    attackTypes: ATTACK_TYPES
  });
  broadcast({ t: "lobby", ...lobbySnapshot() });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    if (msg.t === "setName") {
      p.name = (msg.name || "").toString().slice(0, 16).trim() || p.name;
      broadcast({ t: "lobby", ...lobbySnapshot() });
      return;
    }
    if (msg.t === "ready" && phase === "lobby") {
      p.ready = !p.ready;
      broadcast({ t: "lobby", ...lobbySnapshot() });
      return;
    }
    if (msg.t === "start") {
      // Any ready player can start the game when all are ready
      if (phase === "lobby" && p.ready) {
        const snap = lobbySnapshot();
        if (snap.allReady) startGame();
      }
      return;
    }
    if (msg.t === "input" && phase === "playing") {
      p.targetX = Number(msg.x) || 0;
      p.targetY = Number(msg.y) || 0;
      p.manualShooting = !!msg.shooting;
      return;
    }

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
        const pl = players.get(pid);
        if (!po || !po.pickedKey) { if (pl && pl.hp > 0) waiting.push(pl.name); }
      }
      broadcast({ t: "upgradeWaiting", waiting });
      maybeEndUpgradePhase();
      return;
    }

    // Return to lobby from game over screen
    if (msg.t === "returnToLobby" && phase === "gameover") {
      resetLobby();
      return;
    }

    // Clear leaderboard with password
    if (msg.t === "clearLeaderboard") {
      if (msg.password === "1122") {
        leaderboard = [];
        saveLeaderboard();
        broadcast({ t: "lobby", ...lobbySnapshot() });
      }
      return;
    }

    // PvP: Buy attack to send at random opponent
    if (msg.t === "buyAttack" && (phase === "playing" || phase === "upgrades")) {
      const { attackType } = msg;
      if (!ATTACK_TYPES[attackType]) return;
      
      // Get list of valid targets (alive players that aren't the buyer)
      const validTargets = lockedSlots.filter(pid => {
        if (pid === id) return false;
        const targetPlayer = players.get(pid);
        return targetPlayer && targetPlayer.hp > 0;
      });
      
      if (validTargets.length === 0) return; // No valid targets
      
      // Randomly select a target
      const targetId = validTargets[Math.floor(Math.random() * validTargets.length)];
      const targetPlayer = players.get(targetId);
      const targetSlot = targetPlayer.slot;
      
      let cost = ATTACK_TYPES[attackType].cost;
      const discount = p.upgrades?.attackDiscount || 0;
      cost = Math.round(cost * (1 - discount));
      
      if (p.gold >= cost) {
        p.gold -= cost;
        
        if (!attackQueue.has(targetSlot)) {
          attackQueue.set(targetSlot, []);
        }
        attackQueue.get(targetSlot).push({ type: attackType, senderId: id });
        
        safeSend(ws, { t: "attackQueued", attackType, targetSlot, targetName: targetPlayer.name, cost });
        
        // Notify target
        if (targetPlayer.ws) {
          safeSend(targetPlayer.ws, { t: "incomingAttack", attackType, from: p.name });
        }
      }
      return;
    }

    if (msg.t === "buyTower" && phase === "playing") {
      const { slotIndex, type } = msg;
      if (!TOWER_TYPES[type]) return;
      if (slotIndex < 0 || slotIndex > 3) return;
      if (p.towers[slotIndex]) return;
      const cost = TOWER_TYPES[type].cost;
      if (p.gold >= cost) { p.gold -= cost; p.towers[slotIndex] = { type, level: 1, cd: 0 }; }
    }

    if (msg.t === "upgradeTower" && phase === "playing") {
      const { slotIndex } = msg;
      if (slotIndex < 0 || slotIndex > 3) return;
      const tower = p.towers[slotIndex];
      if (!tower) return;
      if (tower.level >= MAX_TOWER_LEVEL) return;
      const stats = TOWER_TYPES[tower.type];
      if (!stats) return;
      const upgradeCost = stats.upgradeCost * tower.level;
      if (p.gold >= upgradeCost) {
        p.gold -= upgradeCost;
        tower.level++;
      }
    }

    if (msg.t === "sellTower" && phase === "playing") {
      const { slotIndex } = msg;
      if (slotIndex < 0 || slotIndex > 3) return;
      const tower = p.towers[slotIndex];
      if (!tower) return;
      const stats = TOWER_TYPES[tower.type];
      if (!stats) return;
      let totalInvested = stats.cost;
      for (let lvl = 1; lvl < tower.level; lvl++) {
        totalInvested += stats.upgradeCost * lvl;
      }
      p.gold += Math.floor(totalInvested * 0.5);
      p.towers[slotIndex] = null;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    if (hostId === id) hostId = players.size ? Array.from(players.keys())[0] : null;

    if (phase !== "lobby" && players.size === 0) {
      console.log("All players disconnected during game, resetting to lobby");
      resetToLobby();
      return;
    }

    if (phase !== "lobby" && lockedSlots) {
      const remainingPlayers = lockedSlots.filter(pid => players.has(pid));
      if (remainingPlayers.length === 0) {
        console.log("All game players disconnected, resetting to lobby");
        resetToLobby();
        return;
      }
      // Mark disconnected player as dead for game over check
      const idx = lockedSlots.indexOf(id);
      if (idx !== -1) {
        // Player left, set hp to 0 for game logic
        checkGameOver();
      }
      return;
    }

    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  });
});

setInterval(() => { tick(); }, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Rogue Asteroid PvP server: http://localhost:${PORT}`); });
