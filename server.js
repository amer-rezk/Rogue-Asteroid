// server.js - Rogue Asteroid PvP (SERVER AUTHORITATIVE v5)
// Competitive asteroid defense with attack purchasing
// 
// ARCHITECTURE:
// - Server broadcasts at 30Hz (same as physics rate)
// - Client renders server positions directly - NO prediction
// - This eliminates all desync - client always matches server
// - Particles/damage numbers are client-side (visual only)
// - Asteroid vertices/rotation cached client-side from spawn events
// - PREDICTIVE AIMING: No homing - bullets aim at intercept point
// - Multishot bullets can target different asteroids

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

// ===== Game constants =====
const MAX_PLAYERS = 4;
const TICK_RATE = 30;          // Physics at 30Hz
const BROADCAST_RATE = 30;     // Network at 30Hz (same as physics, no client prediction needed)
const DT = 1 / TICK_RATE;
const BROADCAST_INTERVAL = Math.floor(TICK_RATE / BROADCAST_RATE); // = 1 tick (every frame)

const WORLD_H = 600;
const GROUND_Y = 560;
const SEGMENT_W = 360;

// PRE-ALLOCATED BROADCAST STATE - reused every frame to avoid GC pressure
const broadcastState = {
  t: "state",
  ts: 0,
  phase: "",
  wave: 0,
  spectatorCount: 0,
  world: { width: 0, height: WORLD_H, segmentWidth: 0 },
  missiles: [],
  bullets: [],
  events: [],
  shieldExplosions: [],
  ghostAllies: [],
  gravityWells: [],
  moduleCardPhase: false,
  modulePickTimer: 0,
  currentModulePicker: null,
  players: []
};
// Pre-allocate arrays with capacity (will grow if needed)
for (let i = 0; i < 200; i++) broadcastState.missiles.push({});
for (let i = 0; i < 100; i++) broadcastState.bullets.push({});
for (let i = 0; i < 10; i++) broadcastState.shieldExplosions.push({});
for (let i = 0; i < 20; i++) broadcastState.ghostAllies.push({});
for (let i = 0; i < 10; i++) broadcastState.gravityWells.push({});
for (let i = 0; i < 4; i++) broadcastState.players.push({ upgrades: {} });

const BASE_HP_PER_PLAYER = 20;

const BULLET_R = 2.5;
const BULLET_SPEED = 175;
const BULLET_COOLDOWN = 0.72;
const BULLET_DAMAGE = 1.25;
const BULLET_LIFESPAN = 3.0;

const ASTEROID_R_MIN = 8;
const ASTEROID_R_MAX = 16;

const WAVE_BASE_COUNT = 3;
const WAVE_COUNT_SCALE = 0.5;  // Halved again to reduce wave length at high waves

const MAX_AIM_ANGLE = (80 * Math.PI) / 180;

// ===== Player Colors =====
const PLAYER_COLORS = [
  { main: "#00ffff", dark: "#006666", name: "CYAN" },
  { main: "#ff00ff", dark: "#660066", name: "MAGENTA" },
  { main: "#00ff88", dark: "#006633", name: "GREEN" },
  { main: "#ffaa00", dark: "#664400", name: "ORANGE" },
];

// ===== Tower Definitions =====
const TOWER_TYPES = {
  0: { name: "Gatling", cost: 50, damage: 0.5, cooldown: 0.25, rangeMult: 0.8, color: "#ffff00", upgradeCost: 40, bulletType: "gatling" },
  1: { name: "Sniper", cost: 120, damage: 5, cooldown: 1.2, rangeMult: 1.5, color: "#00ff00", upgradeCost: 80, bulletType: "sniper" },
  2: { name: "Missile", cost: 250, damage: 8, cooldown: 2.0, rangeMult: 1.0, color: "#ff0000", explosive: 1, upgradeCost: 150, bulletType: "missile" }
};
const MAX_TOWER_LEVEL = 5;

// ===== PvP Attack Units =====
const ATTACK_TYPES = {
  swarm: { name: "Swarm", cost: 25, count: 3, baseHp: 0.05, hpScale: 0.56, size: "small", speed: 1.3, desc: "3 fast weak asteroids", color: "#ffcc00", icon: "🐝" },
  bruiser: { name: "Bruiser", cost: 35, count: 1, baseHp: 3.75, hpScale: 1.125, size: "large", speed: 0.6, desc: "Very tanky asteroid", color: "#ff4444", icon: "🪨" },
  carrier: { name: "Carrier", cost: 60, count: 1, baseHp: 3, hpScale: 0.975, size: "large", speed: 0.5, spawner: true, spawnInterval: 2.0, spawnCount: 2, desc: "Spawns minions!", color: "#ff00ff", icon: "👑" },
  splitter: { name: "Splitter", cost: 50, count: 1, baseHp: 2.5, hpScale: 0.975, size: "large", speed: 0.75, splits: 15, desc: "Splits into 15 on death", color: "#00ffff", icon: "💎" },
  ghost: { name: "Ghost", cost: 40, count: 2, baseHp: 1, hpScale: 0.9, size: "medium", speed: 1.1, phasing: true, desc: "2 phasing asteroids", color: "#8800ff", icon: "👻" },
  berserker: { name: "Berserker", cost: 0, count: 1, baseHp: 3, hpScale: 1.2, size: "large", speed: 0.8, desc: "Speeds up when damaged!", color: "#ff2200", icon: "🔥" }
};

// ===== Tower Modules (Boss Rewards) =====
const TOWER_MODULES = {
  fractalPrism: {
    id: "fractalPrism",
    name: "Fractal Prism",
    icon: "💎",
    color: "#00ffff",
    desc: "Bullets shatter into 3 smaller bullets on hit",
    effect: "shatter"
  },
  midasCapacitor: {
    id: "midasCapacitor", 
    name: "Midas Capacitor",
    icon: "💰",
    color: "#ffd700",
    desc: "Deals 1% of your gold as bonus damage",
    effect: "goldDamage"
  },
  necromancerDrive: {
    id: "necromancerDrive",
    name: "Necromancer Drive", 
    icon: "💀",
    color: "#8844ff",
    desc: "Killing blows create ghost allies that damage enemies",
    effect: "ghostAlly"
  },
  quantumDisplacer: {
    id: "quantumDisplacer",
    name: "Quantum Displacer",
    icon: "⏳", 
    color: "#ff44ff",
    desc: "20% chance to teleport enemy back to top",
    effect: "teleport"
  },
  russianRoulette: {
    id: "russianRoulette",
    name: "Russian Roulette",
    icon: "🎲",
    color: "#ff0000",
    desc: "Random 0x-10x damage multiplier per shot",
    effect: "randomDamage"
  },
  gravityWell: {
    id: "gravityWell",
    name: "Gravity Well",
    icon: "🕳️",
    color: "#440088",
    desc: "Bullets pull nearby enemies together for 2s",
    effect: "gravity"
  },
  vampiricNanobots: {
    id: "vampiricNanobots",
    name: "Vampiric Nanobots",
    icon: "🩸",
    color: "#cc0000",
    desc: "-50% damage, but heal 1 HP per 100 damage dealt",
    effect: "lifesteal"
  },
  matterCompressor: {
    id: "matterCompressor",
    name: "Matter Compressor",
    icon: "🤏",
    color: "#00ff88",
    desc: "Shrinks enemies 10% per hit. <5px = instakill",
    effect: "shrink"
  },
  chainReaction: {
    id: "chainReaction",
    name: "Chain Reaction",
    icon: "⚡",
    color: "#ffff00",
    desc: "Charged enemies explode when touching others",
    effect: "static"
  },
  confettiCannon: {
    id: "confettiCannon",
    name: "Confetti Cannon",
    icon: "🎉",
    color: "#ff88ff",
    desc: "Each bullet has random stats (size, speed, damage)",
    effect: "random"
  }
};

const MODULE_IDS = Object.keys(TOWER_MODULES);

// ===== Server state =====
const app = express();
app.use(express.static(path.join(__dirname, "docs")));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const players = new Map();

let hostId = null;
let phase = "lobby";
let soloMode = false;

let lockedSlots = null;
let worldW = SEGMENT_W;
let wave = 0;

let missiles = [];
let bullets = [];
let shieldExplosions = []; // Active shield explosions that deal damage
let ghostAllies = []; // Necromancer ghost allies flying upward
let gravityWells = []; // Active gravity wells pulling enemies

// Shield sphere radius (as fraction of segment width)
const SHIELD_RADIUS_MULT = 0.45;

let upgradePicks = new Map();
let attackQueue = new Map();
let pendingUpgrades = new Map();
let waveClearedTime = 0;
const WAVE_CLEAR_DELAY = 500;

// Module card selection after boss waves
let moduleCardPhase = false;
let moduleCards = []; // 5 random cards to choose from
let modulePickOrder = []; // Order of players picking (boss killer first)
let modulePlayersPicked = new Set(); // Track who has picked
let currentModulePicker = 0;
let modulePickTimer = 0;
const MODULE_PICK_TIME = 10; // 10 seconds per pick
let bossKillerId = null; // Track who killed the boss

// Pause system
let gamePaused = false;
let pauseCountdown = 0; // 5 second countdown before resuming
let pausedBy = null; // Name of player who paused

// Staggered spawn system
let spawnQueue = [];
let spawnTimer = 0;
const SPAWN_INTERVAL = 0.3;

// OPTIMIZED: Event queue for client-side effects
let eventQueue = [];

// SPATIAL PARTITIONING: Pre-bucket missiles by targetSlot for O(1) lookup
// Reused each tick to avoid allocation
const missilesBySlot = [[], [], [], []];

// Tick counter for broadcast throttling
let tickCount = 0;

// Leaderboard
let leaderboard = [];
const MAX_LEADERBOARD_ENTRIES = 10;
const LEADERBOARD_FILE = path.join(__dirname, "leaderboard.json");

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

function saveLeaderboard() {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
  } catch (err) {
    console.error("Failed to save leaderboard:", err);
  }
}

loadLeaderboard();

// Chat system
let chatHistory = [];
const MAX_CHAT_HISTORY = 50;

function addChatMessage(fromName, text) {
  const msg = {
    id: uid(),
    from: fromName,
    text: text.slice(0, 200),
    timestamp: Date.now()
  };
  chatHistory.push(msg);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.shift();
  }
  return msg;
}

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
function safeSendRaw(ws, str) {
  // Skip if WebSocket buffer is backed up (backpressure)
  // This prevents server from getting overwhelmed sending to slow clients
  if (ws.readyState === 1 && ws.bufferedAmount < 65536) {
    ws.send(str);
  }
}
function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const p of players.values()) safeSendRaw(p.ws, str);
}
function broadcastAll(obj) {
  // Send to both players and spectators - stringify once
  const str = JSON.stringify(obj);
  for (const p of players.values()) safeSendRaw(p.ws, str);
  for (const ws of spectators) safeSendRaw(ws, str);
}
function broadcastLobby() {
  // Send lobby state to both players and spectators
  const snapshot = { t: "lobby", ...lobbySnapshot() };
  const str = JSON.stringify(snapshot);
  for (const p of players.values()) safeSendRaw(p.ws, str);
  for (const ws of spectators) safeSendRaw(ws, str);
}

// Spectator tracking
const spectators = new Set();

