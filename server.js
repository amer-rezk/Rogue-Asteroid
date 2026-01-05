// server.js - Rogue Asteroid PvP (SERVER AUTHORITATIVE v5)
// Competitive asteroid defense with attack purchasing
// 
// ARCHITECTURE:
// - Server physics at 60Hz, broadcasts at ~30Hz (optimized for dedicated hosting)
// - Client renders with interpolation for smooth visuals
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

// ===== PERFORMANCE TUNING =====
// Adjust these values based on your server's capabilities
// Higher values = smoother gameplay but more CPU/bandwidth

// TICK RATES
const TICK_RATE = 60;          // Physics updates per second (was 45)
const BROADCAST_RATE = 30;     // Network updates per second (was 22)
const DT = 1 / TICK_RATE;
const BROADCAST_INTERVAL = Math.floor(TICK_RATE / BROADCAST_RATE); // = 2 ticks

// RATE LIMITING
const MIN_INPUT_INTERVAL = 16; // Minimum ms between inputs (was 20, now 60Hz)

// ENTITY CAPS
const MAX_MISSILES = 300;      // Max asteroids/enemies on screen (was 150)
const MAX_BULLETS = 400;       // Max player bullets (was 120)

// EVENT THROTTLING (per tick)
const MAX_BULLET_EVENTS_SMALL = 100;  // Max bullet spawn events with <3 players (was 60)
const MAX_BULLET_EVENTS_LARGE = 80;   // Max bullet spawn events with 3+ players (was 40)
const MAX_VISUAL_EVENTS = 30;         // Max explosion/damage events per tick (was 20)

// ===== Game constants =====
const MAX_PLAYERS = 4;

const WORLD_H = 600;
const GROUND_Y = 560;
const SEGMENT_W = 360;

// PRE-ALLOCATED BROADCAST STATE - reused every frame to avoid GC pressure
const broadcastState = {
  t: "state",
  ts: 0,
  phase: "",
  wave: 0,
  gravityMult: 1, // Per-wave gravity increase
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
for (let i = 0; i < 250; i++) broadcastState.missiles.push({});
for (let i = 0; i < 150; i++) broadcastState.bullets.push({});
for (let i = 0; i < 15; i++) broadcastState.shieldExplosions.push({});
for (let i = 0; i < 30; i++) broadcastState.ghostAllies.push({});
for (let i = 0; i < 15; i++) broadcastState.gravityWells.push({});
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
  1: { name: "Railgun", cost: 120, damage: 4, cooldown: 1.4, rangeMult: 1.5, color: "#00ff00", upgradeCost: 80, bulletType: "sniper" },
  2: { name: "Missile", cost: 250, damage: 8, cooldown: 2.0, rangeMult: 1.0, color: "#ff0000", explosive: 1, upgradeCost: 150, bulletType: "missile" }
};
const MAX_TOWER_LEVEL = 5;

// ===== PvP Attack Units =====
const ATTACK_TYPES = {
  swarm: { name: "Swarm", cost: 25, count: 3, baseHp: 0.025, hpScale: 0.28, size: "small", speed: 1.3, desc: "3 fast weak asteroids", color: "#ffcc00", icon: "🐝" },
  bruiser: { name: "Bruiser", cost: 35, count: 1, baseHp: 3.75, hpScale: 1.125, size: "large", speed: 0.6, desc: "Very tanky asteroid", color: "#ff4444", icon: "🪨" },
  carrier: { name: "Carrier", cost: 60, count: 1, baseHp: 3, hpScale: 0.975, size: "large", speed: 0.5, spawner: true, spawnInterval: 2.0, spawnCount: 2, desc: "Spawns minions!", color: "#ff00ff", icon: "👑" },
  splitter: { name: "Splitter", cost: 50, count: 1, baseHp: 2.5, hpScale: 0.975, size: "large", speed: 0.75, splits: 15, desc: "Splits into 15 on death", color: "#00ffff", icon: "💎" },
  ghost: { name: "Ghost", cost: 40, count: 2, baseHp: 1, hpScale: 0.9, size: "medium", speed: 1.1, phasing: true, desc: "2 phasing asteroids", color: "#8800ff", icon: "👻" },
  berserker: { name: "Berserker", cost: 100, count: 1, baseHp: 3, hpScale: 1.2, size: "large", speed: 0.8, desc: "Speeds up when damaged!", color: "#ff2200", icon: "🔥" }
};

// ===== Tower Modules (Boss Rewards) =====
// SYNERGY DESIGN PHILOSOPHY:
// Modules should work TOGETHER! When a bullet spawns child bullets (shards, ricochets),
// those children should inherit the parent's modules so effects can chain and combo.
// Example combos that should work:
// - Fractal Prism + Viral Payload = shards can infect enemies
// - Fractal Prism + Taxman = shards generate gold on hit
// - Ricochet + Viral = bouncing bullets spread infection
// - Pinball Wizard + Vampiric = each bounce heals you
// IMPORTANT: When adding new modules or bullet-spawning effects, ALWAYS pass modules
// to child bullets! The only exception is preventing infinite recursion (e.g. shards
// should NOT inherit Fractal Prism or they'd spawn infinite shards).
const TOWER_MODULES = {
  fractalPrism: {
    id: "fractalPrism",
    name: "Fractal Prism",
    icon: "💎",
    color: "#00ffff",
    desc: "Bullets shatter into 4 smaller bullets on hit",
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
    desc: "10% chance to teleport enemy back to top (5% for bosses)",
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
    desc: "-50% damage, heal 1 HP per 200 damage dealt",
    effect: "lifesteal"
  },
  feedbackLoop: {
    id: "feedbackLoop",
    name: "Feedback Loop",
    icon: "🔄",
    color: "#00ffcc",
    desc: "+15% fire rate per module on this tower",
    effect: "feedbackLoop"
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
    desc: "PARTY MODE! Random shapes, colors & stats! 🎊",
    effect: "random"
  },
  pinballWizard: {
    id: "pinballWizard",
    name: "Pinball Wizard",
    icon: "🎱",
    color: "#ff6600",
    desc: "Bullets bounce off enemies to hit nearby targets",
    effect: "enemyRicochet"
  },
  taxman: {
    id: "taxman",
    name: "The Taxman",
    icon: "🏦",
    color: "#00aa00",
    desc: "-90% damage, but +0.1 gold per hit. Farm enemies!",
    effect: "goldFarm"
  },
  viralPayload: {
    id: "viralPayload",
    name: "Viral Payload",
    icon: "🦠",
    color: "#00ff00",
    desc: "Infects enemies with spreading DOT virus",
    effect: "infect"
  },
  copycat: {
    id: "copycat",
    name: "Copycat",
    icon: "🪞",
    color: "#aaaaff",
    desc: "Mirrors main turret at 75% effectiveness",
    effect: "mirror"
  },
  executionerSight: {
    id: "executionerSight",
    name: "Executioner's Sight",
    icon: "⚖️",
    color: "#880000",
    desc: "Enemies below 30% HP take 300% damage",
    effect: "execute"
  },
  bloodthirster: {
    id: "bloodthirster",
    name: "Bloodthirster Engine",
    icon: "🩸",
    color: "#cc0044",
    desc: "+1% fire rate per 1% HP missing",
    effect: "berserker"
  },
  temporalBoomerang: {
    id: "temporalBoomerang",
    name: "Temporal Boomerang",
    icon: "🪃",
    color: "#8844cc",
    desc: "Bullets reverse direction at max range",
    effect: "boomerang"
  },
  droneCommand: {
    id: "droneCommand",
    name: "Drone Command",
    icon: "🛸",
    color: "#44aaff",
    desc: "Attack drone orbits and fires at enemies",
    effect: "drone"
  },
  momentumLens: {
    id: "momentumLens",
    name: "Momentum Lens",
    icon: "🔭",
    color: "#ffaa00",
    desc: "+10% damage per 100 pixels traveled",
    effect: "momentum"
  }
};

const MODULE_IDS = Object.keys(TOWER_MODULES);

// ===== DEATH MODS SYSTEM =====
// Dead players earn "spite" currency and can spend it to make life harder for living players
const DEATH_MODS = {
  meteorShower: {
    id: "meteorShower",
    name: "Meteor Shower",
    icon: "☄️",
    cost: 2,
    desc: "Spawn 8 extra asteroids for all players",
    duration: 0 // Instant
  },
  speedDemon: {
    id: "speedDemon",
    name: "Speed Demon",
    icon: "💨",
    cost: 3,
    desc: "All enemies move 50% faster for 10 seconds",
    duration: 10
  },
  curseOfGreed: {
    id: "curseOfGreed",
    name: "Curse of Greed",
    icon: "💸",
    cost: 4,
    desc: "Steal 15% gold from each living player",
    duration: 0 // Instant
  },
  shieldBreaker: {
    id: "shieldBreaker",
    name: "Shield Breaker",
    icon: "💔",
    cost: 5,
    desc: "All living players take 3 damage to their base",
    duration: 0 // Instant
  },
  chaosRift: {
    id: "chaosRift",
    name: "Chaos Rift",
    icon: "🌀",
    cost: 7,
    desc: "Summon a mini-boss for each living player",
    duration: 0 // Instant
  }
};

// Active death mod effects (timed effects)
let activeDeathMods = {
  speedDemon: { active: false, endTime: 0 }
};

// ===== GAME MODIFIERS SYSTEM =====
// Random game-altering rules selected at the start of each game
const GAME_MODIFIERS = {
  noMobs: {
    id: "noMobs",
    name: "Pacifist Protocol",
    icon: "🕊️",
    color: "#88ffaa",
    desc: "Attack units are DISABLED this game. Focus on defense!",
    flavor: "\"Sometimes the best offense is no offense at all.\""
  },
  sideswiped: {
    id: "sideswiped",
    name: "Sideswiped",
    icon: "↔️",
    color: "#ff8844",
    desc: "Enemies spawn from the SIDES in diagonal trajectories!",
    flavor: "\"They're coming from... everywhere?!\""
  },
  elusiveness: {
    id: "elusiveness",
    name: "Quantum Drift",
    icon: "👻",
    color: "#aa88ff",
    desc: "After 5s alive, enemies have 15%/s chance to teleport sideways!",
    flavor: "\"Now you see me, now you don't.\""
  },
  standard: {
    id: "standard",
    name: "Standard Rules",
    icon: "📋",
    color: "#aaaaaa",
    desc: "No modifiers active. Classic gameplay!",
    flavor: "\"Just like the good old days.\""
  }
};

const GAME_MODIFIER_IDS = Object.keys(GAME_MODIFIERS).filter(id => id !== "standard");
let activeGameModifier = null; // Current game's modifier

// ===== Server state =====
const app = express();
app.use(express.static(path.join(__dirname, "docs")));
// Music folder is inside docs/ for GitHub Pages compatibility
app.use("/Music", express.static(path.join(__dirname, "docs", "Music")));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const players = new Map();

let hostId = null;
let phase = "lobby";
let soloMode = false;

// ===== MUSIC SYSTEM =====
const MUSIC_TRACKS = [
  "Song (1).mp3",
  "Song (2).mp3",
  "Song (3).mp3",
  "Song (4).mp3",
  "Song (5).mp3",
  "Song (6).mp3",
  "Song (7).mp3",
  "Song (8).mp3",
  "Song (9).mp3",
  "Song (10).mp3",
  "Song (11).mp3",
  "Song (12).mp3",
  "Song (13).mp3",
  "Song (14).mp3",
  "Song (15).mp3",
  "Song (16).mp3",
  "Song (17).mp3"
];
let musicState = {
  currentTrack: 0,
  startTime: Date.now(),  // When the current track started
  playing: true,
  shuffle: false,
  trackOrder: [...Array(MUSIC_TRACKS.length).keys()] // [0,1,2,3...]
};

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextTrack() {
  musicState.currentTrack = (musicState.currentTrack + 1) % MUSIC_TRACKS.length;
  musicState.startTime = Date.now();
  broadcastMusicState();
}

function prevTrack() {
  musicState.currentTrack = (musicState.currentTrack - 1 + MUSIC_TRACKS.length) % MUSIC_TRACKS.length;
  musicState.startTime = Date.now();
  broadcastMusicState();
}

function setTrack(index) {
  if (index >= 0 && index < MUSIC_TRACKS.length) {
    musicState.currentTrack = index;
    musicState.startTime = Date.now();
    broadcastMusicState();
  }
}

function toggleShuffle() {
  musicState.shuffle = !musicState.shuffle;
  if (musicState.shuffle) {
    musicState.trackOrder = shuffleArray([...Array(MUSIC_TRACKS.length).keys()]);
  } else {
    musicState.trackOrder = [...Array(MUSIC_TRACKS.length).keys()];
  }
  broadcastMusicState();
}

function broadcastMusicState() {
  const msg = JSON.stringify({
    t: "musicState",
    track: musicState.currentTrack,
    trackName: MUSIC_TRACKS[musicState.currentTrack],
    startTime: musicState.startTime,
    serverTime: Date.now(),
    playing: musicState.playing,
    shuffle: musicState.shuffle,
    trackList: MUSIC_TRACKS,
    hostId: hostId, // Who controls music in lobby
    phase: phase    // Current game phase
  });
  for (const [, p] of players) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
  // Also send to spectators
  for (const client of wss.clients) {
    if (client.readyState === 1 && !client.playerId) {
      client.send(msg);
    }
  }
}

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

// Per-wave gravity increase to prevent waves from taking forever
let waveElapsedTime = 0; // Time since current wave started (in seconds)
const GRAVITY_INCREASE_RATE = 0.01; // +1% gravity per second (60% per minute)

// Module card selection after boss waves
let moduleCardPhase = false;
let moduleCards = []; // 5 random cards to choose from
let modulePickOrder = []; // Order of players picking (boss killer first)
let modulePlayersPicked = new Set(); // Track who has picked
let currentModulePicker = 0;
let modulePickTimer = 0;
const MODULE_PICK_TIME = 10; // 10 seconds per pick
let bossKillOrder = []; // Track order in which players killed their boss
let bossHitPlayers = new Set(); // Players who got hit by boss (last pick, randomized)