// OPTIMIZED: Queue an event for client-side visual effects
function queueEvent(type, data) {
  eventQueue.push({ t: type, ...data });
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

// Pre-computed segment bounds for all 4 slots (avoids object creation each call)
const SEGMENT_BOUNDS = [
  { x0: 0 * SEGMENT_W, x1: 1 * SEGMENT_W },
  { x0: 1 * SEGMENT_W, x1: 2 * SEGMENT_W },
  { x0: 2 * SEGMENT_W, x1: 3 * SEGMENT_W },
  { x0: 3 * SEGMENT_W, x1: 4 * SEGMENT_W }
];

function segmentBounds(slot) {
  return SEGMENT_BOUNDS[slot] || { x0: slot * SEGMENT_W, x1: (slot + 1) * SEGMENT_W };
}

function isSlotAlive(slot) {
  if (!lockedSlots || slot < 0 || slot >= lockedSlots.length) return false;
  const playerId = lockedSlots[slot];
  const player = players.get(playerId);
  return player && player.hp > 0;
}

function getAliveSlots() {
  if (!lockedSlots) return [];
  return lockedSlots.map((id, idx) => {
    const p = players.get(id);
    return (p && p.hp > 0) ? idx : -1;
  }).filter(slot => slot >= 0);
}

function redistributeAsteroids(deadSlot) {
  const aliveSlots = getAliveSlots();
  if (aliveSlots.length === 0) return;
  
  for (const m of missiles) {
    if (m.dead) continue;
    
    // BOSS STAYS - Don't redistribute boss or boss ads when player dies
    // The boss and its minions belong to that player's lane only
    if (m.type === "boss" || m.isBossAd) continue;
    
    // If the missile was targeting the player who just died
    if (m.targetSlot === deadSlot) {
      
      // 1. Find players who are alive AND did not send this asteroid
      // (lockedSlots array maps the slot number to the Player ID)
      const validTargets = aliveSlots.filter(slotIdx => {
        const playerId = lockedSlots[slotIdx];
        return playerId !== m.senderId;
      });

      // 2. Pick a new target
      if (validTargets.length > 0) {
        const newSlot = validTargets[Math.floor(Math.random() * validTargets.length)];
        const { x0, x1 } = segmentBounds(newSlot);
        
        m.targetSlot = newSlot;
        
        // Randomize X position in the new lane
        m.x = x0 + Math.random() * (x1 - x0);
        
        // 3. FIX: Reset Y position to the TOP of the screen
        m.y = -m.r - 20; 
        
        // Visual flair: Trigger the "FTL" hyperspace effect again
        m.inFTL = true;  
      } else {
        // If the only person left is the one who sent it, just destroy the asteroid
        m.dead = true; 
        createExplosion(m.x, m.y, 20, "#ff00ff");
      }
    }
  }
  
  // Handle asteroids that were queued up but not spawned yet
  for (const queued of spawnQueue) {
    // Skip boss from redistribution
    if (queued.type === "boss") continue;
    
    if (queued.targetSlot === deadSlot) {
      const newSlot = aliveSlots[Math.floor(Math.random() * aliveSlots.length)];
      const { x0, x1 } = segmentBounds(newSlot);
      queued.targetSlot = newSlot;
      queued.x = x0 + Math.random() * (x1 - x0);
    }
  }
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
  const readyCount = list.filter(p => p.ready).length;
  const allReady = list.length > 0 && list.every(p => p.ready);
  return { players: list, hostId, allReady, readyCount, leaderboard, spectatorCount: spectators.size };
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
  { id: "fire", name: "Rapid Fire", cat: "offense", icon: "🔥", desc: "+{val}% Fire Rate", stat: "fireRateMult", base: 0.05, type: "mult" },
  { id: "multi", name: "Multishot", cat: "offense", icon: "⚔️", desc: "+{val} Bullets (-{penalty}% dmg)", stat: "multishot", base: 1, type: "multishot" },
  { id: "crit", name: "Crit Scope", cat: "offense", icon: "🎯", desc: "+{val}% Crit Chance", stat: "critChance", base: 0.05, type: "add_cap", cap: 1.0 },
  { id: "boom", name: "Explosive", cat: "offense", icon: "💣", desc: "Explosions size +{val}", stat: "explosive", base: 1, type: "add" },
  { id: "rico", name: "Ricochet", cat: "utility", icon: "🎱", desc: "Bounces {val} times", stat: "ricochet", base: 1, type: "add" },
  { id: "pierce", name: "Railgun", cat: "utility", icon: "📌", desc: "Pierces {val} enemies", stat: "pierce", base: 1, type: "add" },
  { id: "chain", name: "Tesla Coil", cat: "utility", icon: "⚡", desc: "{val}% chance for Lightning", stat: "chainChance", base: 0.02, type: "add_cap", cap: 0.30 },
  { id: "shield", name: "Shield Gen", cat: "defense", icon: "🛡️", desc: "+{val} Shield (one-time)", stat: "shield", base: 1, type: "add" },
  { id: "slow", name: "Grav Field", cat: "defense", icon: "🌀", desc: "Slow Enemies", stat: "slowfield", base: 1, type: "bool" },
  { id: "income", name: "War Profiteer", cat: "economy", icon: "💰", desc: "+{val}% Gold (Kills & Income)", stat: "goldMult", base: 0.12, type: "mult" },
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

    let rarityKey = rollRarity();
    
    // Multishot and Chain Lightning are rare+ only (skip if common rolled)
    if ((def.id === "multi" || def.id === "chain") && rarityKey === "common") {
      rarityKey = "rare";
    }
    
    const rarity = RARITY_CONFIG[rarityKey];

    let val = def.base;
    let desc = def.desc;
    let effect = { stat: def.stat, type: def.type };
    
    if (def.type === "multishot") {
      // Rare: +1, Epic: +2, Legendary: +3
      val = rarityKey === "legendary" ? 3 : rarityKey === "epic" ? 2 : 1;
      const penalty = val === 1 ? 15 : val === 2 ? 25 : 40;
      desc = def.desc.replace("{val}", val).replace("{penalty}", penalty);
      effect.val = val;
      effect.penalty = penalty / 100;
    } else if (def.id === "chain") {
      // Chain Lightning: Rare: 2%, Epic: 4%, Legendary: 6%
      val = rarityKey === "legendary" ? 6 : rarityKey === "epic" ? 4 : 2;
      desc = def.desc.replace("{val}", val);
      effect.val = val / 100; // Convert to decimal
      effect.type = "add";
    } else if (def.type === "add" || def.type === "mult" || def.type === "add_cap") {
      val = def.base * rarity.scale;
      if (def.stat === "shield" || def.stat === "ricochet" || def.stat === "pierce") {
        val = Math.max(1, Math.round(val));
      } else if (def.type === "mult" || def.stat === "critChance") {
        val = Math.round(val * 100);
      } else {
        val = Math.round(val * 10) / 10;
      }
      desc = def.desc.replace("{val}", val);
      effect.val = def.type === "mult" || def.stat === "critChance" ? val / 100 : val;
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
    u.multishot = (u.multishot || 1) + eff.val;
    u.multishotDmgMult = (u.multishotDmgMult || 1) * (1 - eff.penalty);
  }
  if (eff.stat === "shield") {
    u.shieldActive = (u.shieldActive || 0) + eff.val;
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

function createAsteroid(x, y, type, hp, targetSlot, attackType = null, senderId = null, bossAdVariant = null, noGold = false, isMiniBoss = false) {
  const sizeMap = { small: 10, medium: 13, large: 17, boss: 75, miniboss: 19, minibossAd: 8 }; // Mini-boss is 75% smaller than boss
  const r = sizeMap[type] || 12;
  const speedMult = type === "boss" ? 0.3 : (type === "miniboss" ? 0.5 : (attackType ? (ATTACK_TYPES[attackType]?.speed || 1) : 1)); // Mini-boss slightly faster than boss
  
  let waveSpeedBonus = wave >= 5 ? 1 + (wave - 5) * 0.03125 : 1;  // +25% speed scaling (was 0.025)
  if (wave >= 20) {
    waveSpeedBonus += (wave - 19) * 0.047;  // +25% speed scaling (was 0.0375)
  }
  const baseVy = rand(25, 40) * speedMult;
  const vy = baseVy * waveSpeedBonus;
  const vx = rand(-15, 15);

  const ftlThreshold = GROUND_Y * 0.1;
  const id = uid();
  const vertices = generateAsteroidShape(r);
  const rotSpeed = rand(-3, 3);
  const color = attackType ? (ATTACK_TYPES[attackType]?.color || "#fa0") : (type === "miniboss" || type === "minibossAd" ? "#ff4400" : "#fa0");
  
  // Determine if this is a boss or boss ad (for image rendering)
  const isBoss = type === "boss";
  const isBossAd = bossAdVariant !== null;
  const isMiniBossType = type === "miniboss" || isMiniBoss;
  const isMiniBossAd = type === "minibossAd";

  // OPTIMIZED: Send spawn event with vertices/rotSpeed/velocity so client can cache and predict
  queueEvent("spawn", { id, x, y, r, type, attackType, vertices, rotSpeed, color, vx, vy, isBoss, isBossAd, bossAdVariant, isMiniBoss: isMiniBossType, isMiniBossAd });

  return {
    id,
    x, y, vx, vy, r, type,
    hp: hp,
    maxHp: hp,
    lastSpawnHp: hp, // Track HP for boss spawns
    bossSpawnCount: 0, // Track number of boss minion spawns (max 3)
    rotSpeed: rotSpeed,
    // vertices only sent once at spawn via event, not stored
    targetSlot: targetSlot,
    attackType: attackType,
    senderId: senderId,
    phaseTimer: attackType === "ghost" ? 0 : null,
    splits: attackType === "splitter" ? (ATTACK_TYPES.splitter?.splits || 4) : 0,
    isBerserker: attackType === "berserker", // Berserker speeds up as HP drops
    accelerates: false, // Removed juggernaut
    // Carrier spawner properties
    isCarrier: attackType === "carrier",
    carrierSpawnTimer: attackType === "carrier" ? ATTACK_TYPES.carrier.spawnInterval : null,
    isBoss: isBoss,
    isBossAd: isBossAd,
    bossAdVariant: bossAdVariant,
    isMiniBoss: isMiniBossType,
    isMiniBossAd: isMiniBossAd,
    noGold: noGold, // Only spawned minions from splitter/carrier give no gold
    inFTL: true,
    ftlThreshold: ftlThreshold,
    ftlTrail: [],
  };
}

function spawnWave() {
  missiles = [];
  bullets = [];
  shieldExplosions = [];
  ghostAllies = [];
  gravityWells = [];
  spawnQueue = [];
  spawnTimer = 0;

  // NEW: BOSS ROUND CHECK (Every 10 waves)
  if (wave % 10 === 0) {
    const playerCount = lockedSlots.length;
    for (let playerIdx = 0; playerIdx < playerCount; playerIdx++) {
      const playerId = lockedSlots[playerIdx];
      const player = players.get(playerId);
      if (!player || player.hp <= 0) continue;

      const targetSlot = playerIdx;
      const { x0 } = segmentBounds(targetSlot);
      
      // Boss HP Calculation - wave 10 is baseline, scales harder after
      // Wave 10: 55 HP, Wave 20: ~135 HP, Wave 30: ~280 HP
      let bossHp = 25 + (wave * 3);
      if (wave > 10) {
        bossHp += Math.floor(Math.pow(wave - 10, 1.5) * 3);
      } 
      
      spawnQueue.push({ 
        x: x0 + SEGMENT_W / 2, 
        y: -180, // Start high above screen
        type: "boss", 
        hp: bossHp, 
        targetSlot, 
        attackType: null 
      });
    }
    // Announce Boss
    broadcast({ t: "chatMsg", id: uid(), from: "SYSTEM", text: "⚠️ GIANT ASTEROID DETECTED ⚠️", timestamp: Date.now() });
    return; // Skip normal spawns
  }

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p) {
      p.waveDamage = 0;
    }
  }

  const extremeScaleMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
  const baseWaveHp = wave * 0.6; // Reduced from 0.8 (25% less scaling)
  const waveHpScale = baseWaveHp * extremeScaleMult;

  const playerCount = lockedSlots.length;
  const baseTotal = WAVE_BASE_COUNT + Math.floor(wave * WAVE_COUNT_SCALE);
  const countMult = wave >= 20 ? 1 + (wave - 19) * 0.05 : 1;  // Halved from 0.1
  const scaledTotal = Math.floor(baseTotal * countMult);
  const totalCount = (soloMode || playerCount === 1) ? scaledTotal : Math.floor(scaledTotal * 0.5);
  const asteroidsPerPlayer = Math.max(1, Math.floor(totalCount / playerCount));
  
  for (let playerIdx = 0; playerIdx < playerCount; playerIdx++) {
    const targetSlot = playerIdx;
    const playerId = lockedSlots[playerIdx];
    const player = players.get(playerId);
    if (!player || player.hp <= 0) continue;
    
    const { x0, x1 } = segmentBounds(targetSlot);
    
    for (let i = 0; i < asteroidsPerPlayer; i++) {
      // MINI-BOSS: 5% chance per minion after wave 10 (not on boss waves)
      if (wave > 10 && Math.random() < 0.05) {
        const x = rand(x0 + 30, x1 - 30);
        const y = rand(-30, -20);
        // Mini-boss has 20% of what a boss would have at this wave
        let miniBossHp = 25 + (wave * 3);
        if (wave > 10) {
          miniBossHp += Math.floor(Math.pow(wave - 10, 1.5) * 3);
        }
        miniBossHp = Math.ceil(miniBossHp * 0.2); // 80% less HP
        spawnQueue.push({ x, y, type: "miniboss", hp: miniBossHp, targetSlot, attackType: null, isMiniBoss: true });
        continue; // Skip normal asteroid
      }
      
      // BERSERKER: 3% chance per minion after wave 15
      if (wave >= 15 && Math.random() < 0.03) {
        const x = rand(x0 + 20, x1 - 20);
        const y = rand(-20, -10);
        const berserkerHp = Math.ceil(3 + waveHpScale * 1.2); // 20% more HP than large
        spawnQueue.push({ x, y, type: "large", hp: berserkerHp, targetSlot, attackType: "berserker" });
        continue; // Skip normal asteroid
      }
      
      let largeChance = Math.min(0.15 + wave * 0.015, 0.30);
      if (wave >= 20) {
        largeChance = Math.min(0.30 + (wave - 19) * 0.02, 0.60);
      }
      const mediumChance = wave >= 20 ? 0.25 : 0.35;
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

      const baseHpVal = type === "large" ? 1.5 : type === "medium" ? 0.75 : 0.4; // Reduced by 50%
      const hp = Math.ceil(baseHpVal + waveHpScale);

      spawnQueue.push({ x, y, type, hp, targetSlot, attackType: null });
    }
  }

  for (const [targetSlot, attacks] of attackQueue.entries()) {
    if (!isSlotAlive(targetSlot)) {
      for (const attack of attacks) {
        const sender = players.get(attack.senderId);
        const attackDef = ATTACK_TYPES[attack.type];
        if (sender && attackDef) {
          sender.gold += attackDef.cost;
          safeSend(sender.ws, { t: "attackRefund", gold: attackDef.cost, reason: "Target eliminated" });
        }
      }
      continue;
    }
    
    const { x0, x1 } = segmentBounds(targetSlot);
    
    for (const attack of attacks) {
      const attackDef = ATTACK_TYPES[attack.type];
      if (!attackDef) continue;

      for (let i = 0; i < attackDef.count; i++) {
        const sizeMap = { small: 10, medium: 13, large: 17 };
        const r = sizeMap[attackDef.size] || 12;
        const x = rand(x0 + r + 30, x1 - r - 30);
        const y = rand(-r - 20, -r);

        const baseAttackHp = attackDef.baseHp + (wave * attackDef.hpScale);
        const attackHp = Math.ceil(baseAttackHp * extremeScaleMult);

        spawnQueue.push({ x, y, type: attackDef.size, hp: attackHp, targetSlot, attackType: attack.type, senderId: attack.senderId });
      }
    }
  }

  for (let i = spawnQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spawnQueue[i], spawnQueue[j]] = [spawnQueue[j], spawnQueue[i]];
  }

  attackQueue.clear();
}

// ===== Game phases =====
function startGame(solo = false) {
  if (phase !== "lobby") return;

  const ids = Array.from(players.keys()).sort((a, b) => slotForPlayer(a) - slotForPlayer(b));
  if (ids.length < 1) return;

  soloMode = solo;
  lockedSlots = ids.slice(0, MAX_PLAYERS);
  recomputeWorld();

  phase = "playing";
  wave = 1;

  upgradePicks = new Map();
  attackQueue = new Map();
  pendingUpgrades = new Map();
  eventQueue = [];
  
  // Reset pause state
  gamePaused = false;
  pauseCountdown = 0;
  pausedBy = null;

  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p) {
      p.upgrades = {};
      p.towers = [null, null, null, null];
      p.gold = 0;
      p.cooldown = 0;
      p.targetX = null;
      p.targetY = null;
      p.manualShooting = false;
      p.turretAngle = -Math.PI / 2;
      p.score = 0;
      p.kills = 0;
      p.damageDealt = 0;
      p.waveDamage = 0;
      p.hp = solo ? 10 : BASE_HP_PER_PLAYER;
      p.maxHp = solo ? 10 : BASE_HP_PER_PLAYER;
      p.ready = false;
      p.lastInterest = 0;
	  p.incomeFromAttacks = 0; // Track income from minions
    }
  }

  spawnWave();
  broadcast({ t: "started", world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, wave, solo: soloMode });
  // Also notify spectators that game started
  for (const ws of spectators) {
    safeSend(ws, { t: "started", world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, wave, solo: soloMode, isSpectator: true });
  }
}

function queueUpgradesAndNextWave() {
  // Check if just finished a boss wave (wave is currently boss wave number)
  const wasBossWave = wave % 10 === 0 && wave > 0;
  
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p || p.hp <= 0) continue;

    // 1. Existing Treasury Interest (10% of current gold, max 100)
    const treasuryInterest = Math.min(100, Math.floor(p.gold * 0.10));

    // 2. New Attack Income (Permanent income from attacks * Gold Multiplier Card)
    const goldMult = p.upgrades?.goldMult ?? 1;
    const attackIncome = Math.floor((p.incomeFromAttacks || 0) * goldMult);

    const totalIncome = treasuryInterest + attackIncome;

    p.lastInterest = totalIncome;
    if (totalIncome > 0) {
      p.gold += totalIncome;
      // Send to client as 'interest' so the UI popup shows the total amount
      safeSend(p.ws, { t: "interest", amount: totalIncome });
    }
    
    // Decrement module lock waves on towers
    for (const tower of p.towers) {
      if (!tower) continue;
      for (let i = 0; i < 3; i++) {
        if (tower.moduleLockWaves[i] > 0) {
          tower.moduleLockWaves[i]--;
        }
      }
    }
  }
  
  // After boss wave: Module card selection instead of normal upgrades
  if (wasBossWave) {
    startModuleCardPhase();
    return; // Don't do normal upgrades or advance wave yet
  }
  
  // Normal upgrade flow
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p || p.hp <= 0) continue;
    
    const options = makeUpgradeOptions(p);
    
    if (!pendingUpgrades.has(id)) {
      pendingUpgrades.set(id, []);
    }
    
    const queue = pendingUpgrades.get(id);
    queue.push({ wave: wave, options, rerollCount: 0 });
    
    if (queue.length === 1) {
      const rerollCost = getRerollCost(0);
      safeSend(p.ws, { t: "upgrade", options, wave: wave, rerollCost, queueSize: queue.length });
    } else {
      safeSend(p.ws, { t: "upgradeQueued", queueSize: queue.length });
    }
  }
  
  wave += 1;
  spawnWave();
  broadcast({ t: "wave", wave });
}

// Start module card selection after boss wave
function startModuleCardPhase() {
  moduleCardPhase = true;
  
  // Generate 5 random module cards
  const shuffled = [...MODULE_IDS].sort(() => Math.random() - 0.5);
  moduleCards = shuffled.slice(0, 5);
  
  // Track which players have picked
  modulePlayersPicked = new Set();
  
  // Determine pick order: boss killer first, then by wave damage
  const alivePlayers = lockedSlots
    .map(id => players.get(id))
    .filter(p => p && p.hp > 0);
  
  // Sort by boss killer first, then wave damage
  alivePlayers.sort((a, b) => {
    if (a.id === bossKillerId) return -1;
    if (b.id === bossKillerId) return 1;
    return (b.waveDamage || 0) - (a.waveDamage || 0);
  });
  
  modulePickOrder = alivePlayers.map(p => p.id);
  currentModulePicker = 0;
  modulePickTimer = MODULE_PICK_TIME;
  
  // Broadcast module card phase start
  broadcast({ 
    t: "moduleCardPhase", 
    cards: moduleCards.map(id => ({ id, ...TOWER_MODULES[id] })),
    pickOrder: modulePickOrder.map(id => {
      const p = players.get(id);
      return { id, name: p?.name || "Unknown", isBossKiller: id === bossKillerId };
    }),
    currentPicker: modulePickOrder[0],
    timeLeft: MODULE_PICK_TIME
  });
}

// End module card selection and proceed to next wave
function endModuleCardPhase() {
  moduleCardPhase = false;
  moduleCards = [];
  modulePickOrder = [];
  modulePlayersPicked = new Set();
  bossKillerId = null;
  
  broadcast({ t: "moduleCardPhaseEnd" });
  
  // Now do normal wave progression (no upgrades after boss)
  wave += 1;
  spawnWave();
  broadcast({ t: "wave", wave });
}

function getRerollCost(rerollCount) {
  const baseCost = 10;
  return Math.floor(baseCost * Math.pow(1.5, rerollCount));
}

function sendNextPendingUpgrade(playerId) {
  const queue = pendingUpgrades.get(playerId);
  if (!queue || queue.length === 0) return;
  
  const p = players.get(playerId);
  if (!p) return;
  
  const next = queue[0];
  const rerollCost = getRerollCost(next.rerollCount);
  safeSend(p.ws, { t: "upgrade", options: next.options, wave: next.wave, rerollCost, queueSize: queue.length });
}

function resetToLobby() {
  try {
    phase = "lobby";
    soloMode = false;
    lockedSlots = null;
    missiles = [];
    bullets = [];
    shieldExplosions = [];
    upgradePicks = new Map();
    attackQueue = new Map();
    pendingUpgrades = new Map();
    eventQueue = [];
    wave = 0;

    // Notify spectators that game ended and they should reconnect to join lobby
    for (const ws of spectators) {
      safeSend(ws, { t: "spectateEnd", reason: "Game ended - reconnect to join lobby" });
    }
    spectators.clear();

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

  if (soloMode || lockedSlots.length === 1) {
    if (alivePlayers.length === 0) {
      endGame(null);
      return true;
    }
    return false;
  }

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
      isWinner: !soloMode && id === winnerId
    };
  }).sort((a, b) => b.score - a.score);

  for (const s of scores) {
    if (s.score > 0) {
      leaderboard.push({
        name: s.name,
        score: s.score,
        kills: s.kills,
        wave: wave,
        date: Date.now(),
        solo: soloMode
      });
    }
  }
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, MAX_LEADERBOARD_ENTRIES);
  saveLeaderboard();

  broadcast({ t: "gameOver", wave, scores, winnerId, solo: soloMode });
  // Also notify spectators
  for (const ws of spectators) {
    safeSend(ws, { t: "gameOver", wave, scores, winnerId, solo: soloMode, wasSpectating: true });
  }

  setTimeout(() => {
    if (phase === "gameover") resetToLobby();
  }, 8000);
}

// ===== Simulation =====
function fireBullet(owner, originX, originY, targetX, targetY, angleOffset = 0, overrideProps = null) {
  let dmg, speed, isCrit, explosive, lifespan, bulletType, ricochet, pierce, chainChance;
  let modules = [];
  let ownerGold = 0;

  if (overrideProps) {
    dmg = overrideProps.damage;
    modules = overrideProps.modules || [];
    ownerGold = overrideProps.ownerGold || 0;
    
    if (overrideProps.inheritedUpgrades) {
      speed = BULLET_SPEED * (overrideProps.bulletSpeedMult ?? 1) * (overrideProps.bulletType === "sniper" ? 1.5 : 1);
      isCrit = Math.random() < (overrideProps.critChance ?? 0);
      explosive = overrideProps.explosive || 0;
      lifespan = BULLET_LIFESPAN + (overrideProps.lifespanAdd ?? 0);
      ricochet = overrideProps.ricochet || 0;
      pierce = overrideProps.pierce || 0;
      chainChance = overrideProps.chainChance || 0;
    } else {
      speed = BULLET_SPEED * (overrideProps.bulletType === "sniper" ? 1.5 : 1);
      isCrit = false;
      explosive = overrideProps.explosive || 0;
      lifespan = BULLET_LIFESPAN;
      ricochet = 0;
      pierce = overrideProps.bulletType === "sniper" ? 1 : 0;
      chainChance = 0;
    }
    
    bulletType = overrideProps.bulletType || "tower";

    if (overrideProps.level) {
      dmg = Math.round(dmg * (1 + (overrideProps.level - 1) * 0.25));
    }
  } else {
    dmg = BULLET_DAMAGE + (owner.upgrades?.damageAdd ?? 0);
    dmg *= (owner.upgrades?.multishotDmgMult ?? 1);
    speed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);
    isCrit = Math.random() < (owner.upgrades?.critChance ?? 0);
    explosive = owner.upgrades?.explosive ?? 0;
    lifespan = BULLET_LIFESPAN; // Removed lifespanAdd
    bulletType = "main";
    ricochet = owner.upgrades?.ricochet || 0;
    pierce = owner.upgrades?.pierce || 0;
    chainChance = owner.upgrades?.chainChance || 0;
    ownerGold = owner.gold || 0;
  }

  let finalDmg = isCrit ? dmg * 3 : dmg;
  let bulletR = bulletType === "sniper" ? 4 : bulletType === "missile" ? 5 : BULLET_R;
  let bulletColor = null;
  
  // Apply module effects on bullet creation
  
  // Confetti Cannon: randomize stats
  if (modules.includes("confettiCannon")) {
    speed *= 0.5 + Math.random() * 2; // 0.5x to 2.5x speed
    finalDmg *= 0.3 + Math.random() * 3; // 0.3x to 3.3x damage
    bulletR = 2 + Math.random() * 8; // 2 to 10 size
    bulletColor = `hsl(${Math.random() * 360}, 100%, 60%)`; // Random color
  }
  
  // Russian Roulette: random 0x-10x damage
  if (modules.includes("russianRoulette")) {
    const rouletteMult = Math.random() * 10; // 0 to 10
    finalDmg *= rouletteMult;
    if (rouletteMult >= 8) {
      queueEvent("rouletteCrit", { x: originX, y: originY });
    }
  }
  
  // Midas Capacitor: add 1% of gold as damage
  if (modules.includes("midasCapacitor")) {
    finalDmg += ownerGold * 0.01;
  }
  
  // Vampiric Nanobots: -50% damage
  if (modules.includes("vampiricNanobots")) {
    finalDmg *= 0.5;
  }

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

  const bullet = {
    id: uid(),
    ownerId: owner.id,
    ownerSlot: owner.slot,
    x: originX,
    y: originY - 6,
    vx, vy,
    r: bulletR,
    dmg: finalDmg,
    isCrit,
    explosive: explosive,
    lifespan: lifespan,
    isTowerBullet: !isPlayerBullet,
    bulletType: bulletType,
    chainChance: chainChance,
    ricochet: ricochet,
    pierce: pierce,
    hitSet: new Set(), // O(1) hit tracking
    modules: modules, // Store modules for hit effects
    bulletColor: bulletColor, // Custom color for confetti
  };
  bullets.push(bullet);
  
  // Emit spawn event for immediate client prediction
  eventQueue.push({
    t: "bulletSpawn",
    id: bullet.id,
    x: bullet.x,
    y: bullet.y,
    vx: bullet.vx,
    vy: bullet.vy,
    slot: bullet.ownerSlot,
    isCrit: bullet.isCrit,
    bulletColor: bullet.bulletColor
  });
}