// PERFORMANCE: Cached arrays for broadcast (avoid allocations every tick)
let cachedModuleCards = []; // Cached { id, ...TOWER_MODULES[id] } objects
let cachedPickOrder = [];   // Cached { id, name, isBossKiller } objects

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
  // Use async write so the game doesn't freeze
  fs.writeFile(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), (err) => {
    if (err) console.error("Failed to save leaderboard:", err);
  });
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
  
  // 1. Handle Active Missiles
  for (const m of missiles) {
    if (m.dead) continue;
    
    // BOSS STAYS - Don't redistribute boss or boss ads when player dies
    if (m.type === "boss" || m.isBossAd) continue;
    
    // If the missile was targeting the player who just died
    if (m.targetSlot === deadSlot) {
      
      // Filter out the sender so they don't get their own attack back
      const validTargets = aliveSlots.filter(slotIdx => {
        const playerId = lockedSlots[slotIdx];
        return playerId !== m.senderId;
      });

      if (validTargets.length > 0) {
        // Pick random valid target
        const newSlot = validTargets[Math.floor(Math.random() * validTargets.length)];
        const { x0, x1 } = segmentBounds(newSlot);
        
        m.targetSlot = newSlot;
        
        // Randomize X position in the new lane
        m.x = x0 + Math.random() * (x1 - x0);
        
        // Reset Y position to the TOP of the screen
        m.y = -m.r - 20; 
        
        // Visual flair: Trigger the "FTL" hyperspace effect again
        m.inFTL = true;  
      } else {
        // If only the sender is left, destroy the asteroid
        m.dead = true; 
        createExplosion(m.x, m.y, 20, "#ff00ff");
      }
    }
  }
  
  // 2. Handle Queued Asteroids (The Bug Fix)
  // Iterate backwards so we can safely remove items
  for (let i = spawnQueue.length - 1; i >= 0; i--) {
    const queued = spawnQueue[i];
    
    // Skip boss
    if (queued.type === "boss") continue;
    
    if (queued.targetSlot === deadSlot) {
      // FIX: Filter out the sender here too!
      const validTargets = aliveSlots.filter(slotIdx => {
        const playerId = lockedSlots[slotIdx];
        return playerId !== queued.senderId;
      });

      if (validTargets.length > 0) {
        const newSlot = validTargets[Math.floor(Math.random() * validTargets.length)];
        const { x0, x1 } = segmentBounds(newSlot);
        queued.targetSlot = newSlot;
        queued.x = x0 + Math.random() * (x1 - x0);
      } else {
        // No valid targets (e.g. only sender is left), remove from queue
        spawnQueue.splice(i, 1);
      }
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
  { id: "caliber", name: "Caliber", cat: "offense", icon: "⚫", desc: "+{val}% Bullet Size", stat: "bulletSize", base: 0.1125, type: "mult" },
  { id: "rico", name: "Ricochet", cat: "utility", icon: "🎱", desc: "Chains to {val} enemies (-10% dmg each)", stat: "ricochet", base: 1, type: "add" },
  { id: "pierce", name: "Railgun", cat: "utility", icon: "📌", desc: "Pierces {val} enemies", stat: "pierce", base: 1, type: "add" },
  { id: "chain", name: "Tesla Coil", cat: "utility", icon: "⚡", desc: "{val}% chance for Lightning", stat: "chainChance", base: 0.02, type: "add_cap", cap: 0.30 },
  { id: "shield", name: "Shield Gen", cat: "defense", icon: "🛡️", desc: "+{val} Shield (one-time)", stat: "shield", base: 1, type: "add" },
  { id: "slow", name: "Grav Field", cat: "defense", icon: "🌀", desc: "Gravity Power +{val}", stat: "slowfield", base: 15, type: "add" },
  { id: "income", name: "War Profiteer", cat: "economy", icon: "💰", desc: "+{val}% Gold (Kills & Income)", stat: "goldBonus", base: 0.12, type: "add" },
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
  const banished = player.banishedUpgrades || [];
  
  // Filter available upgrades (exclude banished ones)
  const availableDefs = UPGRADE_DEFS.filter(def => !banished.includes(def.id));
  
  // If all upgrades are banished, use full pool (safety fallback)
  const pool = availableDefs.length > 0 ? availableDefs : UPGRADE_DEFS;
  
  for (let i = 0; i < 3; i++) {
    const def = pool[Math.floor(Math.random() * pool.length)];
    if (opts.find(o => o.defId === def.id)) { i--; continue; }
    if (def.type === "bool" && player.upgrades[def.stat]) { i--; continue; }
    if (def.stat === "critChance" && (player.upgrades.critChance || 0) >= 1) { i--; continue; }

    let rarityKey = rollRarity();
    
    // Multishot and Chain Lightning are rare+ only (skip if common rolled)
    if ((def.id === "multi" || def.id === "chain") && rarityKey === "common") {
      rarityKey = "rare";
    }
    
    // Ricochet is epic+ only (reroll if common or rare)
    if (def.id === "rico" && (rarityKey === "common" || rarityKey === "rare")) {
      rarityKey = Math.random() < 0.75 ? "epic" : "legendary";
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
    } else if (def.id === "rico") {
      // Ricochet: Epic: +1, Legendary: +2
      val = rarityKey === "legendary" ? 2 : 1;
      desc = def.desc.replace("{val}", val);
      effect.val = val;
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

  // UPDATE GRAVITY CACHE (Trigger prediction update)
  if (eff.stat === "slowfield") {
    updateSlotSpeedMultipliers();
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
  
  let waveSpeedBonus = wave >= 5 ? 1 + (wave - 5) * 0.022 : 1;  // -30% speed scaling (was 0.03125)
  if (wave >= 20) {
    waveSpeedBonus += (wave - 19) * 0.033;  // -30% speed scaling (was 0.047)
  }
  
  // GAME MODIFIER: Sideswiped - spawn from sides with diagonal trajectory
  // Exclude: bosses, minibosses, boss ads, miniboss ads, and spawned minions (noGold=true)
  let finalX = x;
  let finalY = y;
  let vx, vy;
  
  const isBossType = type === "boss" || type === "miniboss" || type === "minibossAd" || bossAdVariant !== null || isMiniBoss;
  const isSpawnedMinion = noGold === true; // Spawned from carrier, splitter, or boss
  
  if (activeGameModifier === "sideswiped" && !isBossType && !isSpawnedMinion) {
    // Spawn from left or right side, in upper 50% of screen
    const { x0, x1 } = segmentBounds(targetSlot);
    const spawnFromLeft = Math.random() < 0.5;
    
    if (spawnFromLeft) {
      finalX = x0 - r - 10; // Just off left edge
      vx = rand(30, 50) * waveSpeedBonus; // Moving right
    } else {
      finalX = x1 + r + 10; // Just off right edge
      vx = rand(-50, -30) * waveSpeedBonus; // Moving left
    }
    
    // Spawn in upper 50% of screen (never below GROUND_Y * 0.5)
    finalY = rand(0, GROUND_Y * 0.45);
    
    // Diagonal downward trajectory
    const baseVy = rand(20, 35) * speedMult;
    vy = baseVy * waveSpeedBonus;
  } else {
    const baseVy = rand(25, 40) * speedMult;
    vy = baseVy * waveSpeedBonus;
    vx = rand(-15, 15);
  }

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

  // OPTIMIZED: Send spawn event with ALL static data so client can cache
  // This allows us to strip static data from broadcast updates (saves ~60% bandwidth)
  queueEvent("spawn", { 
    id, x: finalX, y: finalY, r, type, attackType, vertices, rotSpeed, color, vx, vy, 
    hp, // maxHp at spawn time
    targetSlot, // For client collision prediction
    isBoss, isBossAd, bossAdVariant, isMiniBoss: isMiniBossType, isMiniBossAd 
  });

  return {
    id,
    x: finalX, y: finalY, vx, vy, r, type,
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
    // No FTL for sideswiped regular asteroids (bosses/spawned minions still use FTL)
    inFTL: (activeGameModifier === "sideswiped" && !isBossType && !isSpawnedMinion) ? false : true,
    ftlThreshold: ftlThreshold,
    ftlTrail: [],
    gravityExposure: 0, // Track time spent in gravity wells for diminishing returns
    // GAME MODIFIER: Elusiveness tracking
    aliveTime: 0, // Track how long asteroid has been alive
    lastTeleportTime: 0, // Track last teleport for cooldown
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
  waveElapsedTime = 0; // Reset gravity timer for new wave

  // NEW: BOSS ROUND CHECK (Every 10 waves)
  if (wave % 10 === 0) {
    const playerCount = lockedSlots.length;
    // Use same extreme scaling as normal asteroids for consistency
    const extremeScaleMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
    
    for (let playerIdx = 0; playerIdx < playerCount; playerIdx++) {
      const playerId = lockedSlots[playerIdx];
      const player = players.get(playerId);
      if (!player || player.hp <= 0) continue;

      const targetSlot = playerIdx;
      const { x0 } = segmentBounds(targetSlot);
      
      // Boss HP Calculation - base HP that scales with extremeScaleMult
      // Base: 25 + wave*3 + polynomial, then exponential after wave 20
      let baseBossHp = 25 + (wave * 3);
      if (wave > 10) {
        baseBossHp += Math.floor(Math.pow(wave - 10, 1.5) * 3);
      }
      // Apply extreme scaling multiplier (same as normal asteroids)
      const bossHp = Math.ceil(baseBossHp * extremeScaleMult);
      
      spawnQueue.push({ 
        x: x0 + SEGMENT_W / 2, 
        y: -180, // Start high above screen
        type: "boss", 
        hp: bossHp, 
        targetSlot, 
        attackType: null 
      });
    }
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
  
  // Wave scaling:
  // Waves 1-5: spawn same number as wave (1, 2, 3, 4, 5)
  // Waves 6+: spawn 5 + 1 extra every 3 waves (5, 5, 6, 6, 6, 7, 7, 7, 8...)
  let baseAsteroids;
  if (wave <= 5) {
    baseAsteroids = wave;
  } else {
    baseAsteroids = 5 + Math.floor((wave - 5) / 3);
  }
  
  // Late game scaling (wave 20+)
  const countMult = wave >= 20 ? 1 + (wave - 19) * 0.05 : 1;
  const asteroidsPerPlayer = Math.floor(baseAsteroids * countMult);
  
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
        // Mini-boss has 20% of what a boss would have at this wave (with extremeScaleMult)
        let baseMiniBossHp = 25 + (wave * 3);
        if (wave > 10) {
          baseMiniBossHp += Math.floor(Math.pow(wave - 10, 1.5) * 3);
        }
        // Apply extreme scaling, then 20% for mini-boss size
        const miniBossHp = Math.ceil(baseMiniBossHp * extremeScaleMult * 0.2);
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
let modifierSkips = new Set(); // Track players who skipped the modifier intro
let modifierStartTimer = null; // Timer for auto-starting after 15 seconds

function actuallyStartGame(solo) {
  if (phase !== "starting") return; // Already started or cancelled
  
  // Clear the timer if it's still running
  if (modifierStartTimer) {
    clearTimeout(modifierStartTimer);
    modifierStartTimer = null;
  }
  modifierSkips.clear();
  
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

  updateSlotSpeedMultipliers();
  spawnWave();
  broadcast({ 
    t: "started", 
    world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, 
    wave, 
    solo: soloMode,
    gameModifier: activeGameModifier
  });
  // Also notify spectators that game started
  for (const ws of spectators) {
    safeSend(ws, { 
      t: "started", 
      world: { width: worldW, height: WORLD_H, segmentWidth: SEGMENT_W }, 
      wave, 
      solo: soloMode, 
      isSpectator: true,
      gameModifier: activeGameModifier
    });
  }
}

function startGame(solo = false) {
  if (phase !== "lobby") return;

  const ids = Array.from(players.keys()).sort((a, b) => slotForPlayer(a) - slotForPlayer(b));
  if (ids.length < 1) return;

  soloMode = solo;
  lockedSlots = ids.slice(0, MAX_PLAYERS);
  recomputeWorld();

  // Select random game modifier (80% chance for special modifier, 20% for standard)
  if (Math.random() < 0.8 && GAME_MODIFIER_IDS.length > 0) {
    const randomIndex = Math.floor(Math.random() * GAME_MODIFIER_IDS.length);
    activeGameModifier = GAME_MODIFIER_IDS[randomIndex];
  } else {
    activeGameModifier = "standard";
  }
  
  const modifier = GAME_MODIFIERS[activeGameModifier];
  
  // Set transitional phase to prevent lobby actions during card reveal
  phase = "starting";
  modifierSkips.clear();
  
  // Broadcast game modifier card reveal
  broadcast({ 
    t: "gameModifier", 
    modifier: {
      id: modifier.id,
      name: modifier.name,
      icon: modifier.icon,
      color: modifier.color,
      desc: modifier.desc,
      flavor: modifier.flavor
    },
    totalPlayers: lockedSlots.length,
    skippedCount: 0
  });
  
  // Also notify spectators
  for (const ws of spectators) {
    safeSend(ws, { 
      t: "gameModifier", 
      modifier: {
        id: modifier.id,
        name: modifier.name,
        icon: modifier.icon,
        color: modifier.color,
        desc: modifier.desc,
        flavor: modifier.flavor
      },
      isSpectator: true,
      totalPlayers: lockedSlots.length,
      skippedCount: 0
    });
  }

  // Delay game start to allow card animation (15 seconds, skippable)
  modifierStartTimer = setTimeout(() => {
    actuallyStartGame(solo);
  }, 15000);
}

function queueUpgradesAndNextWave() {
  // Check if just finished a boss wave (wave is currently boss wave number)
  const wasBossWave = wave % 10 === 0 && wave > 0;
  
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (!p) continue;
    
    // Dead players earn spite currency
    if (p.hp <= 0) {
      p.spite = (p.spite || 0) + 1;
      safeSend(p.ws, { t: "spiteEarned", spite: p.spite });
      continue;
    }

    // 1. Existing Treasury Interest (10% of current gold, max 100)
    const treasuryInterest = Math.min(100, Math.floor(p.gold * 0.10));

    // 2. Attack Income with DIMINISHING RETURNS
    // Formula: effectiveIncome = rawIncome / sqrt(1 + rawIncome / threshold)
    // This means early income is nearly full, but high income grows much slower
    // threshold of 7 means: 10 raw → 6.4 effective, 30 raw → 13, 60 raw → 19.4
    const goldMult = 1 + (p.upgrades?.goldBonus || 0); // Additive gold bonus
    const rawAttackIncome = p.incomeFromAttacks || 0;
    const INCOME_THRESHOLD = 7; // Diminishing returns kick in early (was 15)
    const effectiveAttackIncome = rawAttackIncome / Math.sqrt(1 + rawAttackIncome / INCOME_THRESHOLD);
    const attackIncome = Math.floor(effectiveAttackIncome * goldMult);

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
  
  // PERFORMANCE: Cache module card objects for broadcast (avoid .map() every tick)
  cachedModuleCards = moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }));
  
  // Track which players have picked
  modulePlayersPicked = new Set();
  
  // Determine pick order:
  // 1. Players who killed their boss (ordered by who killed first via bossKillOrder)
  // 2. Players who didn't kill boss and weren't hit (by slot order)
  // 3. Players who were hit by boss, randomized (LAST pick - punishment)
  const alivePlayerIds = new Set(
    lockedSlots
      .map(id => players.get(id))
      .filter(p => p && p.hp > 0)
      .map(p => p.id)
  );
  
  // Start with boss kill order (players who killed their boss, in order they killed)
  const bossKillers = bossKillOrder.filter(id => 
    alivePlayerIds.has(id) && !bossHitPlayers.has(id)
  );
  
  // Players who didn't kill boss and weren't hit (middle priority, by slot)
  const middlePlayers = lockedSlots
    .map(id => players.get(id))
    .filter(p => p && p.hp > 0 && !bossKillOrder.includes(p.id) && !bossHitPlayers.has(p.id))
    .sort((a, b) => (a.slot || 0) - (b.slot || 0))
    .map(p => p.id);
  
  // Players who were hit by boss - randomized and LAST (punishment)
  const hitPlayers = lockedSlots
    .map(id => players.get(id))
    .filter(p => p && p.hp > 0 && bossHitPlayers.has(p.id))
    .sort(() => Math.random() - 0.5)
    .map(p => p.id);
  
  // Combine: boss killers first (by kill order), then middle, then hit players last
  const orderedIds = [
    ...bossKillers,
    ...middlePlayers,
    ...hitPlayers
  ];
  
  modulePickOrder = orderedIds;
  currentModulePicker = 0;
  modulePickTimer = MODULE_PICK_TIME;
  
  // PERFORMANCE: Cache pick order objects for broadcast
  cachedPickOrder = modulePickOrder.map((id, index) => {
    const p = players.get(id);
    return { id, name: p?.name || "Unknown", pickPosition: index + 1 };
  });
  
  // Broadcast module card phase start (use cached arrays)
  broadcast({ 
    t: "moduleCardPhase", 
    cards: cachedModuleCards,
    pickOrder: cachedPickOrder,
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
  bossKillOrder = []; // Reset for next boss wave
  bossHitPlayers = new Set(); // Reset for next boss wave
  
  // PERFORMANCE: Clear cached arrays
  cachedModuleCards = [];
  cachedPickOrder = [];
  
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
    activeGameModifier = null; // Reset game modifier
    modifierSkips.clear(); // Reset skip tracking
    bossKillOrder = []; // Reset boss tracking
    bossHitPlayers = new Set(); // Reset boss hit tracking
    if (modifierStartTimer) {
      clearTimeout(modifierStartTimer);
      modifierStartTimer = null;
    }

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
      p.banishedUpgrades = []; // Reset banish for new game
      p.upgrades = {}; // Reset upgrades too
      p.inventory = []; // Reset module inventory
      p.score = 0; // Reset score
      p.kills = 0; // Reset kills
      p.spite = 0; // Reset spite
      p.incomeFromAttacks = 0; // Reset attack income
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

// ===== DEATH MOD EFFECTS =====
function applyDeathMod(modId, deadPlayer) {
  const playerCount = lockedSlots.length;
  
  switch (modId) {
    case "meteorShower":
      // BUFF: "Orbital Bombardment" - Spawn 20 (was 8) fast, high-damage asteroids
      for (let playerIdx = 0; playerIdx < playerCount; playerIdx++) {
        const playerId = lockedSlots[playerIdx];
        const player = players.get(playerId);
        if (!player || player.hp <= 0) continue;
        
        const { x0, x1 } = segmentBounds(playerIdx);
        // Spawn 20 meteors per living player
        for (let i = 0; i < 20; i++) {
          const x = rand(x0 + 20, x1 - 20);
          const y = rand(-100, -20); // Start higher up
          const hp = Math.ceil(2 + wave * 0.8); // Tougher
          
          // Custom "meteor" asteroid with high downward velocity
          const meteor = createAsteroid(x, y, "medium", hp, playerIdx, null);
          meteor.vy = rand(60, 90); // Very fast downward
          meteor.vx = rand(-5, 5);  // Little horizontal movement
          meteor.inFTL = false;     // Instant threat
          missiles.push(meteor);
        }
      }
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} unleashed an ORBITAL BOMBARDMENT! ☄️`, timestamp: Date.now() });
      break;
      
    case "speedDemon":
      // FIX & BUFF: Now Stacks! +50% Speed AND +10s Duration per use
      activeDeathMods.speedDemon.active = true;
      
      // Stack Count logic
      activeDeathMods.speedDemon.stacks = (activeDeathMods.speedDemon.stacks || 0) + 1;
      
      // Stack Duration logic (Add 10s to remaining time)
      const now = Date.now();
      if (activeDeathMods.speedDemon.endTime < now) {
        activeDeathMods.speedDemon.endTime = now + 10000;
      } else {
        activeDeathMods.speedDemon.endTime += 10000;
      }
      
      const currentSpeed = 1 + (activeDeathMods.speedDemon.stacks * 0.5);
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} boosted enemy engines! Speed: ${currentSpeed}x | Duration: ${(activeDeathMods.speedDemon.endTime - now)/1000}s`, timestamp: Date.now() });
      broadcast({ t: "deathModEffect", effect: "speedDemon", duration: 10, stacks: activeDeathMods.speedDemon.stacks });
      break;
      
    case "curseOfGreed":
      // BUFF: "Grand Larceny" - Steal 35% (was 15%) and destroy 1 random upgrade
      let totalStolen = 0;
      for (const [pid, player] of players) {
        if (player.hp <= 0) continue;
        const stolen = Math.floor(player.gold * 0.35); // 35% theft
        if (stolen > 0) {
          player.gold -= stolen;
          totalStolen += stolen;
          safeSend(player.ws, { t: "goldStolen", amount: stolen, by: deadPlayer.name });
        }
      }
      // Dead player gets massive score for being a master thief
      deadPlayer.score += Math.floor(totalStolen); 
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} cast GRAND LARCENY! 💸 Stole ${totalStolen} gold from the living!`, timestamp: Date.now() });
      break;
      
    case "shieldBreaker":
      // BUFF: "Core Destabilizer" - Deals 8 damage (was 3) and removes ALL shields
      for (const [pid, player] of players) {
        if (player.hp <= 0) continue;
        const wasAlive = player.hp > 0;
        
        // Destroy ALL shields first
        if (player.upgrades && player.upgrades.shieldActive > 0) {
          player.upgrades.shieldActive = 0;
          safeSend(player.ws, { t: "shieldBroken", by: deadPlayer.name });
        }
        
        // Then deal massive damage
        player.hp = Math.max(0, player.hp - 8);
        safeSend(player.ws, { t: "spiteDamage", amount: 8, by: deadPlayer.name });
        
        if (wasAlive && player.hp <= 0) {
          player.spite = 0; 
          deadPlayer.score += 500; 
          broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} EXECUTES ${player.name} with CORE DESTABILIZER! 💔`, timestamp: Date.now() });
        }
      }
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} detonated EMP BLAST! 💥 All shields destroyed + 8 Damage!`, timestamp: Date.now() });
      break;
      
    case "chaosRift":
      // BUFF: "Void Invasion" - Summons 3 Mini-Bosses (was 1) per player
      const chaosExtremeMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
      for (let playerIdx = 0; playerIdx < playerCount; playerIdx++) {
        const playerId = lockedSlots[playerIdx];
        const player = players.get(playerId);
        if (!player || player.hp <= 0) continue;
        
        const { x0, x1 } = segmentBounds(playerIdx);
        let baseMiniBossHp = 15 + (wave * 2);
        if (wave > 10) baseMiniBossHp += Math.floor(Math.pow(wave - 10, 1.3) * 2);
        const miniBossHp = Math.ceil(baseMiniBossHp * chaosExtremeMult);
        
        // Spawn 3 Mini-Bosses
        for(let k=0; k<3; k++) {
           const spawnX = x0 + SEGMENT_W * (0.2 + k*0.3); // Spread them out
           spawnQueue.push({ 
            x: spawnX, 
            y: -80 - (k * 40), // Staggered vertical spawn
            type: "miniboss", 
            hp: miniBossHp, 
            targetSlot: playerIdx, 
            attackType: null,
            isMiniBoss: true,
            isSpiteSpawn: true 
          });
        }
      }
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: `${deadPlayer.name} opened a VOID RIFT! 🌀 TRIPLE Mini-boss invasion!`, timestamp: Date.now() });
      break;
  }
}

function endGame(winnerId) {
  phase = "gameover";
  
  // Sort by DAMAGE DEALT instead of score
  const scores = lockedSlots.map(id => {
    const p = players.get(id);
    return { 
      id, 
      name: p?.name || "???", 
      damage: Math.round(p?.damageDealt || 0), // Use Damage
      slot: p?.slot || 0,
      kills: p?.kills || 0,
      isWinner: !soloMode && id === winnerId
    };
  }).sort((a, b) => b.damage - a.damage); // Sort descending by damage

  // Save to leaderboard (Tracking Damage now)
  for (const s of scores) {
    if (s.damage > 0) {
      leaderboard.push({
        name: s.name,
        damage: s.damage, // Saved as damage
        kills: s.kills,
        wave: wave,
        date: Date.now(),
        solo: soloMode
      });
    }
  }
  // Sort leaderboard by damage
  leaderboard.sort((a, b) => b.damage - a.damage);
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
  // ENTITY CAP: Prevent bullet spam from lagging server
  if (bullets.length >= MAX_BULLETS) return null;
  
  let dmg, speed, isCrit, explosive, lifespan, bulletType, ricochet, pierce, chainChance;
  let modules = [];
  let ownerGold = 0;

  // Helper variable to store chance before rolling
  let critChance = 0;

  if (overrideProps) {
    dmg = overrideProps.damage;
    modules = overrideProps.modules || [];
    ownerGold = overrideProps.ownerGold || 0;
    
    if (overrideProps.inheritedUpgrades) {
      speed = BULLET_SPEED * (overrideProps.bulletSpeedMult ?? 1) * (overrideProps.bulletType === "sniper" ? 1.5 : 1);
      critChance = overrideProps.critChance ?? 0;
      explosive = overrideProps.explosive || 0;
      lifespan = BULLET_LIFESPAN + (overrideProps.lifespanAdd ?? 0);
      ricochet = overrideProps.ricochet || 0;
      pierce = overrideProps.pierce || 0;
      chainChance = overrideProps.chainChance || 0;
    } else {
      speed = BULLET_SPEED * (overrideProps.bulletType === "sniper" ? 1.5 : 1);
      critChance = 0;
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
    critChance = owner.upgrades?.critChance ?? 0;
    explosive = owner.upgrades?.explosive ?? 0;
    lifespan = BULLET_LIFESPAN; 
    bulletType = "main";
    ricochet = owner.upgrades?.ricochet || 0;
    pierce = owner.upgrades?.pierce || 0;
    chainChance = owner.upgrades?.chainChance || 0;
    ownerGold = owner.gold || 0;
    modules = owner.modules || [];
  }

  // ===== OVERCRIT LOGIC =====
  let isOverCrit = false;
  if (critChance > 1.0) {
    isCrit = true; // Guaranteed crit
    // Excess chance becomes OverCrit chance (e.g., 1.10 = 10% chance)
    if (Math.random() < (critChance - 1.0)) {
      isOverCrit = true;
    }
  } else {
    isCrit = Math.random() < critChance;
  }

  // Normal: 1x, Crit: 3x, OverCrit: 9x (Triple the crit damage)
  let finalDmg = dmg;
  if (isOverCrit) {
    finalDmg = dmg * 9;
  } else if (isCrit) {
    finalDmg = dmg * 3;
  }
  
  let bulletR = bulletType === "sniper" ? 4 : bulletType === "missile" ? 5 : BULLET_R;
  let bulletColor = null;
  
  // Save original type before modules modify it (for homing check)
  const originalBulletType = bulletType;
  
  // Apply module effects on bullet creation
  
  // Confetti Cannon: PARTY MODE! 🎉
  if (modules.includes("confettiCannon")) {
    speed *= 0.5 + Math.random() * 2; // 0.5x to 2.5x speed
    finalDmg *= 0.3 + Math.random() * 3; // 0.3x to 3.3x damage
    bulletR = 2 + Math.random() * 8; // 2 to 10 size
    bulletColor = `hsl(${Math.random() * 360}, 100%, 60%)`; // Random color
    bulletType = "confetti"; // Special confetti rendering!
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
  
  // Taxman: -90% damage (gold is added on hit)
  if (modules.includes("taxman")) {
    finalDmg *= 0.1;
  }
  
  // Apply bullet size upgrade (mult type like bulletSpeedMult, starts at 1)
  if (!overrideProps && owner.upgrades?.bulletSize) {
    bulletR *= owner.upgrades.bulletSize;
  } else if (overrideProps?.inheritedUpgrades && overrideProps.bulletSize) {
    bulletR *= overrideProps.bulletSize;
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
    sourceX: originX,     // Track start X
    sourceY: originY - 6, // Track start Y
    vx, vy,
    r: bulletR,
    dmg: finalDmg,
    isCrit,
    explosive: explosive,
    lifespan: lifespan,
    maxLifespan: lifespan, // For Temporal Boomerang
    isTowerBullet: !isPlayerBullet,
    bulletType: bulletType,
    chainChance: chainChance,
    ricochet: ricochet,
    pierce: pierce,
    hitSet: new Set(), // O(1) hit tracking
    modules: modules, // Store modules for hit effects
    bulletColor: bulletColor, // Custom color for confetti
    // Homing properties for missile tower (use original type before confetti changes it)
    isHoming: originalBulletType === "missile",
    targetId: overrideProps?.targetId || null,
    homingSpeed: speed, // Store base speed for homing calculations
    // Momentum Lens tracking
    totalDistance: 0,
    lastX: originX,
    lastY: originY - 6,
    // Temporal Boomerang tracking
    returning: false,
  };
  bullets.push(bullet);
  
  // PERFORMANCE: Throttle bullet spawn events under heavy load
  // Too many events can overwhelm the network and client JSON parsing
  // Use global counter (reset each tick) instead of filter for efficiency
  const maxBulletEvents = players.size >= 3 ? MAX_BULLET_EVENTS_LARGE : MAX_BULLET_EVENTS_SMALL;
  
  if (bulletSpawnEventCount < maxBulletEvents) {
    bulletSpawnEventCount++;
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
      bulletColor: bullet.bulletColor,
      bulletType: bullet.bulletType, // For visual rendering (gatling/sniper/missile/main)
      ricochet: bullet.ricochet,
      pierce: bullet.pierce, // For client-side pierce prediction
      r: bullet.r,
      lifespan: bullet.lifespan, // DESYNC FIX: Send lifespan so client can expire bullets correctly
      isHoming: bullet.isHoming, // For homing missile rendering
      targetId: bullet.targetId, // Target asteroid ID for homing
      modules: bullet.modules, // Fix: Send modules so client knows about boomerang!
    });
  }
  // If throttled, bullet still exists on server - client just won't see it immediately
  // Next state update will sync positions anyway
}

// RAILGUN: Instant hitscan beam that bounces off walls until it exits the top
function fireRailgun(owner, originX, originY, targetX, targetY, props = {}) {
  const ownerSlot = owner.slot;
  const { x0, x1 } = segmentBounds(ownerSlot);
  
  // Calculate initial beam direction
  const dx = targetX - originX;
  const dy = targetY - originY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  
  let dirX = dx / dist;
  let dirY = dy / dist;
  
  // Calculate damage
  let baseDmg = props.damage || 5;
  if (props.level) {
    baseDmg = Math.round(baseDmg * (1 + (props.level - 1) * 0.25));
  }
  
  // Add inherited damage bonus from upgrades
  if (props.damageAdd) {
    baseDmg += props.damageAdd;
  }
  
  // Critical hit & OverCrit check
  const critChance = props.critChance || 0;
  let isCrit = false;
  let isOverCrit = false;

  if (critChance > 1.0) {
    isCrit = true;
    if (Math.random() < (critChance - 1.0)) {
      isOverCrit = true;
    }
  } else {
    isCrit = Math.random() < critChance;
  }

  let finalDmg = baseDmg;
  if (isOverCrit) {
    finalDmg = baseDmg * 9; // Triple the crit damage
  } else if (isCrit) {
    finalDmg = baseDmg * 3;
  }
  
  // Module effects
  const modules = props.modules || [];
  const ownerGold = props.ownerGold || 0;
  
  // Russian Roulette: random 0x-10x damage
  if (modules.includes("russianRoulette")) {
    const rouletteMult = Math.random() * 10;
    finalDmg *= rouletteMult;
    if (rouletteMult >= 8) {
      queueEvent("rouletteCrit", { x: originX, y: originY });
    }
  }
  
  // Midas Capacitor: add 1% of gold as damage
  if (modules.includes("midasCapacitor")) {
    finalDmg += ownerGold * 0.01;
  }
  
  // Vampiric Nanobots: -50% damage but heals
  let vampiricDamageDealt = 0;
  if (modules.includes("vampiricNanobots")) {
    finalDmg *= 0.5;
  }
  
  // Trace bouncing beam path
  const beamSegments = [];
  let currentX = originX;
  let currentY = originY;
  const maxBounces = 50; // Safety limit
  let bounces = 0;
  
  // Wall margins (slightly inside walls for clean bounces)
  const wallMargin = 2;
  const leftWall = x0 + wallMargin;
  const rightWall = x1 - wallMargin;
  
  while (currentY > 0 && bounces < maxBounces) {
    // Calculate where beam exits top or hits a wall
    let nextX, nextY;
    let hitWall = false;
    
    if (dirY < 0) {
      // Beam going upward - calculate where it exits top (y=0)
      const tToTop = -currentY / dirY;
      const xAtTop = currentX + dirX * tToTop;
      
      // Check if it hits a wall before reaching top
      let tToWall = Infinity;
      
      if (dirX < 0) {
        // Moving left - check left wall
        const tLeft = (leftWall - currentX) / dirX;
        if (tLeft > 0 && tLeft < tToTop) {
          tToWall = tLeft;
          hitWall = true;
        }
      } else if (dirX > 0) {
        // Moving right - check right wall
        const tRight = (rightWall - currentX) / dirX;
        if (tRight > 0 && tRight < tToTop) {
          tToWall = tRight;
          hitWall = true;
        }
      }
      
      if (hitWall) {
        nextX = currentX + dirX * tToWall;
        nextY = currentY + dirY * tToWall;
      } else {
        nextX = xAtTop;
        nextY = 0;
      }
    } else {
      // Beam going downward - it will hit ground or wall eventually
      // For simplicity, extend a bit and let it hit walls
      const tToGround = (GROUND_Y - currentY) / dirY;
      const xAtGround = currentX + dirX * tToGround;
      
      let tToWall = Infinity;
      
      if (dirX < 0) {
        const tLeft = (leftWall - currentX) / dirX;
        if (tLeft > 0 && tLeft < tToGround) {
          tToWall = tLeft;
          hitWall = true;
        }
      } else if (dirX > 0) {
        const tRight = (rightWall - currentX) / dirX;
        if (tRight > 0 && tRight < tToGround) {
          tToWall = tRight;
          hitWall = true;
        }
      }
      
      if (hitWall) {
        nextX = currentX + dirX * tToWall;
        nextY = currentY + dirY * tToWall;
      } else {
        // Hit ground - end beam
        nextX = xAtGround;
        nextY = GROUND_Y;
        beamSegments.push({ x1: currentX, y1: currentY, x2: nextX, y2: nextY });
        break;
      }
    }
    
    // Store this segment
    beamSegments.push({ x1: currentX, y1: currentY, x2: nextX, y2: nextY });
    
    // If we hit the top, we're done
    if (nextY <= 0) break;
    
    // If we hit a wall, bounce (reflect X direction)
    if (hitWall) {
      currentX = nextX;
      currentY = nextY;
      dirX = -dirX; // Reflect horizontally
      bounces++;
    } else {
      break;
    }
  }
  
  // Find all enemies hit by any beam segment
  const beamWidth = 6;
  const hitEnemiesSet = new Set(); // Track by ID to avoid double-hits
  const hitEnemies = [];
  
  const slotMissiles = missilesBySlot[ownerSlot] || [];
  
  for (const m of slotMissiles) {
    if (m.dead || m.inFTL || hitEnemiesSet.has(m.id)) continue;
    
    // Ghost phasing check
    if (m.phasing) {
      const cycleTime = 2.0;
      const phase = ((m.phaseOffset || 0) + (Date.now() / 1000)) % cycleTime;
      if (phase > cycleTime * 0.5) continue;
    }
    
    // Check against each beam segment
    for (const seg of beamSegments) {
      const segDx = seg.x2 - seg.x1;
      const segDy = seg.y2 - seg.y1;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < 1) continue;
      
      const segDirX = segDx / segLen;
      const segDirY = segDy / segLen;
      
      // Project asteroid onto segment
      const apX = m.x - seg.x1;
      const apY = m.y - seg.y1;
      const projection = apX * segDirX + apY * segDirY;
      
      // Skip if outside segment
      if (projection < 0 || projection > segLen) continue;
      
      // Find closest point on segment
      const closestX = seg.x1 + segDirX * projection;
      const closestY = seg.y1 + segDirY * projection;
      
      // Distance from asteroid to beam
      const distToBeam = Math.hypot(m.x - closestX, m.y - closestY);
      
      if (distToBeam <= beamWidth + m.r) {
        hitEnemiesSet.add(m.id);
        hitEnemies.push({ missile: m });
        break; // Don't check more segments for this enemy
      }
    }
  }
  
  // Apply damage to all hit enemies
  for (const hit of hitEnemies) {
    const m = hit.missile;
    
    // Calculate final damage with module effects
    let hitDamage = finalDmg;
    
    // Executioner's Sight: 300% damage to enemies below 30% HP
    if (modules.includes("executionerSight")) {
      if (m.hp / m.maxHp < 0.3) {
        hitDamage *= 3;
      }
    }
    
    m.hp -= hitDamage;
    vampiricDamageDealt += hitDamage;
    
    const p = players.get(owner.id);
    if (p) {
      p.damageDealt = (p.damageDealt || 0) + hitDamage;
      p.waveDamage = (p.waveDamage || 0) + hitDamage;
    }
    
    // Check for kill
    if (m.hp <= 0 && !m.dead) {
      m.dead = true;
      
      if (!m.noGold && p) {
        let goldReward = m.gold || 1;
        const goldBonus = p.upgrades?.goldBonus ?? 0;
        goldReward = Math.round(goldReward * (1 + goldBonus));
        p.gold += goldReward;
        p.kills = (p.kills || 0) + 1;
        p.score = (p.score || 0) + Math.ceil(m.maxHp);
      }
      
      // Track boss kill order
      if (m.type === "boss" && p && !bossKillOrder.includes(p.id)) {
        bossKillOrder.push(p.id);
        broadcast({ t: "bossKilled", killerId: p.id, killerName: p.name, killPosition: bossKillOrder.length });
        
        // Spawn remaining minion waves if boss died early
        if (m.bossSpawnCount < 3) {
          const remainingSpawns = 3 - m.bossSpawnCount;
          let totalToSpawn = remainingSpawns * 5;
          totalToSpawn = Math.min(totalToSpawn, MAX_MISSILES - missiles.length);
          for (let k = 0; k < totalToSpawn; k++) {
            const bossAdVariant = (k % 5) + 1;
            missiles.push(createAsteroid(
              m.x + rand(-50, 50),
              m.y + rand(20, 100),
              "medium",
              Math.max(2, wave),
              m.targetSlot,
              null, null, bossAdVariant, false
            ));
          }
          createExplosion(m.x, m.y, 80, "#ff0000");
        }
      }
      
      // Splitter
      if (m.splits > 0) {
        const availableSlots = MAX_MISSILES - missiles.length;
        const splitsToSpawn = Math.min(m.splits, availableSlots, 8);
        if (splitsToSpawn > 0) {
          const extremeMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
          const splitHp = Math.ceil((0.5 + wave * 0.3) * extremeMult);
          for (let s = 0; s < splitsToSpawn; s++) {
            const nx = m.x + (Math.random() - 0.5) * 60;
            const ny = m.y + (Math.random() - 0.5) * 40;
            const splitAsteroid = createAsteroid(nx, ny, "small", splitHp, m.targetSlot, null, m.senderId, null, true);
            missiles.push(splitAsteroid);
          }
        }
      }
      
      queueEvent("explosion", { x: m.x, y: m.y, color: "#0f0", radius: 20 });
      
      if (modules.includes("gravityWell")) {
        gravityWells.push({
          x: m.x, y: m.y,
          targetId: m.id,
          life: 2.0, radius: 100, strength: 80,
          ownerSlot: ownerSlot
        });
        queueEvent("gravityWell", { x: m.x, y: m.y });
      }
    }
    
    queueEvent("hit", { 
      x: m.x, y: m.y, 
      isCrit, 
      dmg: Math.round(hitDamage * 10) / 10,
      isRailgun: true
    });
  }
  
  // Vampiric healing
  if (modules.includes("vampiricNanobots") && vampiricDamageDealt > 0) {
    const p = players.get(owner.id);
    if (p) {
      p.vampiricPool = (p.vampiricPool || 0) + vampiricDamageDealt;
      if (p.vampiricPool >= 400) {
        const heals = Math.floor(p.vampiricPool / 400);
        p.vampiricPool -= heals * 400;
        p.hp = Math.min(p.hp + heals, p.maxHp);
        if (heals > 0) {
          queueEvent("vampiricHeal", { slot: p.slot, amount: heals });
        }
      }
    }
  }
  
  // Send railgun beam visual event with all segments
  queueEvent("railgun", {
    segments: beamSegments,
    slot: ownerSlot,
    isCrit,
    hitCount: hitEnemies.length
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
    let speedMult = slotSpeedMultipliers[owner.slot] || 1;
    // Include gravity increase in prediction
    const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
    speedMult *= gravityMult;
    const intercept = calculateInterceptPoint(originX, originY, bulletSpeed, target, speedMult);
    
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

// CACHE: Speed multipliers per slot (updated only when upgrades change)
let slotSpeedMultipliers = [1, 1, 1, 1];

function updateSlotSpeedMultipliers() {
  slotSpeedMultipliers = [1, 1, 1, 1];
  if (!lockedSlots) return;
  for (const id of lockedSlots) {
    const p = players.get(id);
    if (p && p.slot !== undefined && p.upgrades?.slowfield) {
       // Same formula as tick logic: 100 strength = 0.5x speed
       slotSpeedMultipliers[p.slot] = 100 / (100 + p.upgrades.slowfield);
    }
  }
}

// Calculate intercept point taking Gravity into account
function calculateInterceptPoint(turretX, turretY, bulletSpeed, target, speedMult = 1) {
  // Target current position and ADJUSTED velocity
  const tx = target.x;
  const ty = target.y;
  const tvx = (target.vx || 0) * speedMult; // <--- APPLY GRAVITY HERE
  const tvy = (target.vy || 30) * speedMult; // <--- APPLY GRAVITY HERE
  
  const dx = tx - turretX;
  const dy = ty - turretY;
  
  const a = tvx * tvx + tvy * tvy - bulletSpeed * bulletSpeed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;
  
  let t = 0;
  
  if (Math.abs(a) < 0.001) {
    if (Math.abs(b) > 0.001) t = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtD = Math.sqrt(discriminant);
      const t1 = (-b - sqrtD) / (2 * a);
      const t2 = (-b + sqrtD) / (2 * a);
      if (t1 > 0.01 && t2 > 0.01) t = Math.min(t1, t2);
      else if (t1 > 0.01) t = t1;
      else if (t2 > 0.01) t = t2;
    }
  }
  
  t = Math.max(0, Math.min(t, 3.0));
  
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

// PERFORMANCE: Track event load for throttling visual effects
let visualEventCount = 0;
let bulletSpawnEventCount = 0; // Track bullet spawn events per tick
// Cap visual events - scale with player count
function getMaxVisualEvents() {
  const playerCount = players.size;
  if (playerCount >= 4) return Math.floor(MAX_VISUAL_EVENTS * 0.6);  // 18
  if (playerCount >= 3) return Math.floor(MAX_VISUAL_EVENTS * 0.8);  // 24
  if (playerCount >= 2) return MAX_VISUAL_EVENTS;                     // 30
  return Math.floor(MAX_VISUAL_EVENTS * 1.5);                         // 45 for solo
}

// OPTIMIZED: Create explosion - throttled under heavy load
function createExplosion(x, y, radius, color) {
  const maxEvents = getMaxVisualEvents();
  // PERFORMANCE: Skip small explosions under heavy load
  if (visualEventCount >= maxEvents && radius < 30) return;
  visualEventCount++;
  queueEvent("explosion", { x, y, radius, color });
}

// OPTIMIZED: Add damage number - throttled under heavy load
function addDamageNumber(x, y, amount, isCrit) {
  const maxEvents = getMaxVisualEvents();
  // PERFORMANCE: Always show crits, throttle normal damage numbers
  if (!isCrit && visualEventCount >= maxEvents) return;
  visualEventCount++;
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
    visualEventCount = 0; // PERFORMANCE: Reset visual event throttle counter
    bulletSpawnEventCount = 0; // PERFORMANCE: Reset bullet spawn event counter
    
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
    
    // Check for expired death mod effects
    if (activeDeathMods.speedDemon.active && Date.now() >= activeDeathMods.speedDemon.endTime) {
      activeDeathMods.speedDemon.active = false;
      activeDeathMods.speedDemon.stacks = 0; // Reset stacks
      broadcast({ t: "deathModExpired", effect: "speedDemon" });
      broadcast({ t: "chatMsg", id: uid(), from: "💀 SPITE", text: "Speed Demon effect has ended... for now.", timestamp: Date.now() });
    }
    
    // Track wave elapsed time for gravity increase
    waveElapsedTime += DT;
    
    // Module card pick timer
    if (moduleCardPhase) {
      modulePickTimer -= DT;
      if (modulePickTimer <= 0) {
        // AUTO-PICK LOGIC: Time's up!
        const playerId = modulePickOrder[currentModulePicker];
        const p = players.get(playerId);
        
        // If player is still here and hasn't picked, force a random pick
        if (p && moduleCards.length > 0 && !modulePlayersPicked.has(playerId)) {
           // Pick random available card
           const cardIndex = Math.floor(Math.random() * moduleCards.length);
           const moduleId = moduleCards[cardIndex];
           
           // Add to inventory
           p.inventory.push(moduleId);
           modulePlayersPicked.add(playerId); // Mark as picked
           
           // Remove from deck
           moduleCards.splice(cardIndex, 1);
           
           // CRITICAL: Update cached array for state broadcasts
           cachedModuleCards = moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }));
           
           // Notify everyone (same as a normal pick, but forced)
           broadcast({ 
            t: "moduleCardPicked", 
            playerId: p.id, 
            playerName: p.name, 
            moduleId, 
            cardIndex,
            remainingCards: cachedModuleCards,
            isAutoPick: true
          });
        }

        // Move to next picker
        currentModulePicker++;
        modulePickTimer = MODULE_PICK_TIME;
        
        if (currentModulePicker >= modulePickOrder.length || moduleCards.length === 0) {
          endModuleCardPhase();
        } else {
          broadcast({ 
            t: "modulePickTurn", 
            playerId: modulePickOrder[currentModulePicker], 
            timeLeft: MODULE_PICK_TIME,
            remainingCards: cachedModuleCards
          });
        }
      }
    }
    
    // Process spawn queue
    if (spawnQueue.length > 0) {
      spawnTimer -= DT;
      if (spawnTimer <= 0) {
        // ENTITY CAP: Only spawn if under missile limit
        const availableSlots = MAX_MISSILES - missiles.length;
        if (availableSlots > 0) {
          const spawnCount = Math.min(spawnQueue.length, availableSlots, Math.random() < 0.5 ? 1 : Math.random() < 0.8 ? 2 : 3);
          for (let i = 0; i < spawnCount && spawnQueue.length > 0; i++) {
            const queued = spawnQueue.shift();
            missiles.push(createAsteroid(
              queued.x, queued.y, queued.type, queued.hp, queued.targetSlot, 
              queued.attackType, queued.senderId, null, false, queued.isMiniBoss || false
            ));
          }
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
      
      // Main turret fire rate (modules don't affect main turret - only slotted towers)
      let fireRateMult = p.upgrades?.fireRateMult ?? 1;
      const baseCooldown = BULLET_COOLDOWN / fireRateMult;

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
          let speedMult = slotSpeedMultipliers[p.slot] || 1;
          // Include gravity increase in prediction
          const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
          speedMult *= gravityMult;
          const intercept = calculateInterceptPoint(pos.main.x, pos.main.y, bulletSpeed, mainTarget, speedMult);
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
            
            let aim;
            if (stats.bulletType === "sniper") {
              // RAILGUN: Hitscan - aim directly at target (no prediction needed)
              aim = clampAimAngle(towerPos.x, towerPos.y, target.x, target.y);
            } else {
              // Other towers: Calculate intercept point for projectiles
              let speedMult = slotSpeedMultipliers[p.slot] || 1;
              // Include gravity increase in prediction
              const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
              speedMult *= gravityMult;
              const intercept = calculateInterceptPoint(towerPos.x, towerPos.y, towerBulletSpeed, target, speedMult);
              aim = clampAimAngle(towerPos.x, towerPos.y, intercept.x, intercept.y);
            }
            tower.angle = aim.angle;
            
            if (tower.cd <= 0) {
              const levelBonus = 1 + (tower.level - 1) * 0.15;
              let fireRateBonus = ((p.upgrades?.fireRateMult ?? 1) - 1) * 0.5 + 1;
              
              // Collect active modules on this tower (simple loop instead of filter)
              const activeModules = [];
              if (tower.modules) {
                for (let mi = 0; mi < tower.modules.length; mi++) {
                  if (tower.modules[mi] !== null) activeModules.push(tower.modules[mi]);
                }
              }
              
              // FEEDBACK LOOP: +15% fire rate per module on this tower
              if (activeModules.includes("feedbackLoop")) {
                const moduleCount = activeModules.length;
                fireRateBonus *= 1 + (moduleCount * 0.15); // +15% per module (including feedbackLoop itself)
              }
              
              // BLOODTHIRSTER ENGINE: +1% fire rate per 1% HP missing
              if (activeModules.includes("bloodthirster")) {
                const missingHpPercent = (p.maxHp - p.hp) / p.maxHp;
                fireRateBonus *= 1 + missingHpPercent;
              }
              
              tower.cd = stats.cooldown / levelBonus / fireRateBonus;
              
              // COPYCAT MODULE: Becomes an exact 75% copy of main turret
              if (activeModules.includes("copycat")) {
                // Use main turret's base cooldown with 75% of fire rate bonus
                const mainFireRate = p.upgrades?.fireRateMult ?? 1;
                const scaledFireRate = 1 + (mainFireRate - 1) * 0.75;
                tower.cd = BULLET_COOLDOWN / scaledFireRate;
                
                // Get other modules (excluding copycat itself) to apply additively
                const otherModules = activeModules.filter(m => m !== "copycat");
                
                // Create a "scaled owner" with 75% of all main turret stats
                const scaledOwner = {
                  id: p.id,
                  slot: p.slot,
                  gold: p.gold,
                  modules: otherModules, // Pass other modules for additive effects
                  upgrades: {
                    multishot: Math.max(1, Math.floor((p.upgrades?.multishot ?? 1) * 0.75)),
                    damageAdd: (p.upgrades?.damageAdd ?? 0) * 0.75,
                    bulletSpeedMult: 1 + ((p.upgrades?.bulletSpeedMult ?? 1) - 1) * 0.75,
                    critChance: (p.upgrades?.critChance ?? 0) * 0.75,
                    explosive: Math.floor((p.upgrades?.explosive ?? 0) * 0.75),
                    bulletSize: 1 + ((p.upgrades?.bulletSize ?? 1) - 1) * 0.75,
                    ricochet: Math.floor((p.upgrades?.ricochet ?? 0) * 0.75),
                    pierce: Math.floor((p.upgrades?.pierce ?? 0) * 0.75),
                    chainChance: (p.upgrades?.chainChance ?? 0) * 0.75,
                    fireRateMult: scaledFireRate,
                    multishotDmgMult: p.upgrades?.multishotDmgMult ?? 1, // Keep full penalty
                  }
                };
                
                // Fire using the same logic as main turret
                fireWithMultishot(scaledOwner, towerPos.x, towerPos.y, aim.x, aim.y, false);
              } else {
                // Normal tower firing
                if (stats.bulletType === "sniper") {
                  // RAILGUN: Instant hitscan beam for sniper tower
                  const railgunProps = {
                    damage: stats.damage + (u.damageAdd ?? 0) * 0.5,
                    level: tower.level,
                    critChance: (u.critChance ?? 0) * 0.5,
                    modules: activeModules,
                    ownerGold: p.gold,
                    damageAdd: (u.damageAdd ?? 0) * 0.5,
                  };
                  fireRailgun(p, towerPos.x, towerPos.y, aim.x, aim.y, railgunProps);
                } else {
                  // Other towers use normal bullets
                  const towerProps = {
                    ...stats,
                    level: tower.level,
                    damage: stats.damage + (u.damageAdd ?? 0) * 0.5,
                    bulletSpeedMult: 1 + ((u.bulletSpeedMult ?? 1) - 1) * 0.5,
                    critChance: (u.critChance ?? 0) * 0.5,
                    explosive: (stats.explosive || 0) + Math.floor((u.explosive ?? 0) * 0.5),
                    bulletSize: 1 + ((u.bulletSize ?? 1) - 1) * 0.5,
                    lifespanAdd: (u.lifespanAdd ?? 0) * 0.5,
                    ricochet: Math.floor((u.ricochet ?? 0) * 0.5),
                    pierce: Math.floor((u.pierce ?? 0) * 0.5),
                    chainChance: (u.chainChance ?? 0) * 0.5,
                    inheritedUpgrades: true,
                    modules: activeModules,
                    ownerGold: p.gold,
                    targetId: target.id,
                  };
                  fireBullet(p, towerPos.x, towerPos.y, aim.x, aim.y, 0, towerProps);
                }
              }
            }
          } else {
            tower.angle = -Math.PI / 2;
          }
          
          tower.cd = Math.max(0, (tower.cd || 0) - DT);
        }
      }
      
      // Drone Command: Update and fire drones for towers with this module
      if (p.towers) {
        for (let tIdx = 0; tIdx < p.towers.length; tIdx++) {
          const tower = p.towers[tIdx];
          if (!tower) continue;
          
          // Check if this tower has droneCommand module
          const hasDrone = tower.modules && tower.modules.includes("droneCommand");
          if (!hasDrone) {
            tower.dronePos = null;
            continue;
          }
          
          const towerPos = pos.slots[tIdx];
          if (!towerPos) continue;
          
          // Initialize drone state if needed
          if (!tower.droneAngle) tower.droneAngle = Math.random() * Math.PI * 2;
          if (!tower.droneCd) tower.droneCd = 0;
          
          // Update drone orbit angle
          tower.droneAngle += DT * 2.5; // 2.5 radians per second orbit speed
          
          // Calculate drone position (orbits around the tower)
          const orbitRadius = 30;
          const droneX = towerPos.x + Math.cos(tower.droneAngle) * orbitRadius;
          const droneY = towerPos.y - 20 + Math.sin(tower.droneAngle) * orbitRadius * 0.5;
          
          // Store drone position for client rendering
          tower.dronePos = { x: droneX, y: droneY, angle: tower.droneAngle };
          
          // Drone firing
          tower.droneCd = Math.max(0, tower.droneCd - DT);
          
          if (tower.droneCd <= 0) {
            const droneTarget = findBestTarget(x0, x1, droneX, droneY, 0.8, p.slot);
            
            if (droneTarget) {
              const droneDamage = 1 + (p.upgrades?.damageAdd ?? 0) * 0.3;
              
              let speedMult = slotSpeedMultipliers[p.slot] || 1;
              const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
              speedMult *= gravityMult;
              const intercept = calculateInterceptPoint(droneX, droneY, BULLET_SPEED * 0.8, droneTarget, speedMult);
              
              fireBullet(p, droneX, droneY, intercept.x, intercept.y, 0, {
                damage: droneDamage,
                bulletType: "drone",
                inheritedUpgrades: false,
                modules: [],
              });
              
              tower.droneCd = 0.5;
            }
          }
        }
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

      // OPTIMIZED: Use cached speed multiplier for this slot
      let speedMult = slotSpeedMultipliers[m.targetSlot] || 1;
      
      // Death Mod: Speed Demon - Stacks 50% speed per usage!
      if (activeDeathMods.speedDemon.active) {
        const stacks = activeDeathMods.speedDemon.stacks || 1;
        speedMult *= (1 + 0.5 * stacks); // 1 stack = 1.5x, 2 stacks = 2.0x, 3 stacks = 2.5x...
      }
      
      // Per-wave gravity increase: +1% per second to prevent infinite waves
      // This stacks multiplicatively with slow effects (slow still works proportionally)
      const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
      speedMult *= gravityMult;
      
      // Track alive time for elusiveness modifier
      m.aliveTime = (m.aliveTime || 0) + DT;
      
      // GAME MODIFIER: Quantum Drift (Elusiveness) - teleport sideways after 5s
      if (activeGameModifier === "elusiveness" && !m.isBoss && !m.isMiniBoss) {
        const timeSinceLastTeleport = m.aliveTime - (m.lastTeleportTime || 0);
        
        // After 5 seconds since spawn/last teleport, 15% chance per second to teleport
        if (timeSinceLastTeleport >= 5) {
          const teleportChance = 0.15 * DT; // 15% per second
          if (Math.random() < teleportChance) {
            // Get segment bounds for this asteroid's lane
            const { x0, x1 } = segmentBounds(m.targetSlot);
            const margin = m.r + 10;
            
            // Teleport left or right (stay within bounds)
            const teleportDist = 40 + Math.random() * 60; // 40-100px
            const goLeft = Math.random() < 0.5;
            
            const oldX = m.x;
            if (goLeft) {
              m.x = Math.max(x0 + margin, m.x - teleportDist);
            } else {
              m.x = Math.min(x1 - margin, m.x + teleportDist);
            }
            
            // Only trigger effect if we actually moved
            if (Math.abs(m.x - oldX) > 10) {
              m.lastTeleportTime = m.aliveTime; // Reset 5s cooldown
              queueEvent("elusiveTeleport", { 
                id: m.id, 
                oldX: oldX, 
                oldY: m.y, 
                newX: m.x, 
                newY: m.y 
              });
            }
          }
        }
      }
      
      m.x += m.vx * DT * speedMult;
      m.y += m.vy * DT * speedMult;
	  
      // Carrier: Spawns mini asteroids periodically
      if (m.isCarrier && m.carrierSpawnTimer !== null && !m.inFTL) {
        m.carrierSpawnTimer -= DT;
        if (m.carrierSpawnTimer <= 0) {
          // ENTITY CAP: Only spawn if under limit
          const availableSlots = MAX_MISSILES - missiles.length;
          if (availableSlots > 0) {
            // Spawn mini asteroids
            const spawnCount = Math.min(ATTACK_TYPES.carrier?.spawnCount || 2, availableSlots);
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
            // Visual feedback
            createExplosion(m.x, m.y + m.r, 15, ATTACK_TYPES.carrier?.color || "#ff00ff");
          }
          // Reset timer
          m.carrierSpawnTimer = ATTACK_TYPES.carrier?.spawnInterval || 2.0;
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
                  
                  // Track that this player got hit by boss (last pick priority)
                  bossHitPlayers.add(p.id);
                  
                  if (wasAlive && p.hp <= 0) {
                    p.spite = 0; // Reset spite on death - starts accumulating next wave
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
                    p.spite = 0; // Reset spite on death - starts accumulating next wave
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
    for (let bi = 0; bi < bullets.length; bi++) {
      const b = bullets[bi];
      // Clear skipThisTick flag - bullets created last tick can now be processed
      b.skipThisTick = false;
      
      // HOMING MISSILES: Track and follow targets
      if (b.isHoming && !b.dead) {
        const slotMissiles = missilesBySlot[b.ownerSlot];
        let target = null;
        
        // Try to find current target
        if (b.targetId && slotMissiles) {
          for (let i = 0; i < slotMissiles.length; i++) {
            // FIX: Don't stick to enemies we already hit (prevent death loops)
            if (slotMissiles[i].id === b.targetId && slotMissiles[i].hp > 0 &&
               (!b.hitSet || !b.hitSet.has(slotMissiles[i].id))) {
              target = slotMissiles[i];
              break;
            }
          }
        }
        
        // If target dead, missing, OR already hit, find closest new target
        if (!target && slotMissiles && slotMissiles.length > 0) {
          let closestDist = Infinity;
          for (let i = 0; i < slotMissiles.length; i++) {
            const m = slotMissiles[i];
            if (m.hp <= 0) continue;
            
            // FIX: Do not target enemies we have already hit
            if (b.hitSet && b.hitSet.has(m.id)) continue;

            const dx = m.x - b.x;
            const dy = m.y - b.y;
            const dist = dx * dx + dy * dy;
            if (dist < closestDist) {
              closestDist = dist;
              target = m;
            }
          }
          if (target) {
            b.targetId = target.id;
            // Send retarget event to client for sync
            eventQueue.push({
              t: "homingRetarget",
              bulletId: b.id,
              targetId: target.id,
              x: b.x,
              y: b.y,
              vx: b.vx,
              vy: b.vy
            });
          }
        }
        
        // Steer toward target
        if (target) {
          // ... (keep existing steering logic) ...
          const dx = target.x - b.x;
          const dy = target.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            // Calculate desired velocity toward target
            const desiredVx = (dx / dist) * b.homingSpeed;
            const desiredVy = (dy / dist) * b.homingSpeed;
            
            // Smooth turning - missiles turn toward target over time
            const turnRate = 8; // Higher = tighter turning
            b.vx += (desiredVx - b.vx) * turnRate * DT;
            b.vy += (desiredVy - b.vy) * turnRate * DT;
            
            // Normalize to maintain consistent speed
            const currentSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (currentSpeed > 0) {
              b.vx = (b.vx / currentSpeed) * b.homingSpeed;
              b.vy = (b.vy / currentSpeed) * b.homingSpeed;
            }
          }
        }
      }
      
	  b.x += b.vx * DT;
      b.y += b.vy * DT;

      b.lifespan -= DT;
      // FIX 1: Removed death check so bullets don't vanish before returning
      // if (b.lifespan <= 0) { b.dead = true; continue; } 
      
      // Momentum Lens: Track distance traveled
      if (b.modules && b.modules.includes("momentumLens")) {
        // FIX: Default to current position if lastX is missing (shards/ricochets)
        const lx = (b.lastX !== undefined) ? b.lastX : b.x;
        const ly = (b.lastY !== undefined) ? b.lastY : b.y;
        
        const distThisTick = Math.hypot(b.x - lx, b.y - ly);
        b.totalDistance = (b.totalDistance || 0) + distThisTick;
      }
      b.lastX = b.x;
      b.lastY = b.y;
      
      // ===== TEMPORAL BOOMERANG & BOUNDARY LOGIC =====
      const { x0: ownerX0, x1: ownerX1 } = segmentBounds(b.ownerSlot);
      const hitLeft = b.x < ownerX0;
      const hitRight = b.x > ownerX1;
      const hitTop = b.y < -50;
      const hitBottom = b.y > GROUND_Y;

      if (hitLeft || hitRight || hitTop || hitBottom) {
        // Temporal Boomerang: Bounce back to source on wall/ceiling hit (once)
        // (We don't bounce off the floor/bottom, that counts as a miss)
        if (b.modules && b.modules.includes("temporalBoomerang") && !b.returning && !hitBottom) {
           b.returning = true;
           b.hitSet.clear(); // Allow hitting enemies again on the way back
           
           // Calculate vector back to source turret
           // If source is missing (e.g. older bullets), aim for center of lane
           const sx = b.sourceX !== undefined ? b.sourceX : (ownerX0 + SEGMENT_W/2);
           const sy = b.sourceY !== undefined ? b.sourceY : GROUND_Y;
           
           const dx = sx - b.x;
           const dy = sy - b.y;
           const dist = Math.hypot(dx, dy) || 1;
           const speed = Math.hypot(b.vx, b.vy); // Keep same speed
           
           // Redirect bullet exactly towards source
           b.vx = (dx / dist) * speed;
           b.vy = (dy / dist) * speed;
           
           // Push back inside bounds to prevent getting stuck in the wall
           if (hitLeft) b.x = ownerX0 + 2;
           if (hitRight) b.x = ownerX1 - 2;
           if (hitTop) b.y = -48;
           
           // Refresh lifespan so it has time to travel back
           b.lifespan = b.maxLifespan; 
        } else {
           // Normal bullets (or boomerang returning bullets) die at borders
           b.dead = true;
        }
      }
    }

    const bulletCount = bullets.length;
    for (let bulletIdx = 0; bulletIdx < bulletCount; bulletIdx++) {
      const b = bullets[bulletIdx];
      if (b.dead) continue;
      if (b.skipThisTick) continue; // Skip newly created ricochet bullets until next tick
      const slot = b.ownerSlot;
      const slotMissiles = missilesBySlot[slot];
      if (!slotMissiles) continue;
      
      for (let mi = 0; mi < slotMissiles.length; mi++) {
        const m = slotMissiles[mi];
        if (m.isPhased && Math.random() > 0.3) continue;
        if (b.hitSet && b.hitSet.has(m.id)) continue; // O(1) Set lookup
        
        const rr = m.r + b.r;
        const dx = m.x - b.x;
        if (dx > rr || dx < -rr) continue; // Quick X reject
        const dy = m.y - b.y;
        if (dy > rr || dy < -rr) continue; // Quick Y reject
        
        if (dx * dx + dy * dy <= rr * rr) {
          // Calculate final damage with module effects
          let hitDamage = b.dmg;
          
          // Executioner's Sight: 300% damage to enemies below 30% HP
          if (b.modules && b.modules.includes("executionerSight")) {
            if (m.hp / m.maxHp < 0.3) {
              hitDamage *= 3;
            }
          }
          
          // Momentum Lens: +10% damage per 100 pixels traveled
          if (b.modules && b.modules.includes("momentumLens")) {
            const distanceBonus = 1 + (b.totalDistance / 100) * 0.1;
            hitDamage *= distanceBonus;
          }
          
          m.hp -= hitDamage;

          // BOSS MECHANIC: Spawn 5 minions at 75%, 50%, 25% HP (3 times total)
          if (m.type === "boss" && m.bossSpawnCount < 3) {
            const hpPercent = m.hp / m.maxHp;
            const nextThreshold = 1 - ((m.bossSpawnCount + 1) * 0.25); // 0.75, 0.50, 0.25
            if (hpPercent <= nextThreshold) {
              m.bossSpawnCount++;
              // ENTITY CAP: Limit spawns to available slots
              const adsToSpawn = Math.min(5, MAX_MISSILES - missiles.length);
              for(let k=0; k<adsToSpawn; k++) {
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
              // ENTITY CAP: Limit spawns to available slots
              const adsToSpawn = Math.min(3, MAX_MISSILES - missiles.length);
              for(let k=0; k<adsToSpawn; k++) {
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
          // SYNERGY SYSTEM: Modules should work together! When spawning child bullets
          // (shards, ricochets, etc.), inherit the parent's modules so effects chain.
          // Example: Fractal Prism + Viral Payload = shards can infect enemies
          // Example: Fractal Prism + Taxman = shards generate gold on hit
          // IMPORTANT: Always pass modules to child bullets to enable creative combos!
          const bulletModules = b.modules || [];
          const owner = players.get(b.ownerId);
          
          // 🎉 CONFETTI CANNON: Party explosion on hit!
          if (bulletModules.includes("confettiCannon")) {
            queueEvent("confettiExplosion", { 
              x: m.x, 
              y: m.y, 
              color: b.bulletColor || `hsl(${Math.random() * 360}, 100%, 60%)`,
              size: b.r || 5
            });
          }
          
          // Fractal Prism: Shatter into 4 smaller bullets (2 Left, 2 Right)
          // SYNERGY: Shards inherit all modules EXCEPT fractalPrism itself (prevents infinite recursion)
          // This allows combos like: Fractal + Viral (infectious shards), Fractal + Taxman (gold shards)
          if (bulletModules.includes("fractalPrism") && bullets.length < MAX_BULLETS) {
            const shardsToSpawn = Math.min(4, MAX_BULLETS - bullets.length);
            
            // Filter out fractalPrism to prevent shards spawning more shards (infinite loop)
            // Keep all OTHER modules so shards can infect, generate gold, heal, etc.
            const shardModules = bulletModules.filter(mod => mod !== "fractalPrism");
            
            // Define 4 specific angles: 2 Right (approx 0), 2 Left (approx PI)
            // 0.4 radians is about 23 degrees
            const angles = [
               -0.4,            // Right Up
               0.4,             // Right Down
               Math.PI - 0.4,   // Left Up
               Math.PI + 0.4    // Left Down
            ];

            for (let i = 0; i < shardsToSpawn; i++) {
              const angle = angles[i];
              const shardVx = Math.cos(angle) * 100;
              const shardVy = Math.sin(angle) * 100;
              
              // SYNERGY: Shards inherit modules, ricochet, pierce, chain chance from parent
              // This enables powerful combos where shards continue the parent's effects
              // VISUAL: Shards look like the tower type that spawned them (gatling/sniper/missile)
              const shard = {
                id: uid(),
                ownerId: b.ownerId,
                ownerSlot: b.ownerSlot,
                x: m.x,
                y: m.y,
                vx: shardVx,
                vy: shardVy,
                r: b.r * 0.6, // Smaller than parent but scales with caliber
                dmg: b.dmg * 0.3,
                isCrit: false,
                explosive: Math.floor(b.explosive * 0.5), // Half explosive power
                lifespan: 1.0,
                isTowerBullet: b.isTowerBullet,
                bulletType: b.bulletType, // VISUAL: Inherit parent's bullet type (gatling/sniper/missile/main)
                chainChance: b.chainChance, // Inherit chain lightning chance
                ricochet: b.ricochet, // Inherit ricochet stacks - shards can chain too!
                pierce: b.pierce, // Inherit pierce - shards can pierce too!
                hitSet: new Set([m.id]), 
                modules: shardModules, // SYNERGY: Inherit modules for combo effects!
                bulletColor: b.bulletColor, // VISUAL: Inherit custom color (e.g. from Confetti Cannon)
                skipThisTick: true, // Don't process until next tick
              };
              bullets.push(shard);

              // Notify client about these new shard bullets
              queueEvent("bulletSpawn", {
                id: shard.id,
                x: shard.x,
                y: shard.y,
                vx: shard.vx,
                vy: shard.vy,
                slot: shard.ownerSlot,
                isCrit: shard.isCrit,
                bulletColor: shard.bulletColor,
                bulletType: shard.bulletType, // VISUAL: Inherit tower type for rendering
                ricochet: shard.ricochet || 0, // For client-side ricochet/pierce order
                pierce: shard.pierce, // For client-side pierce prediction
                r: shard.r,
                lifespan: shard.lifespan // DESYNC FIX: Send lifespan for client expiration
              });
            }
          }
          
          // Quantum Displacer: 10% chance to teleport enemy to top (5% for bosses)
          // SYNERGY: Inherited by shards/ricochets - each child bullet has teleport chance!
          if (bulletModules.includes("quantumDisplacer") && m.hp > 0) {
            const teleportChance = (m.type === "boss" || m.isBoss) ? 0.05 : 0.10;
            if (Math.random() < teleportChance) {
              m.y = -m.r - 20;
              m.inFTL = true;
              queueEvent("teleport", { x: m.x, y: m.y });
            }
          }
          
          // Gravity Well: Create gravity pull effect
          // SYNERGY: Shards can create multiple gravity wells, ricochets leave wells at each bounce!
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
          // SYNERGY: All child bullets (shards, ricochets) contribute to healing pool!
          // NERFED: Now requires 400 accumulated damage (was 200) to heal 1 HP
          if (bulletModules.includes("vampiricNanobots") && owner) {
            owner.lifestealAccum = (owner.lifestealAccum || 0) + b.dmg * 2; // x2 because we halved damage
            if (owner.lifestealAccum >= 400) {
              const heals = Math.floor(owner.lifestealAccum / 400);
              owner.hp = Math.min(owner.maxHp, owner.hp + heals);
              owner.lifestealAccum = owner.lifestealAccum % 400;
              queueEvent("lifesteal", { slot: owner.slot, amount: heals });
            }
          }
          
          // Chain Reaction: Add static charge
          // SYNERGY: Shards add charge to multiple enemies, building up chain explosions faster!
          if (bulletModules.includes("chainReaction") && m.hp > 0) {
            m.staticCharge = (m.staticCharge || 0) + b.dmg;
            m.staticColor = "#ffff00";
          }
          
          // Ricochet (wave card): Spawn new bullet toward nearest enemy
          // SYNERGY: Ricochet bullets inherit ALL modules and stats from parent bullet
          // ORDER OF OPERATIONS: Ricochet is used FIRST until depleted, THEN pierce kicks in
          // -10% damage per bounce, vanishes if no target found
          // Triggers even if this asteroid dies from the hit
          if (b.ricochet > 0 && bullets.length < MAX_BULLETS) {
            // Find nearest enemy (excluding ones we've already hit)
            // PERFORMANCE: Added quick bounding box rejection
            const bounceRange = 250;
            const bounceRangeSq = bounceRange * bounceRange;
            let nearestTarget = null;
            let nearestDistSq = Infinity;
            
            const slotMissilesBounce = missilesBySlot[b.ownerSlot];
            for (let bi = 0; bi < slotMissilesBounce.length; bi++) {
              const m2 = slotMissilesBounce[bi];
              if (m2.dead || m2 === m || (b.hitSet && b.hitSet.has(m2.id))) continue;
              
              const dx = m2.x - m.x;
              if (dx > bounceRange || dx < -bounceRange) continue; // Quick X reject
              const dy = m2.y - m.y;
              if (dy > bounceRange || dy < -bounceRange) continue; // Quick Y reject
              
              const dSq = dx * dx + dy * dy;
              if (dSq < bounceRangeSq && dSq < nearestDistSq) {
                nearestDistSq = dSq;
                nearestTarget = m2;
              }
            }
            
            if (nearestTarget) {
              // Calculate intercept point using prediction
              const bulletSpeed = Math.hypot(b.vx, b.vy);
              
              // Safety check: bullet must have valid speed
              if (bulletSpeed < 1) {
                // Fall through to pierce logic
              } else {
                let speedMult = slotSpeedMultipliers[b.ownerSlot] || 1;
                // Include gravity increase in prediction
                const gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE;
                speedMult *= gravityMult;
                const intercept = calculateInterceptPoint(m.x, m.y, bulletSpeed, nearestTarget, speedMult);
                
                // Calculate direction to intercept point
                const dx = intercept.x - m.x;
                const dy = intercept.y - m.y;
                const dist = Math.hypot(dx, dy);
                
                // Safety check: must have valid direction
                if (dist < 0.1) {
                  // Target is at same position, just shoot toward target directly
                  const tdx = nearestTarget.x - m.x;
                  const tdy = nearestTarget.y - m.y;
                  const tdist = Math.hypot(tdx, tdy);
                  if (tdist > 0.1) {
                    // SYNERGY: Spawn fresh bullet that inherits everything from parent
                    const newBullet = {
                      id: uid(),
                      ownerId: b.ownerId,
                      ownerSlot: b.ownerSlot,
                      x: m.x + (tdx / tdist) * (m.r + 5),
                      y: m.y + (tdy / tdist) * (m.r + 5),
                      vx: (tdx / tdist) * bulletSpeed,
                      vy: (tdy / tdist) * bulletSpeed,
                      r: b.r,
                      dmg: b.dmg * 0.9,
                      isCrit: b.isCrit,
                      explosive: b.explosive,
                      lifespan: 3.0,
                      isTowerBullet: b.isTowerBullet,
                      bulletType: b.bulletType,
                      chainChance: b.chainChance,
                      ricochet: b.ricochet - 1,
                      pierce: b.pierce,
                      hitSet: (() => {
                        const newSet = new Set(b.hitSet);
                        newSet.add(m.id);
                        return newSet;
                      })(),
                      modules: b.modules || [],
                      bulletColor: b.bulletColor,
                      skipThisTick: true,
                    };
                    // Safety check for NaN
                    if (!isNaN(newBullet.x) && !isNaN(newBullet.vx)) {
                      bullets.push(newBullet);
                      queueEvent("bulletSpawn", {
                        id: newBullet.id, x: newBullet.x, y: newBullet.y,
                        vx: newBullet.vx, vy: newBullet.vy, slot: newBullet.ownerSlot,
                        isCrit: newBullet.isCrit, bulletColor: newBullet.bulletColor,
                        bulletType: newBullet.bulletType, ricochet: newBullet.ricochet,
                        pierce: newBullet.pierce, r: newBullet.r, lifespan: newBullet.lifespan
                      });
                      b.dead = true;
                      b.ricochetTriggered = true;
                    }
                  }
                } else {
                  // SYNERGY: Spawn fresh bullet that inherits everything from parent
                  // Modules, pierce, chain chance, explosive - all carry forward!
                  const newBullet = {
                    id: uid(),
                    ownerId: b.ownerId,
                    ownerSlot: b.ownerSlot,
                    x: m.x + (dx / dist) * (m.r + 5),
                    y: m.y + (dy / dist) * (m.r + 5),
                    vx: (dx / dist) * bulletSpeed,
                    vy: (dy / dist) * bulletSpeed,
                    r: b.r, // Inherit size (caliber upgrade)
                    dmg: b.dmg * 0.9, // -10% damage per bounce
                    isCrit: b.isCrit,
                    explosive: b.explosive, // Inherit explosive
                    lifespan: 3.0,
                    isTowerBullet: b.isTowerBullet,
                    bulletType: b.bulletType,
                    chainChance: b.chainChance, // Inherit chain lightning
                    ricochet: b.ricochet - 1, // Decrement ricochet counter
                    pierce: b.pierce, // Inherit pierce (used after ricochet depleted)
                    hitSet: (() => { // OPTIMIZED: Avoid spread operator allocation
                      const newSet = new Set(b.hitSet);
                      newSet.add(m.id);
                      return newSet;
                    })(),
                    modules: b.modules || [], // SYNERGY: Inherit ALL modules!
                    bulletColor: b.bulletColor,
                    skipThisTick: true, // Don't process this bullet until next tick
                  };
                  
                  // Safety check: only add bullet if it has valid position/velocity
                  if (!isNaN(newBullet.x) && !isNaN(newBullet.y) && !isNaN(newBullet.vx) && !isNaN(newBullet.vy)) {
                    bullets.push(newBullet);
                    
                    // Notify client about new bullet
                    queueEvent("bulletSpawn", {
                      id: newBullet.id,
                      x: newBullet.x,
                      y: newBullet.y,
                      vx: newBullet.vx,
                      vy: newBullet.vy,
                      slot: newBullet.ownerSlot,
                      isCrit: newBullet.isCrit,
                      bulletColor: newBullet.bulletColor,
                      bulletType: newBullet.bulletType, // Inherit tower type for rendering
                      ricochet: newBullet.ricochet, // For client-side ricochet/pierce order
                      pierce: newBullet.pierce, // For client-side pierce prediction
                      r: newBullet.r,
                      lifespan: newBullet.lifespan // DESYNC FIX: Send lifespan for client expiration
                    });
                    
                    // Original bullet dies after spawning ricochet - DO NOT let pierce override this
                    b.dead = true;
                    b.ricochetTriggered = true; // Flag to prevent pierce from overriding
                  }
                  // If NaN, fall through to pierce logic
                }
              }
            }
            // If no target found, DON'T set ricochetTriggered - fall through to pierce logic
            // This allows pierce to work when there's nothing to bounce to
          }
          
          // Pinball Wizard (boss module): Bounce between enemies up to 4 times
          // SYNERGY: Pinball redirects the SAME bullet, so all modules stay active!
          // Combos naturally: Pinball + Viral (infects each bounce), Pinball + Taxman (gold each hit)
          if (bulletModules.includes("pinballWizard") && m.hp > 0) {
            const maxBounces = 4;
            b.enemyBounces = (b.enemyBounces || 0) + 1;
            
            if (b.enemyBounces < maxBounces) {
              // Find nearest enemy within range (excluding ones we've already hit)
              // PERFORMANCE: Added quick bounding box rejection
              const bounceRange = 150;
              const bounceRangeSq = bounceRange * bounceRange;
              let nearestTarget = null;
              let nearestDistSq = Infinity;
              
              const slotMissilesBounce = missilesBySlot[b.ownerSlot];
              for (let bi = 0; bi < slotMissilesBounce.length; bi++) {
                const m2 = slotMissilesBounce[bi];
                if (m2.dead || m2 === m || (b.hitSet && b.hitSet.has(m2.id))) continue;
                
                const dx = m2.x - m.x;
                if (dx > bounceRange || dx < -bounceRange) continue; // Quick X reject
                const dy = m2.y - m.y;
                if (dy > bounceRange || dy < -bounceRange) continue; // Quick Y reject
                
                const dSq = dx * dx + dy * dy;
                if (dSq < bounceRangeSq && dSq < nearestDistSq) {
                  nearestDistSq = dSq;
                  nearestTarget = m2;
                }
              }
              
              if (nearestTarget) {
                // Redirect bullet towards new target
                const dx = nearestTarget.x - m.x;
                const dy = nearestTarget.y - m.y;
                const dist = Math.sqrt(nearestDistSq);
                const speed = Math.hypot(b.vx, b.vy);
                b.vx = (dx / dist) * speed;
                b.vy = (dy / dist) * speed;
                b.x = m.x + (dx / dist) * (m.r + 5); // Move bullet outside current enemy
                b.y = m.y + (dy / dist) * (m.r + 5);
                b.dead = false; // Keep bullet alive!
                // DESYNC FIX: Send bullet ID and new position/velocity so client can sync
                queueEvent("pinballBounce", { 
                  id: b.id, // Bullet ID so client can update the right bullet
                  x: b.x, y: b.y, // New position
                  vx: b.vx, vy: b.vy, // New velocity
                  tx: nearestTarget.x, ty: nearestTarget.y // Target for visual tracer
                });
              }
            }
          }
          
          // Taxman: Generate gold on hit (damage already reduced at bullet creation)
          // SYNERGY: Works with any bullet source - shards, ricochets, pinballs all generate gold!
          // BALANCE: 0.1 gold per hit (accumulates, awards 1 gold when >= 1.0)
          if (bulletModules.includes("taxman") && owner) {
            owner.taxmanAccum = (owner.taxmanAccum || 0) + 0.1;
            if (owner.taxmanAccum >= 1.0) {
              const goldToAdd = Math.floor(owner.taxmanAccum);
              owner.gold = (owner.gold || 0) + goldToAdd;
              owner.taxmanAccum -= goldToAdd;
              queueEvent("taxmanGold", { slot: owner.slot, x: m.x, y: m.y });
            }
          }
          
          // Viral Payload: Infect enemy with spreading DOT
          // SYNERGY: Shards, ricochets, pinballs can all spread infection!
          if (bulletModules.includes("viralPayload") && m.hp > 0) {
            if (!m.infected) {
              m.infected = true;
              m.infectionOwner = b.ownerId;
              m.infectionSlot = b.ownerSlot;
              m.infectionDamage = b.dmg * 0.5; // DOT = 50% of bullet damage per second
              m.infectionLife = 5.0; // Infection lasts 5 seconds
              queueEvent("infected", { id: m.id, x: m.x, y: m.y });
            }
          }
          
          // Tesla Coil: chance to consume bullet and create chain lightning
          const triggeredLightning = b.chainChance > 0 && Math.random() < b.chainChance;
          
          if (triggeredLightning) {
            // Consume bullet and hit 3 nearest enemies with lightning
            b.dead = true;
            
            // Find 3 nearest enemies (excluding current target) - use slot bucket
            // PERFORMANCE: Added quick bounding box rejection
            const lightningTargets = [];
            const range = 150;
            const rangeSq = range * range; // Squared lightning range
            const slotMissilesLightning = missilesBySlot[b.ownerSlot];
            for (let li = 0; li < slotMissilesLightning.length; li++) {
              const m2 = slotMissilesLightning[li];
              if (m2.dead || m2 === m) continue;
              
              const dx = m2.x - m.x;
              if (dx > range || dx < -range) continue; // Quick X reject
              const dy = m2.y - m.y;
              if (dy > range || dy < -range) continue; // Quick Y reject
              
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
          } else if (!b.ricochetTriggered) {
            // Normal bullet behavior (only if ricochet didn't already handle this bullet)
            // Pierce allows bullet to pass through enemies (only used after ricochet depleted)
            if (b.pierce > 0) { 
              b.pierce--; 
              b.dead = false; // Keep alive to pierce through
            } else { 
              b.dead = true; 
            }
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
                const goldMult = 1 + (owner.upgrades?.goldBonus || 0); // Additive gold bonus
                const goldReward = m.type === "large" ? 4 : m.type === "medium" ? 2 : 1;
                owner.gold = (owner.gold || 0) + Math.round(goldReward * goldMult);
              }
            }
            
            // When mini-boss dies, spawn any remaining minion waves
            if (m.isMiniBoss && m.bossSpawnCount < 3) {
              const remainingSpawns = 3 - m.bossSpawnCount;
              // ENTITY CAP: Limit total spawns
              let totalToSpawn = remainingSpawns * 3;
              totalToSpawn = Math.min(totalToSpawn, MAX_MISSILES - missiles.length);
              for (let k = 0; k < totalToSpawn; k++) {
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
              createExplosion(m.x, m.y, 40, "#ff4400");
            }
            
            // When boss dies, spawn any remaining minion waves
            if (m.type === "boss" && m.bossSpawnCount < 3) {
              // Track who killed the boss for module pick order (first kill = first pick)
              if (owner && !bossKillOrder.includes(owner.id)) {
                bossKillOrder.push(owner.id);
                broadcast({ t: "bossKilled", killerId: owner.id, killerName: owner.name, killPosition: bossKillOrder.length });
              }
              
              const remainingSpawns = 3 - m.bossSpawnCount;
              // ENTITY CAP: Limit total spawns
              let totalToSpawn = remainingSpawns * 5;
              totalToSpawn = Math.min(totalToSpawn, MAX_MISSILES - missiles.length);
              for (let k = 0; k < totalToSpawn; k++) {
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
              createExplosion(m.x, m.y, 80, "#ff0000");
            }
            // Also track boss killer if no remaining spawns
            else if (m.type === "boss" && owner && !bossKillOrder.includes(owner.id)) {
              bossKillOrder.push(owner.id);
              broadcast({ t: "bossKilled", killerId: owner.id, killerName: owner.name, killPosition: bossKillOrder.length });
            }
            
            // Splitter: spawn children with noGold flag
            if (m.splits > 0) {
              // ENTITY CAP: Limit splitter children
              const availableSlots = MAX_MISSILES - missiles.length;
              const splitsToSpawn = Math.min(m.splits, availableSlots, 8); // Also hard cap at 8
              if (splitsToSpawn > 0) {
                const extremeMult = wave >= 20 ? Math.pow(1.12, wave - 19) : 1;
                const splitHp = Math.ceil((0.5 + wave * 0.3) * extremeMult); // Reduced by 50% base, 25% scaling
                for (let s = 0; s < splitsToSpawn; s++) {
                  const nx = m.x + rand(-30, 30);
                  const ny = m.y + rand(-20, 20);
                  const splitAsteroid = createAsteroid(nx, ny, "small", splitHp, m.targetSlot, null, m.senderId, null, true); // noGold=true
                  missiles.push(splitAsteroid);
                }
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
      // PERFORMANCE: Added quick bounding box rejection
      const ghostSlotMissiles = missilesBySlot[ghost.ownerSlot];
      if (ghostSlotMissiles) {
        for (let gi = 0; gi < ghostSlotMissiles.length; gi++) {
          const m = ghostSlotMissiles[gi];
          if (m.dead || ghost.hitSet.has(m.id)) continue;
          
          const combinedR = ghost.r + m.r;
          const dx = m.x - ghost.x;
          if (dx > combinedR || dx < -combinedR) continue; // Quick X reject
          const dy = m.y - ghost.y;
          if (dy > combinedR || dy < -combinedR) continue; // Quick Y reject
          
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
    // PERFORMANCE: Added quick bounding box rejection before distance check
    // DIMINISHING RETURNS: Asteroids become resistant to gravity the longer they're exposed
    for (const well of gravityWells) {
      well.life -= DT;
      const radius = well.radius;
      const radiusSq = radius * radius;
      
      // Pull nearby enemies toward the well center - use slot bucket
      const wellSlotMissiles = missilesBySlot[well.ownerSlot];
      if (wellSlotMissiles) {
        for (let wi = 0; wi < wellSlotMissiles.length; wi++) {
          const m = wellSlotMissiles[wi];
          if (m.dead) continue;
          
          const dx = well.x - m.x;
          if (dx > radius || dx < -radius) continue; // Quick X reject
          const dy = well.y - m.y;
          if (dy > radius || dy < -radius) continue; // Quick Y reject
          
          const distSq = dx * dx + dy * dy;
          
          // Quick squared distance check before expensive sqrt
          if (distSq < radiusSq && distSq > 25) { // 25 = 5*5
            const dist = Math.sqrt(distSq);
            
            // DIMINISHING RETURNS: effectiveness = 1 / sqrt(1 + exposure/threshold)
            // After 1 second: ~71% effectiveness
            // After 2 seconds: ~58% effectiveness
            // After 4 seconds: ~45% effectiveness
            const exposureThreshold = 1.0; // Seconds before diminishing kicks in hard
            const diminishFactor = 1 / Math.sqrt(1 + m.gravityExposure / exposureThreshold);
            
            // Calculate pull strength
            const pullAccel = (well.strength / dist) * diminishFactor * 2;
            
            // Apply horizontal pull (can pull left/right freely)
            m.vx += (dx / dist) * pullAccel * DT;
            
            // Apply vertical pull with restrictions:
            // - Can slow down asteroids (reduce vy magnitude toward 0)
            // - Can speed up asteroids going down (increase positive vy)
            // - NEVER reverse direction to go upward (vy must stay >= 0)
            const vyPull = (dy / dist) * pullAccel * DT;
            const newVy = m.vy + vyPull;
            
            // Only apply if it doesn't make asteroid go upward
            if (newVy >= 0) {
              m.vy = newVy;
            } else {
              // Clamp to 0 - asteroid stops vertically but doesn't reverse
              m.vy = Math.max(0, m.vy * 0.95); // Slow down instead
            }
            
            // Small horizontal position pull for visual feedback
            const posPull = (well.strength / dist) * DT * diminishFactor * 0.3;
            m.x += (dx / dist) * posPull;
            // No vertical position pull - let velocity handle it
            
            // Track exposure time
            m.gravityExposure += DT;
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
    // PERFORMANCE: Added quick bounding box rejection before expensive distance calc
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
          
          const combinedR = m1.r + m2.r + 5;
          const dx = m2.x - m1.x;
          if (dx > combinedR || dx < -combinedR) continue; // Quick X reject
          const dy = m2.y - m1.y;
          if (dy > combinedR || dy < -combinedR) continue; // Quick Y reject
          
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
    
    // Viral Payload - process infection DOT and spreading
    // PERFORMANCE: Limit infection spread checks to prevent O(n²) lag at high wave counts
    for (let slot = 0; slot < 4; slot++) {
      const slotMissiles = missilesBySlot[slot];
      if (!slotMissiles || slotMissiles.length === 0) continue;
      
      // Count infected for rate limiting
      let spreadChecksThisSlot = 0;
      const maxSpreadChecksPerSlot = 50; // Limit O(n²) spread checks
      
      for (let i = 0; i < slotMissiles.length; i++) {
        const m1 = slotMissiles[i];
        if (m1.dead || !m1.infected) continue;
        
        // Apply DOT damage
        m1.infectionLife -= DT;
        const dotDamage = m1.infectionDamage * DT;
        m1.hp -= dotDamage;
        
        // Track damage for owner
        const infectionOwner = players.get(m1.infectionOwner);
        if (infectionOwner) {
          infectionOwner.damageDealt = (infectionOwner.damageDealt || 0) + dotDamage;
          infectionOwner.waveDamage = (infectionOwner.waveDamage || 0) + dotDamage;
        }
        
        // Infection expired
        if (m1.infectionLife <= 0) {
          m1.infected = false;
        }
        
        // Check if killed by infection
        if (m1.hp <= 0) {
          m1.dead = true;
          createExplosion(m1.x, m1.y, 20, "#00ff00");
          if (infectionOwner) {
            infectionOwner.score = (infectionOwner.score || 0) + 50;
            infectionOwner.kills = (infectionOwner.kills || 0) + 1;
          }
          continue;
        }
        
        // Check for collision-based spreading (rate limited)
        if (spreadChecksThisSlot >= maxSpreadChecksPerSlot) continue;
        
        for (let j = 0; j < slotMissiles.length; j++) {
          if (i === j) continue;
          const m2 = slotMissiles[j];
          if (m2.dead || m2.infected) continue;
          
          // PERFORMANCE: Quick bounding box check before expensive distance calc
          const combinedR = m1.r + m2.r + 5;
          const dx = m2.x - m1.x;
          if (dx > combinedR || dx < -combinedR) continue; // Quick X reject
          const dy = m2.y - m1.y;
          if (dy > combinedR || dy < -combinedR) continue; // Quick Y reject
          
          spreadChecksThisSlot++;
          
          if (dx * dx + dy * dy < combinedR * combinedR) {
            // Spread infection!
            m2.infected = true;
            m2.infectionOwner = m1.infectionOwner;
            m2.infectionSlot = m1.infectionSlot;
            m2.infectionDamage = m1.infectionDamage * 0.8; // Slightly weaker each spread
            m2.infectionLife = 4.0; // Fresh infection timer
            queueEvent("infectionSpread", { 
              x1: m1.x, y1: m1.y, 
              x2: m2.x, y2: m2.y 
            });
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
    const deadBulletIds = [];
    for (let i = 0; i < bullets.length; i++) {
      if (!bullets[i].dead) {
        bullets[writeIdx++] = bullets[i];
      } else {
        deadBulletIds.push(bullets[i].id);
      }
    }
    bullets.length = writeIdx;
    
    // OPTIMIZATION: Notify clients of dead bullets so they can remove them
    // This allows us to NOT send the full bullet list every frame
    if (deadBulletIds.length > 0) {
      queueEvent("bulletDeaths", { ids: deadBulletIds });
    }

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

    // SERVER AUTHORITATIVE: Broadcast at 22Hz - with client smoothing
    // OPTIMIZED: Reuse pre-allocated broadcastState to avoid GC pressure
    // ADAPTIVE: Throttle broadcasts based on entity count AND player count
    const entityCount = missiles.length + bullets.length;
    const playerCount = players.size;
    
    // Calculate broadcast skip factor:
    // - 1 player: every 2 ticks (22Hz)
    // - 2 players: every 2 ticks (22Hz)  
    // - 3 players: every 3 ticks (15Hz)
    // - 4 players: every 3 ticks (15Hz)
    // - High entities (>200): additional 2x slowdown
    let broadcastSkip = playerCount >= 3 ? 3 : BROADCAST_INTERVAL;
    if (entityCount > 200) broadcastSkip *= 2;
    
    if (tickCount % broadcastSkip === 0) {
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
  broadcastState.gravityMult = 1 + waveElapsedTime * GRAVITY_INCREASE_RATE; // Per-wave gravity increase
  broadcastState.spectatorCount = spectators.size;
  broadcastState.world.width = worldW;
  broadcastState.world.segmentWidth = SEGMENT_W;
  broadcastState.moduleCardPhase = moduleCardPhase;
  broadcastState.modulePickTimer = moduleCardPhase ? modulePickTimer : 0;
  broadcastState.currentModulePicker = moduleCardPhase ? modulePickOrder[currentModulePicker] : null;
  
  // PERFORMANCE: Use cached module card arrays (no .map() allocation every tick)
  broadcastState.moduleCards = moduleCardPhase ? cachedModuleCards : [];
  broadcastState.modulePickOrder = moduleCardPhase ? cachedPickOrder : [];
  
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
    
    // BANDWIDTH OPTIMIZATION: Only send dynamic data
    // Static data (r, type, maxHp, targetSlot) sent once in spawn event
    obj.x = Math.round(m.x * 10) / 10;
    obj.y = Math.round(m.y * 10) / 10;
    obj.vx = Math.round(m.vx * 10) / 10;
    obj.vy = Math.round(m.vy * 10) / 10;
    
    // Only send HP if damaged (saves bandwidth when at full health)
    if (m.hp < m.maxHp) {
      obj.hp = Math.round(m.hp * 10) / 10;
    } else {
      delete obj.hp;
    }
    
    // REMOVED FROM BROADCAST (client gets from spawn event cache):
    // - r (radius)
    // - type
    // - maxHp
    // - targetSlot
    delete obj.r;
    delete obj.type;
    delete obj.maxHp;
    delete obj.targetSlot;
    
    // Boolean flags - only send if true
    if (m.inFTL) obj.inFTL = true; else delete obj.inFTL;
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
    if (m.infected) obj.infected = true; else delete obj.infected;
  }
  // Truncate array to actual size (JSON.stringify respects .length)
  broadcastState.missiles.length = missileCount;
  
  // BANDWIDTH OPTIMIZATION: 
  // We do NOT send the full bullet list. Clients simulate bullets locally based on 
  // 'bulletSpawn' and 'bulletDeaths' events. This saves massive bandwidth.
  broadcastState.bullets.length = 0;
  
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
    obj.spite = p.spite || 0;
    obj.damageDealt = p.damageDealt || 0;
    obj.waveDamage = p.waveDamage || 0;
    obj.lastInterest = p.lastInterest || 0;
    obj.totalIncome = p.lastInterest || 0; // Total income earned last wave (for display to other players)
    obj.shieldActive = u.shieldActive || 0;
    obj.slowfield = !!u.slowfield;
    // Reuse upgrades object
    obj.upgrades.damageAdd = u.damageAdd || 0;
    obj.upgrades.bulletSpeedMult = u.bulletSpeedMult || 1;
    obj.upgrades.fireRateMult = u.fireRateMult || 1;
    obj.upgrades.multishot = u.multishot || 1;
    obj.upgrades.critChance = u.critChance || 0;
    obj.upgrades.explosive = u.explosive || 0;
    obj.upgrades.bulletSize = u.bulletSize || 1;
    obj.upgrades.pierce = u.pierce || 0;
	obj.upgrades.slowfield = u.slowfield || 0;
    obj.upgrades.ricochet = u.ricochet || 0;
    obj.upgrades.chainChance = u.chainChance || 0;
    obj.upgrades.goldBonus = u.goldBonus || 0; // Additive gold bonus (0 = no bonus, 0.12 = +12%)
  }
  broadcastState.players.length = playerCount;
  
  broadcastAll(broadcastState);
  
  // PERFORMANCE: Clear event queue without allocation (reuse array)
  eventQueue.length = 0;
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
  
  // PERFORMANCE: Disable Nagle's algorithm for lower latency
  // Nagle buffers small packets (200ms) which kills real-time games
  if (ws._socket) {
    ws._socket.setNoDelay(true);
  }
  
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
    spite: 0, // Death currency - earned while dead
    banishedUpgrades: [], // Upgrade def IDs permanently removed from this player's pool
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
    
    // Skip modifier intro
    if (msg.t === "skipModifier" && phase === "starting") {
      if (!modifierSkips.has(id)) {
        modifierSkips.add(id);
        
        // Broadcast updated skip count
        broadcast({
          t: "modifierSkipUpdate",
          skippedCount: modifierSkips.size,
          totalPlayers: lockedSlots.length
        });
        
        // If all players have skipped, start immediately
        if (modifierSkips.size >= lockedSlots.length) {
          actuallyStartGame(soloMode);
        }
      }
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
    
    // Ping/pong for latency measurement
    if (msg.t === "ping") {
      safeSend(ws, { t: "pong", ts: msg.ts });
      return;
    }
    
    if (msg.t === "input" && phase === "playing") {
      // RATE LIMITING: Prevent packet flood (max 50Hz per player)
      const now = Date.now();
      if (p.lastInputTime && (now - p.lastInputTime) < MIN_INPUT_INTERVAL) {
        return; // Drop packet - too fast
      }
      p.lastInputTime = now;
      
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

    // Banish an upgrade type permanently from player's pool (ONE TIME ONLY)
    if (msg.t === "banishUpgrade" && phase === "playing") {
      const queue = pendingUpgrades.get(id);
      if (!queue || queue.length === 0) return;
      
      const defId = msg.defId;
      if (!defId) return;
      
      // Check if this defId exists in UPGRADE_DEFS
      const def = UPGRADE_DEFS.find(d => d.id === defId);
      if (!def) return;
      
      // ONE BANISH PER GAME - check if already used
      if (!p.banishedUpgrades) p.banishedUpgrades = [];
      if (p.banishedUpgrades.length >= 1) {
        safeSend(p.ws, { t: "banishFailed", reason: "You can only banish once per game!" });
        return;
      }
      
      // Add to banished list FIRST
      p.banishedUpgrades.push(defId);
      
      // Generate new options without the banished type
      const current = queue[0];
      let newOptions = makeUpgradeOptions(p);
      
      // Safety check: filter out any options that somehow still have the banished defId
      newOptions = newOptions.filter(opt => opt.defId !== defId);
      
      // If we filtered out too many (shouldn't happen), regenerate
      while (newOptions.length < 3) {
        const extraOpts = makeUpgradeOptions(p);
        for (const opt of extraOpts) {
          if (opt.defId !== defId && !newOptions.find(o => o.defId === opt.defId)) {
            newOptions.push(opt);
            if (newOptions.length >= 3) break;
          }
        }
      }
      
      current.options = newOptions;
      
      const rerollCost = getRerollCost(current.rerollCount);
      
      // Notify player
      safeSend(p.ws, { 
        t: "upgradeBanished", 
        defId: defId,
        defName: def.name,
        options: newOptions,
        wave: current.wave,
        rerollCost: rerollCost,
        queueSize: queue.length,
        banishedCount: p.banishedUpgrades.length
      });
      
      broadcast({ t: "chatMsg", id: uid(), from: "SYSTEM", text: `${p.name} banished ${def.icon} ${def.name}!`, timestamp: Date.now() });
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
      // GAME MODIFIER: Pacifist Protocol - no attacks allowed
      if (activeGameModifier === "noMobs") {
        safeSend(ws, { t: "attackFailed", reason: "Attacks are disabled this game! (Pacifist Protocol)" });
        return;
      }
      
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
      const { cardIndex, moduleId } = msg;
      
      // Verify it's this player's turn
      if (modulePickOrder[currentModulePicker] !== p.id) return; // Not your turn
      if (modulePlayersPicked.has(p.id)) return; // Already picked
      
      // Find the card - prefer moduleId lookup for accuracy, fall back to index
      let actualIndex = -1;
      if (moduleId) {
        // Client sent module ID - find it in the array (handles sync issues)
        actualIndex = moduleCards.indexOf(moduleId);
      } else if (cardIndex >= 0 && cardIndex < moduleCards.length) {
        // Fall back to index if no moduleId sent
        actualIndex = cardIndex;
      }
      
      if (actualIndex < 0 || actualIndex >= moduleCards.length) return; // Invalid
      
      const actualModuleId = moduleCards[actualIndex];
      if (!TOWER_MODULES[actualModuleId]) return;
      
      // Mark player as picked
      modulePlayersPicked.add(p.id);
      
      // Add to player's inventory
      p.inventory.push(actualModuleId);
      
      // Remove from available cards
      moduleCards.splice(actualIndex, 1);
      
      // CRITICAL: Update cached array for state broadcasts
      cachedModuleCards = moduleCards.map(id => ({ id, ...TOWER_MODULES[id] }));
      
      // Announce pick and send updated card list
      broadcast({ 
        t: "moduleCardPicked", 
        playerId: p.id, 
        playerName: p.name, 
        moduleId: actualModuleId, 
        cardIndex: actualIndex,
        remainingCards: cachedModuleCards
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
          remainingCards: cachedModuleCards
        });
      }
    }

    // ===== MUSIC CONTROLS =====
    // In lobby: host controls music. In game: HIGHEST DAMAGE dealer controls music.
    const canControlMusic = () => {
      if (players.size <= 1) return true; // Solo player always controls
      
      if (phase === "lobby") {
        // In lobby, only host can control
        return id === hostId;
      } else {
        // In game, DAMAGE leader controls
        let maxDamage = -1;
        let leaderId = null;
        for (const [pid, player] of players) {
          const dmg = player.damageDealt || 0;
          if (dmg > maxDamage) {
            maxDamage = dmg;
            leaderId = pid;
          }
        }
        return id === leaderId;
      }
    };
    
    if (msg.t === "musicNext") {
      if (canControlMusic()) nextTrack();
    }
    if (msg.t === "musicPrev") {
      if (canControlMusic()) prevTrack();
    }
    if (msg.t === "musicSetTrack") {
      if (canControlMusic()) setTrack(msg.index);
    }
    if (msg.t === "musicToggleShuffle") {
      if (canControlMusic()) toggleShuffle();
    }
    if (msg.t === "musicTrackEnded") {
      // Client reports track ended - advance to next
      // Only process if this matches current track to avoid race conditions
      if (msg.track === musicState.currentTrack) {
        if (musicState.shuffle) {
          const currentOrderIndex = musicState.trackOrder.indexOf(musicState.currentTrack);
          const nextOrderIndex = (currentOrderIndex + 1) % musicState.trackOrder.length;
          musicState.currentTrack = musicState.trackOrder[nextOrderIndex];
        } else {
          musicState.currentTrack = (musicState.currentTrack + 1) % MUSIC_TRACKS.length;
        }
        musicState.startTime = Date.now();
        broadcastMusicState();
      }
    }
    if (msg.t === "getMusicState") {
      // Client requesting current music state (e.g., on connect)
      safeSend(ws, {
        t: "musicState",
        track: musicState.currentTrack,
        trackName: MUSIC_TRACKS[musicState.currentTrack],
        startTime: musicState.startTime,
        serverTime: Date.now(),
        playing: musicState.playing,
        shuffle: musicState.shuffle,
        trackList: MUSIC_TRACKS,
        hostId: hostId,
        phase: phase
      });
    }

    // ===== DEATH MODS (Spite System) =====
    if (msg.t === "useDeathMod" && phase === "playing") {
      const modId = msg.modId;
      const mod = DEATH_MODS[modId];
      if (!mod) return;
      
      // Must be dead to use death mods
      if (p.hp > 0) {
        safeSend(ws, { t: "deathModFailed", reason: "You must be dead to use death mods!" });
        return;
      }
      
      // Check spite cost
      if ((p.spite || 0) < mod.cost) {
        safeSend(ws, { t: "deathModFailed", reason: "Not enough spite!" });
        return;
      }
      
      // Deduct spite
      p.spite -= mod.cost;
      
      // Apply the death mod effect
      applyDeathMod(modId, p);
      
      // Notify everyone
      broadcast({ 
        t: "deathModUsed", 
        modId, 
        modName: mod.name,
        modIcon: mod.icon,
        playerName: p.name,
        playerId: p.id
      });
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