// PREDICTIVE AIMING: Fire bullets at intercept points, each bullet can target different asteroid
function fireWithMultishot(owner, originX, originY, targetX, targetY, isManual = false) {
  const shots = owner.upgrades?.multishot ?? 1;
  const bulletSpeed = BULLET_SPEED * (owner.upgrades?.bulletSpeedMult ?? 1);
  
  if (isManual) {
    // Manual shooting: all bullets go to cursor with spread
    const spread = 0.10;
    if (shots <= 1) {
      fireBullet(owner, originX, originY, targetX, targetY, 0);
    } else {
      for (let i = 0; i < shots; i++) {
        const offset = (i - (shots - 1) / 2) * spread;
        fireBullet(owner, originX, originY, targetX, targetY, offset);
      }
    }
    return;
  }
  
  // Auto-aim: find targets and calculate intercept points
  const targets = findMultipleTargets(originX, originY, owner.slot, shots);
  
  if (targets.length === 0) {
    // No targets, fire at default position
    fireBullet(owner, originX, originY, targetX, targetY, 0);
    return;
  }
  
  // Fire each bullet at a different target (or cycle through if fewer targets)
  for (let i = 0; i < shots; i++) {
    const target = targets[i % targets.length];
    const intercept = calculateInterceptPoint(originX, originY, bulletSpeed, target);
    
    // Small spread between bullets aimed at same target
    let spread = 0;
    if (targets.length < shots) {
      const sameTargetIndex = Math.floor(i / targets.length);
      spread = (sameTargetIndex - 0.5) * 0.05;
    }
    
    fireBullet(owner, originX, originY, intercept.x, intercept.y, spread);
  }
}

function findBestTarget(x0, x1, turretX, turretY, rangeMult = 1.0, ownerSlot = 0) {
  let best = null;
  let bestScore = -Infinity;
  
  // Use slot bucket instead of all missiles
  const slotMissiles = missilesBySlot[ownerSlot];
  if (!slotMissiles) return null;

  for (let i = 0; i < slotMissiles.length; i++) {
    const m = slotMissiles[i];
    if (m.y < 0) continue;
    
    const danger = m.y / GROUND_Y;
    const dx = m.x - turretX;
    const dy = m.y - turretY;
    // Use squared distance (sqrt not needed for comparison)
    const distSq = dx * dx + dy * dy;
    const score = danger * 1000 - distSq * 0.0001; // Adjusted weight for squared
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

// Find multiple targets for multishot, excluding already-targeted missiles
function findMultipleTargets(turretX, turretY, ownerSlot, count, excludeIds = new Set()) {
  const targets = [];
  
  // Use slot bucket instead of all missiles
  const slotMissiles = missilesBySlot[ownerSlot];
  if (!slotMissiles || slotMissiles.length === 0) return targets;
  
  // Score all valid targets
  const scored = [];
  for (let i = 0; i < slotMissiles.length; i++) {
    const m = slotMissiles[i];
    if (m.dead || m.isPhased) continue;
    if (m.y < 0) continue;
    if (excludeIds.has(m.id)) continue;
    
    const danger = m.y / GROUND_Y;
    const dx = m.x - turretX;
    const dy = m.y - turretY;
    // Use squared distance (sqrt not needed for comparison)
    const distSq = dx * dx + dy * dy;
    const score = danger * 1000 - distSq * 0.0001; // Adjusted weight for squared
    scored.push({ m, score });
  }
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Take top N targets
  for (let i = 0; i < Math.min(count, scored.length); i++) {
    targets.push(scored[i].m);
  }
  
  return targets;
}

// Calculate intercept point for predictive aiming
// Returns where to aim so bullet hits moving target
function calculateInterceptPoint(turretX, turretY, bulletSpeed, target) {
  // Target current position and velocity
  const tx = target.x;
  const ty = target.y;
  const tvx = target.vx || 0;
  const tvy = target.vy || 30; // Default downward velocity
  
  // Vector from turret to target
  const dx = tx - turretX;
  const dy = ty - turretY;
  
  // Quadratic coefficients for intercept time:
  // |target_pos + target_vel * t - turret_pos| = bullet_speed * t
  // (tvx² + tvy² - bulletSpeed²)t² + 2(dx*tvx + dy*tvy)t + (dx² + dy²) = 0
  const a = tvx * tvx + tvy * tvy - bulletSpeed * bulletSpeed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;
  
  let t = 0;
  
  if (Math.abs(a) < 0.001) {
    // Linear case (bullet speed ≈ target speed)
    if (Math.abs(b) > 0.001) {
      t = -c / b;
    }
  } else {
    // Quadratic case
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtD = Math.sqrt(discriminant);
      const t1 = (-b - sqrtD) / (2 * a);
      const t2 = (-b + sqrtD) / (2 * a);
      
      // Pick smallest positive time
      if (t1 > 0.01 && t2 > 0.01) {
        t = Math.min(t1, t2);
      } else if (t1 > 0.01) {
        t = t1;
      } else if (t2 > 0.01) {
        t = t2;
      }
    }
  }
  
  // Clamp intercept time to reasonable range
  t = Math.max(0, Math.min(t, 3.0)); // Max 3 seconds prediction
  
  // Calculate intercept point
  return {
    x: tx + tvx * t,
    y: ty + tvy * t
  };
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

// OPTIMIZED: Create explosion - now also queues event for client
function createExplosion(x, y, radius, color) {
  // Queue event for client-side rendering
  queueEvent("explosion", { x, y, radius, color });
}

// OPTIMIZED: Add damage number - queues event for client
function addDamageNumber(x, y, amount, isCrit) {
  // Queue event for client-side rendering
  queueEvent("damage", { x, y, amount, isCrit });
}

function bounceOffWalls(m) {
  const { x0, x1 } = segmentBounds(m.targetSlot);
  if (m.x - m.r < x0) { m.x = x0 + m.r; m.vx = Math.abs(m.vx); }
  if (m.x + m.r > x1) { m.x = x1 - m.r; m.vx = -Math.abs(m.vx); }
}

function tick() {
  if (phase !== "playing") return;

  try {
    tickCount++;
    
    // Handle pause countdown
    if (pauseCountdown > 0) {
      pauseCountdown -= DT;
      if (pauseCountdown <= 0) {
        pauseCountdown = 0;
        gamePaused = false;
        pausedBy = null;
        broadcast({ t: "gameResumed" });
      }
      // Still broadcast state during countdown, but skip game logic
      broadcastGameState();
      return;
    }
    
    // Skip all game logic while paused (but still broadcast)
    if (gamePaused) {
      broadcastGameState();
      return;
    }
    
    // Module card pick timer
    if (moduleCardPhase) {
      modulePickTimer -= DT;
      if (modulePickTimer <= 0) {
        // Time's up for current picker, skip to next
        currentModulePicker++;
        modulePickTimer = MODULE_PICK_TIME;
        
        if (currentModulePicker >= modulePickOrder.length || moduleCards.length === 0) {
          endModuleCardPhase();
        } else {
          broadcast({ 
            t: "modulePickTurn", 
            playerId: modulePickOrder[currentModulePicker], 
            timeLeft: MODULE_PICK_TIME,
            remainingCards: moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }))
          });
        }
      }
    }
    
    // Process spawn queue
    if (spawnQueue.length > 0) {
      spawnTimer -= DT;
      if (spawnTimer <= 0) {
        const spawnCount = Math.min(spawnQueue.length, Math.random() < 0.5 ? 1 : Math.random() < 0.8 ? 2 : 3);
        for (let i = 0; i < spawnCount && spawnQueue.length > 0; i++) {
          const queued = spawnQueue.shift();
          missiles.push(createAsteroid(
            queued.x, queued.y, queued.type, queued.hp, queued.targetSlot, 
            queued.attackType, queued.senderId, null, false, queued.isMiniBoss || false
          ));
        }
        spawnTimer = 0.1 + Math.random() * 0.4;
      }
    }

    // SPATIAL PARTITIONING: Bucket missiles by slot BEFORE any targeting/collision
    // This makes all target finding and collision O(n) per slot instead of O(n) total
    for (let s = 0; s < 4; s++) missilesBySlot[s].length = 0;
    for (let i = 0; i < missiles.length; i++) {
      const m = missiles[i];
      if (!m.dead && m.targetSlot >= 0 && m.targetSlot < 4) {
        missilesBySlot[m.targetSlot].push(m);
      }
    }

    // Player shooting
    for (const id of lockedSlots) {
      const p = players.get(id);
      if (!p || p.hp <= 0) continue;

      p.cooldown = Math.max(0, (p.cooldown ?? 0) - DT);

      const slot = p.slot;
      const { x0, x1 } = segmentBounds(slot);
      const pos = turretPositions(slot);
      const baseCooldown = BULLET_COOLDOWN / (p.upgrades?.fireRateMult ?? 1);

      let targetX, targetY, clamped;
      const bulletSpeed = BULLET_SPEED * (p.upgrades?.bulletSpeedMult ?? 1);
      let mainTarget = null; // Store target to avoid double lookup
      
      if (p.manualShooting && p.targetX != null && p.targetY != null) {
        clamped = clampAimAngle(pos.main.x, pos.main.y, p.targetX, p.targetY);
        targetX = clamped.x;
        targetY = clamped.y;
      } else {
        mainTarget = findBestTarget(x0, x1, pos.main.x, pos.main.y, 1.0, p.slot);
        if (mainTarget) {
          // Calculate intercept point for turret visual
          const intercept = calculateInterceptPoint(pos.main.x, pos.main.y, bulletSpeed, mainTarget);
          clamped = clampAimAngle(pos.main.x, pos.main.y, intercept.x, intercept.y);
        } else {
          clamped = clampAimAngle(pos.main.x, pos.main.y, pos.main.x, 50);
        }
        targetX = clamped.x;
        targetY = clamped.y;
      }
      p.turretAngle = clamped.angle;
      const shouldFire = p.manualShooting || mainTarget; // Reuse stored target
      if (shouldFire && p.cooldown <= 0) {
        p.cooldown = baseCooldown;
        fireWithMultishot(p, pos.main.x, pos.main.y, clamped.x, clamped.y, p.manualShooting);
      }

      // Tower shooting - use simple for loop instead of forEach
      if (p.towers) {
        const towers = p.towers;
        for (let idx = 0; idx < towers.length; idx++) {
          const tower = towers[idx];
          if (!tower) continue;
          const towerPos = pos.slots[idx];
          if (!towerPos) continue;

          const stats = TOWER_TYPES[tower.type];
          if (!stats) continue;

          const rangeMult = stats.rangeMult || 1.0;
          const target = findBestTarget(x0, x1, towerPos.x, towerPos.y, rangeMult, p.slot);
          
          if (target) {
            // Calculate bullet speed for this tower
            const u = p.upgrades || {};
            const towerBulletSpeed = BULLET_SPEED * (1 + ((u.bulletSpeedMult ?? 1) - 1) * 0.5) * (stats.bulletType === "sniper" ? 1.5 : 1);
            
            // Calculate intercept point for tower
            const intercept = calculateInterceptPoint(towerPos.x, towerPos.y, towerBulletSpeed, target);
            const aim = clampAimAngle(towerPos.x, towerPos.y, intercept.x, intercept.y);
            tower.angle = aim.angle;
            
            if (tower.cd <= 0) {
              const levelBonus = 1 + (tower.level - 1) * 0.15;
              const fireRateBonus = ((p.upgrades?.fireRateMult ?? 1) - 1) * 0.5 + 1;
              tower.cd = stats.cooldown / levelBonus / fireRateBonus;
              
              // Collect active modules on this tower (simple loop instead of filter)
              const activeModules = [];
              if (tower.modules) {
                for (let mi = 0; mi < tower.modules.length; mi++) {
                  if (tower.modules[mi] !== null) activeModules.push(tower.modules[mi]);
                }
              }
              
              const towerProps = {
                ...stats,
                level: tower.level,
                damage: stats.damage + (u.damageAdd ?? 0) * 0.5,
                bulletSpeedMult: 1 + ((u.bulletSpeedMult ?? 1) - 1) * 0.5,
                critChance: (u.critChance ?? 0) * 0.5,
                explosive: (stats.explosive || 0) + Math.floor((u.explosive ?? 0) * 0.5),
                lifespanAdd: (u.lifespanAdd ?? 0) * 0.5,
                ricochet: Math.floor((u.ricochet ?? 0) * 0.5),
                pierce: (stats.bulletType === "sniper" ? 1 : 0) + Math.floor((u.pierce ?? 0) * 0.5),
                chainChance: (u.chainChance ?? 0) * 0.5,
                inheritedUpgrades: true,
                modules: activeModules, // Tower modules
                ownerGold: p.gold, // For Midas Capacitor
              };
              fireBullet(p, towerPos.x, towerPos.y, aim.x, aim.y, 0, towerProps);
            }
          } else {
            tower.angle = -Math.PI / 2;
          }
          
          tower.cd = Math.max(0, (tower.cd || 0) - DT);
        }
      }
    }

    // Pre-compute which slots have slowfield active (avoid nested loop)
    const slowfieldSlots = [];
    for (const id of lockedSlots) {
      const p = players.get(id);
      if (p?.upgrades?.slowfield) {
        const { x0, x1 } = segmentBounds(p.slot);
        slowfieldSlots.push({ x0, x1 });
      }
    }

    // Update missiles
    for (const m of missiles) {
      if (m.phaseTimer !== null) {
        m.phaseTimer += DT;
        m.isPhased = Math.sin(m.phaseTimer * 4) > 0.5;
      }

      if (m.inFTL) {
        // Bosses and boss ads use faster FTL
        const isBossType = m.isBoss || m.isBossAd;
        const ftlSpeed = isBossType ? 25 : 12; // Much faster FTL entry
        m.y += m.vy * DT * ftlSpeed;
        m.x += m.vx * DT * 0.3;
        // Rotation is handled client-side
        
        if (m.y >= m.ftlThreshold) {
          m.inFTL = false;
          createExplosion(m.x, m.y, isBossType ? 25 : 15, isBossType ? "#f44" : "#88f");
        }
        continue;
      }

      let speedMult = 1;
      for (let si = 0; si < slowfieldSlots.length; si++) {
        const sf = slowfieldSlots[si];
        if (m.x >= sf.x0 && m.x <= sf.x1) { speedMult = 0.75; break; }
      }
      
      m.x += m.vx * DT * speedMult;
      m.y += m.vy * DT * speedMult;
      // Rotation is handled client-side
      
      // Carrier: Spawns mini asteroids periodically
      if (m.isCarrier && m.carrierSpawnTimer !== null && !m.inFTL) {
        m.carrierSpawnTimer -= DT;
        if (m.carrierSpawnTimer <= 0) {
          // Spawn mini asteroids
          const spawnCount = ATTACK_TYPES.carrier?.spawnCount || 2;
          for (let i = 0; i < spawnCount; i++) {
            const offsetX = (Math.random() - 0.5) * 30;
            const miniHp = 0.25 + wave * 0.075; // Reduced by 50% base, 25% scaling
            const mini = createAsteroid(
              m.x + offsetX, 
              m.y + m.r, 
              "small", 
              miniHp, 
              m.targetSlot, 
              null, // No attack type - just regular small asteroid
              m.senderId,
              null, // No boss variant
              true  // noGold - carrier minions give no gold
            );
            mini.inFTL = false; // Spawn immediately, no FTL effect
            mini.vy = Math.abs(m.vy) * 1.2; // Slightly faster than parent
            missiles.push(mini);
          }
          // Reset timer
          m.carrierSpawnTimer = ATTACK_TYPES.carrier?.spawnInterval || 2.0;
          // Visual feedback
          createExplosion(m.x, m.y + m.r, 15, ATTACK_TYPES.carrier?.color || "#ff00ff");
        }
      }
      
      bounceOffWalls(m);
      
      // Shield sphere collision check (dome above ground)
      if (!m.dead && m.targetSlot !== undefined) {
        const targetSlot = m.targetSlot;
        for (const id of lockedSlots) {
          const p = players.get(id);
          if (!p || p.slot !== targetSlot || !p.upgrades?.shieldActive || p.upgrades.shieldActive <= 0) continue;
          
          // Shield dome center is at bottom center of segment
          const shieldCenterX = targetSlot * SEGMENT_W + SEGMENT_W / 2;
          const shieldCenterY = GROUND_Y;
          const shieldRadius = SEGMENT_W * SHIELD_RADIUS_MULT;
          
          // Check if asteroid touches shield dome (only top half - above ground)
          const dx = m.x - shieldCenterX;
          const dy = m.y - shieldCenterY;
          const distSq = dx * dx + dy * dy;
          const touchRadius = shieldRadius + m.r;
          
          // Only trigger if within dome and asteroid is above ground level
          if (distSq <= touchRadius * touchRadius && m.y < GROUND_Y) {
            // Shield blocks the asteroid!
            m.dead = true;
            p.upgrades.shieldActive--;
            
            // Create shield explosion effect (deals damage for 3 seconds)
            const explosionDamage = BULLET_DAMAGE * 2; // 200% of base damage
            shieldExplosions.push({
              x: m.x,
              y: m.y,
              radius: 0,
              maxRadius: 60,
              damage: explosionDamage,
              duration: 3.0,
              life: 3.0,
              slot: targetSlot,
              color: PLAYER_COLORS[targetSlot]?.main || "#0ff",
              hitSet: new Set() // O(1) hit tracking
            });
            
            // Visual explosion
            createExplosion(m.x, m.y, 40, PLAYER_COLORS[targetSlot]?.main || "#0ff");
            queueEvent("shieldHit", { x: m.x, y: m.y, slot: targetSlot });
            break;
          }
        }
      }
      
      if (m.y + m.r >= GROUND_Y) {
        const targetSlot = m.targetSlot;
        
        if (isSlotAlive(targetSlot)) {
          m.dead = true;
          
          // Boss ads don't deal damage (punishment is lost gold opportunity)
          if (m.isBossAd) {
            createExplosion(m.x, GROUND_Y - 5, 25, "#ff6600");
            // No damage, just despawn
          } 
          // Boss deals 10 damage, reduced by shield
          else if (m.type === "boss") {
            for (const id of lockedSlots) {
              const p = players.get(id);
              if (p && p.slot === targetSlot) {
                let bossDamage = 10;
                const shieldCount = p.upgrades?.shieldActive || 0;
                
                // Shield reduces boss damage (each shield absorbs 1 damage)
                if (shieldCount > 0) {
                  const absorbed = Math.min(shieldCount, bossDamage);
                  p.upgrades.shieldActive -= absorbed;
                  bossDamage -= absorbed;
                  createExplosion(m.x, GROUND_Y - 5, 40, "#0ff");
                }
                
                if (bossDamage > 0) {
                  const wasAlive = p.hp > 0;
                  p.hp = Math.max(0, p.hp - bossDamage);
                  createExplosion(m.x, GROUND_Y - 5, 60, "#ff0000");
                  
                  if (wasAlive && p.hp <= 0) {
                    redistributeAsteroids(targetSlot);
                  }
                }
                break;
              }
            }
          }
          // Normal asteroids deal 1 damage, shield blocks entirely
          else {
            let blocked = false;
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
            
            if (!blocked) {
              for (const id of lockedSlots) {
                const p = players.get(id);
                if (p && p.slot === targetSlot) {
                  const damage = 1;
                  const wasAlive = p.hp > 0;
                  p.hp = Math.max(0, p.hp - damage);
                  createExplosion(m.x, GROUND_Y - 5, 40, "#f44");
                  
                  if (wasAlive && p.hp <= 0) {
                    redistributeAsteroids(targetSlot);
                  }
                  
                  // Gold reward for attacker if this was a player-sent attack
                  if (m.senderId && m.attackType) {
                    const sender = players.get(m.senderId);
                    if (sender && sender.hp > 0) {
                      const goldReward = Math.ceil(5 + wave * 0.5);
                      sender.gold += goldReward;
                      safeSend(sender.ws, { t: "attackHit", gold: goldReward, target: p.name });
                    }
                  }
                  break;
                }
              }
            }
          }
        } else {
          m.dead = true;
        }
      }
    }

    // Bullet update (no homing - predictive aiming handles targeting)
    for (const b of bullets) {
      b.x += b.vx * DT;
      b.y += b.vy * DT;

      b.lifespan -= DT;
      if (b.lifespan <= 0) { b.dead = true; continue; }

      let didRicochet = false;
      
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
      if (didRicochet && b.hitSet) b.hitSet.clear();
    }

    // Buckets already built above before player shooting

    // Bullet-missile collision (now O(bullets × missiles_per_slot) instead of O(bullets × all_missiles))
    for (const b of bullets) {
      if (b.dead) continue;
      const slot = b.ownerSlot;
      const slotMissiles = missilesBySlot[slot];
      if (!slotMissiles) continue;
      
      for (let mi = 0; mi < slotMissiles.length; mi++) {
        const m = slotMissiles[mi];
        if (m.isPhased && Math.random() > 0.3) continue;
        if (b.hitSet && b.hitSet.has(m.id)) continue; // O(1) Set lookup
        const dx = m.x - b.x;
        const dy = m.y - b.y;
        const rr = m.r + b.r;
        if (dx * dx + dy * dy <= rr * rr) {
          m.hp -= b.dmg;

          // BOSS MECHANIC: Spawn 5 minions at 75%, 50%, 25% HP (3 times total)
          if (m.type === "boss" && m.bossSpawnCount < 3) {
            const hpPercent = m.hp / m.maxHp;
            const nextThreshold = 1 - ((m.bossSpawnCount + 1) * 0.25); // 0.75, 0.50, 0.25
            if (hpPercent <= nextThreshold) {
              m.bossSpawnCount++;
              for(let k=0; k<5; k++) {
                const bossAdVariant = (k % 5) + 1; // Cycle through 1-5
                missiles.push(createAsteroid(
                  m.x + rand(-50, 50), 
                  m.y + rand(20, 100), 
                  "medium", 
                  Math.max(2, wave), 
                  m.targetSlot,
                  null,  // attackType
                  null,  // senderId
                  bossAdVariant,  // bossAdVariant (1-5)
                  false  // Boss ads give 1 gold each
                ));
              }
              createExplosion(m.x, m.y, 60, "#ff0000");
            }
          }
          
          // MINI-BOSS MECHANIC: Spawn 3 smaller minions at 75%, 50%, 25% HP (3 times total)
          if (m.isMiniBoss && m.bossSpawnCount < 3) {
            const hpPercent = m.hp / m.maxHp;
            const nextThreshold = 1 - ((m.bossSpawnCount + 1) * 0.25); // 0.75, 0.50, 0.25
            if (hpPercent <= nextThreshold) {
              m.bossSpawnCount++;
              for(let k=0; k<3; k++) {
                // Smaller minions for mini-boss (minibossAd type)
                const miniAdHp = Math.max(1, Math.ceil(wave * 0.3)); // Less HP than boss ads
                const miniAd = createAsteroid(
                  m.x + rand(-25, 25), 
                  m.y + rand(10, 40), 
                  "minibossAd", 
                  miniAdHp, 
                  m.targetSlot,
                  null,  // attackType
                  null,  // senderId
                  null,  // bossAdVariant
                  false  // Gives 1 gold each
                );
                miniAd.isMiniBossAd = true;
                miniAd.inFTL = false; // Spawn immediately
                missiles.push(miniAd);
              }
              createExplosion(m.x, m.y, 30, "#ff4400");
            }
          }
          
          // BERSERKER MECHANIC: Speed up when hit (max 2x speed at low HP)
          if (m.isBerserker && m.hp > 0) {
            const hpPercent = m.hp / m.maxHp;
            const speedBoost = 1 + (1 - hpPercent) * 1.5; // 1x at full HP, up to 2.5x at low HP
            const baseSpeed = Math.abs(m.vy) / speedBoost; // Get original base speed
            m.vy = (m.vy > 0 ? 1 : -1) * baseSpeed * speedBoost;
            // Also slightly increase horizontal movement
            m.vx = m.vx * 1.02;
          }

          if (!b.hitSet) b.hitSet = new Set();
          b.hitSet.add(m.id);
          
          // ===== TOWER MODULE EFFECTS ON HIT =====
          const bulletModules = b.modules || [];
          const owner = players.get(b.ownerId);
          
          // Fractal Prism: Shatter into 3 smaller bullets behind target
          if (bulletModules.includes("fractalPrism")) {
            for (let i = 0; i < 3; i++) {
              const angle = Math.PI + (i - 1) * 0.5; // Spread behind
              const shardVx = Math.cos(angle) * 100;
              const shardVy = Math.sin(angle) * 100;
              bullets.push({
                id: uid(),
                ownerId: b.ownerId,
                ownerSlot: b.ownerSlot,
                x: m.x,
                y: m.y,
                vx: shardVx,
                vy: shardVy,
                r: 2,
                dmg: b.dmg * 0.3,
                isCrit: false,
                explosive: 0,
                lifespan: 1.0,
                isTowerBullet: true,
                bulletType: "shard",
                chainChance: 0,
                ricochet: 0,
                pierce: 0,
                hitSet: new Set([m.id]), // Already hit source target
                modules: [],
                bulletColor: "#00ffff",
              });
            }
          }
          
          // Quantum Displacer: 20% chance to teleport enemy to top
          if (bulletModules.includes("quantumDisplacer") && Math.random() < 0.2 && m.hp > 0) {
            m.y = -m.r - 20;
            m.inFTL = true;
            queueEvent("teleport", { x: m.x, y: m.y });
          }
          
          // Gravity Well: Create gravity pull effect
          if (bulletModules.includes("gravityWell") && m.hp > 0) {
            gravityWells.push({
              x: m.x,
              y: m.y,
              targetId: m.id,
              life: 2.0,
              radius: 100,
              strength: 80,
              ownerSlot: b.ownerSlot
            });
            queueEvent("gravityWell", { x: m.x, y: m.y });
          }
          
          // Vampiric Nanobots: Accumulate damage for healing
          if (bulletModules.includes("vampiricNanobots") && owner) {
            owner.lifestealAccum = (owner.lifestealAccum || 0) + b.dmg * 2; // x2 because we halved damage
            if (owner.lifestealAccum >= 100) {
              const heals = Math.floor(owner.lifestealAccum / 100);
              owner.hp = Math.min(owner.maxHp, owner.hp + heals);
              owner.lifestealAccum = owner.lifestealAccum % 100;
              queueEvent("lifesteal", { slot: owner.slot, amount: heals });
            }
          }
          
          // Matter Compressor: Shrink enemy
          if (bulletModules.includes("matterCompressor") && m.hp > 0) {
            m.r *= 0.9; // Shrink 10%
            if (m.r < 5) {
              m.hp = 0; // Instakill if too small
              queueEvent("compressed", { x: m.x, y: m.y });
            }
          }
          
          // Chain Reaction: Add static charge
          if (bulletModules.includes("chainReaction") && m.hp > 0) {
            m.staticCharge = (m.staticCharge || 0) + b.dmg;
            m.staticColor = "#ffff00";
          }
          
          // Tesla Coil: chance to consume bullet and create chain lightning
          const triggeredLightning = b.chainChance > 0 && Math.random() < b.chainChance;
          
          if (triggeredLightning) {
            // Consume bullet and hit 3 nearest enemies with lightning
            b.dead = true;
            
            // Find 3 nearest enemies (excluding current target) - use slot bucket
            const lightningTargets = [];
            const rangeSq = 150 * 150; // Squared lightning range
            const slotMissilesLightning = missilesBySlot[b.ownerSlot];
            for (let li = 0; li < slotMissilesLightning.length; li++) {
              const m2 = slotMissilesLightning[li];
              if (m2.dead || m2 === m) continue;
              const dx = m2.x - m.x;
              const dy = m2.y - m.y;
              const dSq = dx * dx + dy * dy;
              if (dSq < rangeSq) { // Use squared distance
                lightningTargets.push({ m: m2, dSq });
              }
            }
            lightningTargets.sort((a, b) => a.dSq - b.dSq); // Sort by squared distance (same order)
            
            // Hit up to 3 targets with lightning (same damage as bullet)
            const chainPoints = [{ x: m.x, y: m.y }]; // Start from hit asteroid
            const owner = players.get(b.ownerId);
            for (let i = 0; i < Math.min(3, lightningTargets.length); i++) {
              const target = lightningTargets[i].m;
              target.hp -= b.dmg;
              addDamageNumber(target.x, target.y - target.r, b.dmg, b.isCrit);
              chainPoints.push({ x: target.x, y: target.y });
              
              if (owner) {
                owner.damageDealt = (owner.damageDealt || 0) + b.dmg;
                owner.waveDamage = (owner.waveDamage || 0) + b.dmg;
                owner.score = (owner.score || 0) + Math.round(b.dmg * 10);
              }
              
              if (target.hp <= 0) {
                target.dead = true;
                createExplosion(target.x, target.y, 20, "#0ff");
                if (owner) {
                  owner.score = (owner.score || 0) + 50;
                  owner.kills = (owner.kills || 0) + 1;
                }
              }
            }
            
            // Send lightning event to clients for visual effect
            if (chainPoints.length > 1) {
              queueEvent("lightning", { 
                points: chainPoints, 
                isCrit: b.isCrit,
                slot: b.ownerSlot
              });
            }
          } else {
            // Normal bullet behavior
            if (b.pierce > 0) { b.pierce--; } else { b.dead = true; }
          }
          
          addDamageNumber(m.x, m.y - m.r, b.dmg, b.isCrit);
          
          if (owner) {
            owner.damageDealt = (owner.damageDealt || 0) + b.dmg;
            owner.waveDamage = (owner.waveDamage || 0) + b.dmg;
          }
          
          if (m.hp <= 0) {
            m.dead = true;
            createExplosion(m.x, m.y, 25, ATTACK_TYPES[m.attackType]?.color || "#fa0");
            
            // Necromancer Drive: Create ghost ally on kill
            if (bulletModules.includes("necromancerDrive")) {
              ghostAllies.push({
                x: m.x,
                y: m.y,
                r: m.r * 0.8,
                vy: -60, // Flies upward
                life: 5.0,
                damage: b.dmg * 0.5,
                ownerSlot: b.ownerSlot,
                hitSet: new Set() // O(1) hit tracking
              });
              queueEvent("ghostSpawn", { x: m.x, y: m.y, slot: b.ownerSlot });
            }
            
            if (owner) {
              owner.score = (owner.score || 0) + 50;
              owner.kills = (owner.kills || 0) + 1;
              // Boss ads give 1 gold each (reward for clearing them)
              if (m.isBossAd) {
                owner.gold = (owner.gold || 0) + 1;
              }
              // Mini-boss ads give 1 gold each
              else if (m.isMiniBossAd) {
                owner.gold = (owner.gold || 0) + 1;
              }
              // Mini-boss gives 5 gold
              else if (m.isMiniBoss) {
                owner.gold = (owner.gold || 0) + 5;
                owner.score = (owner.score || 0) + 100; // Bonus score
              }
              // Berserker gives 3 gold
              else if (m.isBerserker) {
                owner.gold = (owner.gold || 0) + 3;
              }
              // No gold for attack asteroids OR spawned minions (splitter/carrier)
              else if (!m.attackType && !m.noGold) {
                const goldMult = owner.upgrades?.goldMult ?? 1;
                const goldReward = m.type === "large" ? 4 : m.type === "medium" ? 2 : 1;
                owner.gold = (owner.gold || 0) + Math.round(goldReward * goldMult);
              }
            }
            
            // When mini-boss dies, spawn any remaining minion waves
            if (m.isMiniBoss && m.bossSpawnCount < 3) {
              const remainingSpawns = 3 - m.bossSpawnCount;
              for (let spawnWave = 0; spawnWave < remainingSpawns; spawnWave++) {
                for (let k = 0; k < 3; k++) {
                  const miniAdHp = Math.max(1, Math.ceil(wave * 0.3));
                  const miniAd = createAsteroid(
                    m.x + rand(-25, 25),
                    m.y + rand(10, 40),
                    "minibossAd",
                    miniAdHp,
                    m.targetSlot,
                    null,
                    null,
                    null,
                    false
                  );
                  miniAd.isMiniBossAd = true;
                  miniAd.inFTL = false;
                  missiles.push(miniAd);
                }
              }
              createExplosion(m.x, m.y, 40, "#ff4400");
            }
            
            // When boss dies, spawn any remaining minion waves
            if (m.type === "boss" && m.bossSpawnCount < 3) {
              // Track who killed the boss for module pick order
              if (owner && !bossKillerId) {
                bossKillerId = owner.id;
                broadcast({ t: "bossKilled", killerId: owner.id, killerName: owner.name });
              }
              
              const remainingSpawns = 3 - m.bossSpawnCount;
              for (let spawnWave = 0; spawnWave < remainingSpawns; spawnWave++) {
                for (let k = 0; k < 5; k++) {
                  const bossAdVariant = (k % 5) + 1;
                  const spawnedAd = createAsteroid(
                    m.x + rand(-50, 50),
                    m.y + rand(20, 100),
                    "medium",
                    Math.max(2, wave),
                    m.targetSlot,
                    null,
                    null,
                    bossAdVariant,
                    false // Boss ads CAN give gold (1 each)
                  );
                  missiles.push(spawnedAd);
                }
              }
              createExplosion(m.x, m.y, 80, "#ff0000");
            }
            // Also track boss killer if no remaining spawns
            else if (m.type === "boss" && owner && !bossKillerId) {
              bossKillerId = owner.id;
              broadcast({ t: "bossKilled", killerId: owner.id, killerName: owner.name });
            }
            
            // Splitter: spawn children with noGold flag
            if (m.splits > 0) {
              const extremeMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
              const splitHp = Math.ceil((0.5 + wave * 0.3) * extremeMult); // Reduced by 50% base, 25% scaling
              for (let s = 0; s < m.splits; s++) {
                const nx = m.x + rand(-30, 30);
                const ny = m.y + rand(-20, 20);
                const splitAsteroid = createAsteroid(nx, ny, "small", splitHp, m.targetSlot, null, m.senderId, null, true); // noGold=true
                missiles.push(splitAsteroid);
              }
            }
          } else {
            if (owner) owner.score = (owner.score || 0) + Math.round(b.dmg * 10);
          }
          
          if (b.explosive > 0) {
            createExplosion(b.x, b.y, 35, "#fa0");
            // Use slot bucket instead of all missiles
            const explosiveSlotMissiles = missilesBySlot[b.ownerSlot];
            for (let ei = 0; ei < explosiveSlotMissiles.length; ei++) {
              const m2 = explosiveSlotMissiles[ei];
              if (m2.dead || m2 === m) continue;
              const dx = m2.x - b.x;
              const dy = m2.y - b.y;
              const touchR = 35 + m2.r;
              if (dx * dx + dy * dy < touchR * touchR) { m2.hp -= 1; if (m2.hp <= 0) m2.dead = true; }
            }
          }
          createExplosion(b.x, b.y, 15, b.isCrit ? "#ff0" : "#0ff");
          if (b.dead) break;
        }
      }
    }

    // Shield explosion update - expanding damage zones
    for (const exp of shieldExplosions) {
      exp.life -= DT;
      
      // Expand radius over first 0.5 seconds
      if (exp.radius < exp.maxRadius) {
        exp.radius = Math.min(exp.maxRadius, exp.radius + (exp.maxRadius * DT * 2));
      }
      
      // Deal damage to asteroids in radius (once per asteroid) - use slot bucket
      const expSlotMissiles = missilesBySlot[exp.slot];
      if (expSlotMissiles) {
        for (let ei = 0; ei < expSlotMissiles.length; ei++) {
          const m = expSlotMissiles[ei];
          if (m.dead || exp.hitSet.has(m.id)) continue;
          
          const dx = m.x - exp.x;
          const dy = m.y - exp.y;
          const combinedR = exp.radius + m.r;
          
          if (dx * dx + dy * dy <= combinedR * combinedR) {
            m.hp -= exp.damage;
            exp.hitSet.add(m.id);
            createExplosion(m.x, m.y, 15, exp.color);
            
            if (m.hp <= 0) {
              m.dead = true;
              createExplosion(m.x, m.y, 25, "#fff");
            }
          }
        }
      }
    }
    
    // OPTIMIZED: O(1) removal for shield explosions
    let seWriteIdx = 0;
    for (let i = 0; i < shieldExplosions.length; i++) {
      if (shieldExplosions[i].life > 0) {
        shieldExplosions[seWriteIdx++] = shieldExplosions[i];
      }
    }
    shieldExplosions.length = seWriteIdx;

    // Ghost Ally update - fly upward and damage enemies
    for (const ghost of ghostAllies) {
      ghost.y += ghost.vy * DT;
      ghost.life -= DT;
      
      // Check for collision with enemies in owner's slot
      const ghostSlotMissiles = missilesBySlot[ghost.ownerSlot];
      if (ghostSlotMissiles) {
        for (let gi = 0; gi < ghostSlotMissiles.length; gi++) {
          const m = ghostSlotMissiles[gi];
          if (m.dead || ghost.hitSet.has(m.id)) continue;
          const dx = m.x - ghost.x;
          const dy = m.y - ghost.y;
          const combinedR = ghost.r + m.r;
          
          if (dx * dx + dy * dy < combinedR * combinedR) {
            m.hp -= ghost.damage;
            ghost.hitSet.add(m.id);
            createExplosion(m.x, m.y, 15, "#8844ff");
            addDamageNumber(m.x, m.y - m.r, ghost.damage, false);
            
            if (m.hp <= 0) {
              m.dead = true;
              createExplosion(m.x, m.y, 20, "#8844ff");
            }
          }
        }
      }
    }
    // OPTIMIZED: O(1) removal for ghost allies
    let gaWriteIdx = 0;
    for (let i = 0; i < ghostAllies.length; i++) {
      const g = ghostAllies[i];
      if (g.life > 0 && g.y > -50) {
        ghostAllies[gaWriteIdx++] = g;
      }
    }
    ghostAllies.length = gaWriteIdx;
    
    // Gravity Well update - pull nearby enemies
    for (const well of gravityWells) {
      well.life -= DT;
      const radiusSq = well.radius * well.radius;
      
      // Pull nearby enemies toward the well center - use slot bucket
      const wellSlotMissiles = missilesBySlot[well.ownerSlot];
      if (wellSlotMissiles) {
        for (let wi = 0; wi < wellSlotMissiles.length; wi++) {
          const m = wellSlotMissiles[wi];
          if (m.dead) continue;
          const dx = well.x - m.x;
          const dy = well.y - m.y;
          const distSq = dx * dx + dy * dy;
          
          // Quick squared distance check before expensive sqrt
          if (distSq < radiusSq && distSq > 25) { // 25 = 5*5
            const dist = Math.sqrt(distSq);
            const pullStrength = (well.strength / dist) * DT;
            m.x += (dx / dist) * pullStrength;
            m.y += (dy / dist) * pullStrength;
          }
        }
      }
    }
    // OPTIMIZED: O(1) removal for gravity wells
    let gwWriteIdx = 0;
    for (let i = 0; i < gravityWells.length; i++) {
      if (gravityWells[i].life > 0) {
        gravityWells[gwWriteIdx++] = gravityWells[i];
      }
    }
    gravityWells.length = gwWriteIdx;
    
    // Chain Reaction - check for static charged asteroid collisions
    // OPTIMIZED: Only check within same slot (missiles can't leave their slot)
    for (let slot = 0; slot < 4; slot++) {
      const slotMissiles = missilesBySlot[slot];
      if (!slotMissiles || slotMissiles.length < 2) continue;
      
      for (let i = 0; i < slotMissiles.length; i++) {
        const m1 = slotMissiles[i];
        if (m1.dead || !m1.staticCharge) continue;
        
        // Only check missiles after this one to avoid double-checking pairs
        for (let j = i + 1; j < slotMissiles.length; j++) {
          const m2 = slotMissiles[j];
          if (m2.dead) continue;
          
          const dx = m2.x - m1.x;
          const dy = m2.y - m1.y;
          const combinedR = m1.r + m2.r + 5;
          
          if (dx * dx + dy * dy < combinedR * combinedR) {
            // Both take massive damage
            const staticDamage = m1.staticCharge;
            m1.hp -= staticDamage;
            m2.hp -= staticDamage;
            
            createExplosion((m1.x + m2.x) / 2, (m1.y + m2.y) / 2, 30, "#ffff00");
            addDamageNumber(m1.x, m1.y - m1.r, staticDamage, true);
            addDamageNumber(m2.x, m2.y - m2.r, staticDamage, true);
            
            // Transfer charge to m2 if it survives
            if (m2.hp > 0) {
              m2.staticCharge = (m2.staticCharge || 0) + staticDamage * 0.5;
            }
            
            // Clear charge from m1
            m1.staticCharge = 0;
            
            if (m1.hp <= 0) { m1.dead = true; createExplosion(m1.x, m1.y, 20, "#ffff00"); }
            if (m2.hp <= 0) { m2.dead = true; createExplosion(m2.x, m2.y, 20, "#ffff00"); }
            
            queueEvent("staticDischarge", { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 });
            break; // Only one collision per frame per charged asteroid
          }
        }
      }
    }

    // OPTIMIZED: O(1) removal using swap-and-pop instead of O(n) splice
    // This prevents O(n²) behavior when many missiles die at once
    let writeIdx = 0;
    for (let i = 0; i < missiles.length; i++) {
      if (!missiles[i].dead) {
        missiles[writeIdx++] = missiles[i];
      }
    }
    missiles.length = writeIdx;
    
    // Same for bullets
    writeIdx = 0;
    for (let i = 0; i < bullets.length; i++) {
      if (!bullets[i].dead) {
        bullets[writeIdx++] = bullets[i];
      }
    }
    bullets.length = writeIdx;

    if (checkGameOver()) return;

    // Don't trigger wave clear during module card selection
    if (!moduleCardPhase && missiles.length === 0 && spawnQueue.length === 0) {
      if (waveClearedTime === 0) {
        waveClearedTime = Date.now();
      } else if (Date.now() - waveClearedTime >= WAVE_CLEAR_DELAY) {
        waveClearedTime = 0;
        queueUpgradesAndNextWave();
      }
    } else if (!moduleCardPhase) {
      waveClearedTime = 0;
    }

    // SERVER AUTHORITATIVE: Broadcast every tick (30Hz) - no client prediction
    // OPTIMIZED: Reuse pre-allocated broadcastState to avoid GC pressure
    if (tickCount % BROADCAST_INTERVAL === 0) {
      broadcastGameState();
    }
  } catch (err) {
    console.error("Game loop error:", err);
  }
}

function broadcastGameState() {
  // Update scalar fields
  broadcastState.ts = Date.now();
  broadcastState.phase = phase;
  broadcastState.wave = wave;
  broadcastState.spectatorCount = spectators.size;
  broadcastState.world.width = worldW;
  broadcastState.world.segmentWidth = SEGMENT_W;
  broadcastState.moduleCardPhase = moduleCardPhase;
  broadcastState.modulePickTimer = moduleCardPhase ? modulePickTimer : 0;
  broadcastState.currentModulePicker = moduleCardPhase ? modulePickOrder[currentModulePicker] : null;
  
  // Add module cards to state so clients always have them (fixes issue with backed up upgrades)
  broadcastState.moduleCards = moduleCardPhase ? moduleCards.map(id => ({ id, ...TOWER_MODULES[id] })) : [];
  broadcastState.modulePickOrder = moduleCardPhase ? modulePickOrder.map(id => {
    const p = players.get(id);
    return { id, name: p?.name || "Unknown", isBossKiller: id === bossKillerId };
  }) : [];
  
  // Add pause state
  broadcastState.gamePaused = gamePaused;
  broadcastState.pauseCountdown = pauseCountdown;
  broadcastState.pausedBy = pausedBy;
  
  // Fill missiles array (reuse existing objects)
  const missileCount = missiles.length;
  // Grow array if needed
  while (broadcastState.missiles.length < missileCount) {
    broadcastState.missiles.push({});
  }
  for (let i = 0; i < missileCount; i++) {
    const m = missiles[i];
    const obj = broadcastState.missiles[i];
    obj.id = m.id;
    obj.x = Math.round(m.x * 10) / 10;
    obj.y = Math.round(m.y * 10) / 10;
    obj.r = m.r;
    obj.hp = Math.round(m.hp * 10) / 10;
    obj.maxHp = m.maxHp;
    obj.type = m.type;
    obj.vx = Math.round(m.vx * 10) / 10;
    obj.vy = Math.round(m.vy * 10) / 10;
    obj.inFTL = m.inFTL;
    // Optional fields - set or delete
    if (m.attackType) obj.attackType = m.attackType; else delete obj.attackType;
    if (m.isPhased) obj.isPhased = true; else delete obj.isPhased;
    if (m.isBoss) obj.isBoss = true; else delete obj.isBoss;
    if (m.isBossAd) { obj.isBossAd = true; obj.bossAdVariant = m.bossAdVariant; } 
    else { delete obj.isBossAd; delete obj.bossAdVariant; }
    if (m.isMiniBoss) obj.isMiniBoss = true; else delete obj.isMiniBoss;
    if (m.isMiniBossAd) obj.isMiniBossAd = true; else delete obj.isMiniBossAd;
    if (m.isBerserker) obj.isBerserker = true; else delete obj.isBerserker;
    if (m.staticCharge > 0) obj.staticCharge = m.staticCharge; else delete obj.staticCharge;
  }
  // Truncate array to actual size (JSON.stringify respects .length)
  broadcastState.missiles.length = missileCount;
  
  // Fill bullets array
  const bulletCount = bullets.length;
  while (broadcastState.bullets.length < bulletCount) {
    broadcastState.bullets.push({});
  }
  for (let i = 0; i < bulletCount; i++) {
    const b = bullets[i];
    const obj = broadcastState.bullets[i];
    obj.id = b.id;
    obj.x = Math.round(b.x * 10) / 10;
    obj.y = Math.round(b.y * 10) / 10;
    obj.r = b.r;
    obj.vx = Math.round(b.vx * 10) / 10;
    obj.vy = Math.round(b.vy * 10) / 10;
    obj.slot = b.ownerSlot;
    obj.lifespan = Math.round(b.lifespan * 10) / 10;
    if (b.isCrit) obj.isCrit = true; else delete obj.isCrit;
    if (b.isTowerBullet) obj.isTower = true; else delete obj.isTower;
    if (b.bulletType && b.bulletType !== "gatling") obj.bulletType = b.bulletType; else delete obj.bulletType;
    if (b.bulletColor) obj.bulletColor = b.bulletColor; else delete obj.bulletColor;
  }
  broadcastState.bullets.length = bulletCount;
  
  // Events - just reference the queue (will be cleared after)
  broadcastState.events = eventQueue;
  
  // Fill shieldExplosions
  const seCount = shieldExplosions.length;
  while (broadcastState.shieldExplosions.length < seCount) {
    broadcastState.shieldExplosions.push({});
  }
  for (let i = 0; i < seCount; i++) {
    const exp = shieldExplosions[i];
    const obj = broadcastState.shieldExplosions[i];
    obj.x = Math.round(exp.x);
    obj.y = Math.round(exp.y);
    obj.radius = Math.round(exp.radius);
    obj.maxRadius = exp.maxRadius;
    obj.life = Math.round(exp.life * 10) / 10;
    obj.duration = exp.duration;
    obj.color = exp.color;
    obj.slot = exp.slot;
  }
  broadcastState.shieldExplosions.length = seCount;
  
  // Fill ghostAllies
  const gaCount = ghostAllies.length;
  while (broadcastState.ghostAllies.length < gaCount) {
    broadcastState.ghostAllies.push({});
  }
  for (let i = 0; i < gaCount; i++) {
    const g = ghostAllies[i];
    const obj = broadcastState.ghostAllies[i];
    obj.x = Math.round(g.x);
    obj.y = Math.round(g.y);
    obj.r = Math.round(g.r);
    obj.life = Math.round(g.life * 10) / 10;
    obj.ownerSlot = g.ownerSlot;
  }
  broadcastState.ghostAllies.length = gaCount;
  
  // Fill gravityWells
  const gwCount = gravityWells.length;
  while (broadcastState.gravityWells.length < gwCount) {
    broadcastState.gravityWells.push({});
  }
  for (let i = 0; i < gwCount; i++) {
    const w = gravityWells[i];
    const obj = broadcastState.gravityWells[i];
    obj.x = Math.round(w.x);
    obj.y = Math.round(w.y);
    obj.radius = w.radius;
    obj.life = Math.round(w.life * 10) / 10;
  }
  broadcastState.gravityWells.length = gwCount;
  
  // Fill players
  const playerCount = lockedSlots.length;
  while (broadcastState.players.length < playerCount) {
    broadcastState.players.push({ upgrades: {} });
  }
  for (let i = 0; i < playerCount; i++) {
    const id = lockedSlots[i];
    const p = players.get(id);
    const obj = broadcastState.players[i];
    if (!p) {
      obj.id = id;
      obj.slot = -1;
      continue;
    }
    const u = p.upgrades || {};
    obj.id = p.id;
    obj.slot = p.slot;
    obj.name = p.name || `Player ${p.slot + 1}`;
    obj.score = p.score || 0;
    obj.gold = p.gold || 0;
    obj.hp = p.hp;
    obj.maxHp = p.maxHp;
    obj.turretAngle = p.turretAngle || -Math.PI / 2;
    obj.isManual = !!p.manualShooting;
    obj.towers = p.towers;
    obj.inventory = p.inventory || [];
    obj.kills = p.kills || 0;
    obj.damageDealt = p.damageDealt || 0;
    obj.waveDamage = p.waveDamage || 0;
    obj.lastInterest = p.lastInterest || 0;
    obj.shieldActive = u.shieldActive || 0;
    obj.slowfield = !!u.slowfield;
    // Reuse upgrades object
    obj.upgrades.damageAdd = u.damageAdd || 0;
    obj.upgrades.bulletSpeedMult = u.bulletSpeedMult || 1;
    obj.upgrades.fireRateMult = u.fireRateMult || 1;
    obj.upgrades.multishot = u.multishot || 1;
    obj.upgrades.critChance = u.critChance || 0;
    obj.upgrades.explosive = u.explosive || 0;
    obj.upgrades.pierce = u.pierce || 0;
    obj.upgrades.chainChance = u.chainChance || 0;
    obj.upgrades.goldMult = u.goldMult || 1;
  }
  broadcastState.players.length = playerCount;
  
  broadcastAll(broadcastState);
  
  // Clear event queue after broadcast
  eventQueue = [];
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
  
  // Check if they can join as a player
  const canJoinAsPlayer = phase === "lobby" && assignSlot() >= 0;
  
  // If game in progress or full, offer spectator mode
  if (!canJoinAsPlayer) {
    const reason = phase !== "lobby" ? "Game in progress" : "Game full (max 4)";
    safeSend(ws, { 
      t: "spectateOffer", 
      reason,
      canSpectate: phase === "playing",
      spectatorCount: spectators.size
    });
    
    // Set up spectator message handler
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      
      if (msg.t === "spectate" && phase === "playing") {
        // Add as spectator
        spectators.add(ws);
        safeSend(ws, { 
          t: "spectateStart",
          world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W },
          wave,
          attackTypes: ATTACK_TYPES,
          spectatorCount: spectators.size
        });
        // Notify players of new spectator
        broadcast({ t: "spectatorUpdate", count: spectators.size });
      }
    });
    
    ws.on("close", () => {
      if (spectators.has(ws)) {
        spectators.delete(ws);
        broadcast({ t: "spectatorUpdate", count: spectators.size });
      }
    });
    return;
  }
  
  // Normal player join
  const slot = assignSlot();
  const id = uid();
  const player = {
    id, ws, slot,
    name: `Player ${slot + 1}`,
    targetX: 0, targetY: 0,
    manualShooting: false,
    upgrades: {},
    towers: [null, null, null, null],
    inventory: [], // Module cards in player's inventory
    lifestealAccum: 0, // Accumulated damage for vampiric nanobots
    gold: 0, cooldown: 0, score: 0, ready: false, damageDealt: 0, waveDamage: 0,
    hp: BASE_HP_PER_PLAYER,
    maxHp: BASE_HP_PER_PLAYER,
    kills: 0,
    lastInterest: 0,
  };

  players.set(id, player);
  if (!hostId) hostId = id;

  recomputeWorld();
  safeSend(ws, { 
    t: "welcome", id, slot, isHost: id === hostId, 
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, 
    phase,
    attackTypes: ATTACK_TYPES,
    towerModules: TOWER_MODULES
  });
  safeSend(ws, { t: "chatHistory", messages: chatHistory });
  broadcast({ t: "lobby", ...lobbySnapshot() });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    if (msg.t === "setName") {
      p.name = (msg.name || "").toString().slice(0, 16).trim() || p.name;
      broadcastLobby();
      return;
    }
    if (msg.t === "ready" && phase === "lobby") {
      p.ready = !p.ready;
      broadcastLobby();
      return;
    }
    if (msg.t === "becomeSpectator" && phase === "lobby") {
      // Player wants to become a spectator, freeing their slot
      const playerWs = p.ws;
      players.delete(id);
      
      // Reassign slots for remaining players
      const remaining = Array.from(players.values()).sort((a, b) => a.slot - b.slot);
      remaining.forEach((pl, i) => { pl.slot = i; });
      
      // Update host if needed
      if (hostId === id) {
        hostId = players.size > 0 ? Array.from(players.keys())[0] : null;
      }
      
      recomputeWorld();
      
      // Add to spectators
      spectators.add(playerWs);
      
      // Notify the new spectator
      safeSend(playerWs, { 
        t: "becameSpectator",
        spectatorCount: spectators.size
      });
      
      // Set up spectator disconnect handler
      playerWs.removeAllListeners("message");
      playerWs.on("message", (data) => {
        // Spectators in lobby can only chat
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.t === "chat" && msg.text) {
          const chatMsg = {
            id: uid(),
            from: "👁 Spectator",
            text: msg.text.toString().slice(0, 200),
            timestamp: Date.now()
          };
          chatHistory.push(chatMsg);
          if (chatHistory.length > 50) chatHistory.shift();
          broadcast({ t: "chatMsg", ...chatMsg });
          for (const ws of spectators) safeSend(ws, { t: "chatMsg", ...chatMsg });
        }
      });
      
      playerWs.on("close", () => {
        spectators.delete(playerWs);
        broadcastAll({ t: "spectatorUpdate", count: spectators.size });
      });
      
      // Update lobby for everyone (including spectators)
      broadcastLobby();
      broadcastAll({ t: "spectatorUpdate", count: spectators.size });
      return;
    }
    if (msg.t === "start") {
      if (phase === "lobby" && p.ready) {
        const snap = lobbySnapshot();
        if (snap.allReady) startGame();
      }
      return;
    }
    if (msg.t === "forceStart") {
      if (phase === "lobby" && p.ready) {
        const readyPlayers = Array.from(players.entries()).filter(([_, pl]) => pl.ready);
        if (readyPlayers.length >= 1) {
          const idlePlayers = Array.from(players.entries()).filter(([_, pl]) => !pl.ready);
          for (const [idleId, idlePlayer] of idlePlayers) {
            safeSend(idlePlayer.ws, { t: "kicked", reason: "Game started without you (idle)" });
            idlePlayer.ws.close();
            players.delete(idleId);
          }
          const remaining = Array.from(players.values()).sort((a, b) => a.slot - b.slot);
          remaining.forEach((pl, i) => { pl.slot = i; });
          if (!players.has(hostId)) {
            hostId = players.size > 0 ? Array.from(players.keys())[0] : null;
          }
          recomputeWorld();
          startGame();
        }
      }
      return;
    }
    if (msg.t === "startSolo") {
      if (phase === "lobby") {
        startGame(true);
      }
      return;
    }
    if (msg.t === "input" && phase === "playing") {
      p.targetX = Number(msg.x) || 0;
      p.targetY = Number(msg.y) || 0;
      p.manualShooting = !!msg.shooting;
      return;
    }

    if (msg.t === "pickUpgrade" && phase === "playing") {
      const pickKey = (msg.key || "").toString();
      const queue = pendingUpgrades.get(id);
      if (!queue || queue.length === 0) return;
      
      const current = queue[0];
      const opt = current.options.find((o) => o.key === pickKey);
      if (!opt) return;
      
      applyUpgrade(p, opt);
      safeSend(p.ws, { t: "picked", key: pickKey });
      
      queue.shift();
      
      if (queue.length > 0) {
        const next = queue[0];
        const rerollCost = getRerollCost(next.rerollCount);
        safeSend(p.ws, { t: "upgrade", options: next.options, wave: next.wave, rerollCost, queueSize: queue.length });
      } else {
        safeSend(p.ws, { t: "upgradeQueueEmpty" });
      }
      return;
    }

    if (msg.t === "rerollUpgrades" && phase === "playing") {
      const queue = pendingUpgrades.get(id);
      if (!queue || queue.length === 0) return;
      
      const current = queue[0];
      const rerollCost = getRerollCost(current.rerollCount);
      
      if (p.gold < rerollCost) {
        safeSend(p.ws, { t: "rerollFailed", reason: "Not enough gold" });
        return;
      }
      
      p.gold -= rerollCost;
      current.rerollCount++;
      
      const newOptions = makeUpgradeOptions(p);
      current.options = newOptions;
      
      const nextRerollCost = getRerollCost(current.rerollCount);
      
      safeSend(p.ws, { 
        t: "upgrade", 
        options: newOptions, 
        wave: current.wave,
        rerollCost: nextRerollCost,
        goldSpent: rerollCost,
        queueSize: queue.length
      });
      return;
    }

    if (msg.t === "buyUpgrade" && phase === "playing") {
      if (!pendingUpgrades.has(id)) {
        pendingUpgrades.set(id, []);
      }
      const queue = pendingUpgrades.get(id);
      
      const cost = msg.cost || 30;
      if (p.gold < cost) {
        safeSend(p.ws, { t: "buyUpgradeFailed", reason: "Not enough gold" });
        return;
      }
      
      p.gold -= cost;
      
      const newEventOptions = makeUpgradeOptions(p);
      
      const newEntry = { 
        wave: wave, 
        options: newEventOptions, 
        rerollCount: 0,
        isPurchased: true
      };
      
      queue.unshift(newEntry);
      
      const nextRerollCost = getRerollCost(0);
      safeSend(p.ws, { 
        t: "upgrade", 
        options: newEventOptions, 
        wave: wave,
        rerollCost: nextRerollCost, 
        goldSpent: cost,
        queueSize: queue.length 
      });
      return;
    }

    if (msg.t === "returnToLobby" && phase === "gameover") {
      resetToLobby();
      return;
    }

    if (msg.t === "chat") {
      const text = (msg.text || "").toString().trim();
      if (text.length === 0 || text.length > 200) return;
      const chatMsg = addChatMessage(p.name, text);
      broadcast({ t: "chatMsg", ...chatMsg });
      return;
    }

    if (msg.t === "clearLeaderboard") {
      const password = process.env.LEADERBOARD_PASSWORD || "1122";
      if (msg.password === password) {
        leaderboard = [];
        saveLeaderboard();
        broadcast({ t: "lobby", ...lobbySnapshot() });
      }
      return;
    }

    // Pause game - any player can pause
    if (msg.t === "pauseGame" && phase === "playing" && !gamePaused && pauseCountdown <= 0) {
      gamePaused = true;
      pausedBy = p.name || `Player ${p.slot + 1}`;
      broadcast({ t: "gamePaused", pausedBy });
      return;
    }

    // Unpause game - any player can unpause, starts 5 second countdown
    if (msg.t === "unpauseGame" && phase === "playing" && gamePaused && pauseCountdown <= 0) {
      pauseCountdown = 5.0; // 5 second countdown
      broadcast({ t: "gameUnpausing", countdown: 5 });
      return;
    }

    if (msg.t === "buyAttack" && (phase === "playing" || phase === "upgrades")) {
      const { attackType, quantity } = msg;
      if (!ATTACK_TYPES[attackType]) return;
      
      const validTargets = lockedSlots.filter(pid => {
        if (pid === id) return false;
        const targetPlayer = players.get(pid);
        return targetPlayer && targetPlayer.hp > 0;
      });
      
      if (validTargets.length === 0) {
        safeSend(ws, { t: "attackFailed", reason: "No valid targets" });
        return;
      }
      
      const unitCost = ATTACK_TYPES[attackType].cost;
      
      let toBuy = 1;
      if (quantity === "max") {
        toBuy = Math.floor(p.gold / unitCost);
      } else if (quantity === 10) {
        toBuy = Math.min(10, Math.floor(p.gold / unitCost));
      } else {
        toBuy = p.gold >= unitCost ? 1 : 0;
      }
      
      if (toBuy <= 0) return;
      
      const totalCost = unitCost * toBuy;
      p.gold -= totalCost;
      
      // Add 10% of spent money to permanent income
      p.incomeFromAttacks = (p.incomeFromAttacks || 0) + (totalCost * 0.10);
      
      for (let i = 0; i < toBuy; i++) {
        const targetId = validTargets[Math.floor(Math.random() * validTargets.length)];
        const targetPlayer = players.get(targetId);
        const targetSlot = targetPlayer.slot;
        
        if (!attackQueue.has(targetSlot)) {
          attackQueue.set(targetSlot, []);
        }
        attackQueue.get(targetSlot).push({ type: attackType, senderId: id });
        
        if (i === 0 && targetPlayer.ws) {
          safeSend(targetPlayer.ws, { t: "incomingAttack", attackType, from: p.name, count: toBuy });
        }
      }
      
      safeSend(ws, { t: "attackQueued", attackType, count: toBuy, totalCost });
      return;
    }

    if (msg.t === "buyTower" && phase === "playing") {
      const { slotIndex, type } = msg;
      if (!TOWER_TYPES[type]) return;
      if (slotIndex < 0 || slotIndex > 3) return;
      if (p.towers[slotIndex]) return;
      const cost = TOWER_TYPES[type].cost;
      if (p.gold >= cost) { 
        p.gold -= cost; 
        p.towers[slotIndex] = { 
          type, 
          level: 1, 
          cd: 0,
          modules: [null, null, null], // 3 module slots
          moduleLockWaves: [0, 0, 0] // Waves remaining until module can be removed
        }; 
      }
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
      // Return modules to inventory when selling tower
      for (let i = 0; i < 3; i++) {
        if (tower.modules[i]) {
          p.inventory.push(tower.modules[i]);
        }
      }
      p.gold += Math.floor(totalInvested * 0.5);
      p.towers[slotIndex] = null;
    }

    // Slot a module from inventory into a tower
    if (msg.t === "slotModule" && phase === "playing") {
      const { towerIndex, moduleSlot, inventoryIndex } = msg;
      if (towerIndex < 0 || towerIndex > 3) return;
      if (moduleSlot < 0 || moduleSlot > 2) return;
      if (inventoryIndex < 0 || inventoryIndex >= p.inventory.length) return;
      
      const tower = p.towers[towerIndex];
      if (!tower) return;
      if (tower.modules[moduleSlot]) return; // Slot already filled
      
      const moduleId = p.inventory[inventoryIndex];
      if (!TOWER_MODULES[moduleId]) return;
      
      // Move module from inventory to tower
      p.inventory.splice(inventoryIndex, 1);
      tower.modules[moduleSlot] = moduleId;
      tower.moduleLockWaves[moduleSlot] = 3; // Locked for 3 waves
      
      safeSend(ws, { t: "moduleSlotted", towerIndex, moduleSlot, moduleId });
    }

    // Remove a module from tower (only if not locked)
    if (msg.t === "unslotModule" && phase === "playing") {
      const { towerIndex, moduleSlot } = msg;
      if (towerIndex < 0 || towerIndex > 3) return;
      if (moduleSlot < 0 || moduleSlot > 2) return;
      
      const tower = p.towers[towerIndex];
      if (!tower) return;
      if (!tower.modules[moduleSlot]) return; // No module to remove
      if (tower.moduleLockWaves[moduleSlot] > 0) {
        safeSend(ws, { t: "moduleError", error: `Module locked for ${tower.moduleLockWaves[moduleSlot]} more waves` });
        return;
      }
      
      // Move module back to inventory
      p.inventory.push(tower.modules[moduleSlot]);
      tower.modules[moduleSlot] = null;
      
      safeSend(ws, { t: "moduleUnslotted", towerIndex, moduleSlot });
    }

    // Pick a module card during boss reward phase
    if (msg.t === "pickModuleCard" && moduleCardPhase) {
      const { cardIndex } = msg;
      if (cardIndex < 0 || cardIndex >= moduleCards.length) return;
      if (modulePickOrder[currentModulePicker] !== p.id) return; // Not your turn
      if (modulePlayersPicked.has(p.id)) return; // Already picked
      
      const moduleId = moduleCards[cardIndex];
      if (!TOWER_MODULES[moduleId]) return;
      
      // Mark player as picked
      modulePlayersPicked.add(p.id);
      
      // Add to player's inventory
      p.inventory.push(moduleId);
      
      // Remove from available cards
      moduleCards.splice(cardIndex, 1);
      
      // Announce pick and send updated card list
      broadcast({ 
        t: "moduleCardPicked", 
        playerId: p.id, 
        playerName: p.name, 
        moduleId, 
        cardIndex,
        remainingCards: moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }))
      });
      
      // Move to next picker
      currentModulePicker++;
      modulePickTimer = MODULE_PICK_TIME;
      
      // Check if all done or no cards left
      if (currentModulePicker >= modulePickOrder.length || moduleCards.length === 0) {
        endModuleCardPhase();
      } else {
        // Notify next picker
        broadcast({ 
          t: "modulePickTurn", 
          playerId: modulePickOrder[currentModulePicker], 
          timeLeft: MODULE_PICK_TIME,
          remainingCards: moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }))
        });
      }
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
      const idx = lockedSlots.indexOf(id);
      if (idx !== -1) {
        checkGameOver();
      }
      return;
    }

    recomputeWorld();
    broadcast({ t: "lobby", ...lobbySnapshot() });
  });
});

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Rogue Asteroid PvP (OPTIMIZED v2 - 15Hz): http://localhost:${PORT}`); });