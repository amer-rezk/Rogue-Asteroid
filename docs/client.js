(() => {
  // ===== Configuration =====
  // Updated to new Netlify address
  const DEFAULT_SERVER = "wss://correct-jenni-no-name-orgs-8d502912.koyeb.app/ws";

  // ===== PERFORMANCE SETTINGS =====
  // Always use high quality settings - optimized for modern hardware
  const HIGH_QUALITY_SETTINGS = {
    useShadows: true,
    useGradients: false, // Still disabled - gradients are expensive
    useTrails: true,
    particleMultiplier: 1.0,
    maxDamageNumbers: 80,    // Increased from 50
    maxParticles: 200        // Increased from 150
  };
  
  // Client-side bullet cap (visual only - server is authoritative)
  const MAX_CLIENT_BULLETS = 600; // Increased from 400
  
  // PERFORMANCE: Track player count for scaling
  let lastKnownPlayerCount = 1;
  
  function updatePlayerCount(playerCount) {
    if (playerCount && playerCount !== lastKnownPlayerCount) {
      lastKnownPlayerCount = playerCount;
    }
  }
  
  // Optimized shadow functions
  function setShadowOpt(ctx, color, blur) {
    // HARD OPTIMIZATION: Never render shadows with 3+ players
    // The chaos on screen makes them unnoticeable, but the cost is huge
    if (lastKnownPlayerCount >= 3) return;
    
    if (blur > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
    }
  }
  
  function clearShadowOpt(ctx) {
    // Skip if shadows already disabled due to player count
    if (lastKnownPlayerCount >= 3) return;
    
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  // Polyfill for roundRect
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }

  // Player colors
  const PLAYER_COLORS = [
    { main: "#00ffff", dark: "#006666", name: "CYAN" },
    { main: "#ff00ff", dark: "#660066", name: "MAGENTA" },
    { main: "#00ff88", dark: "#006633", name: "GREEN" },
    { main: "#ffaa00", dark: "#664400", name: "ORANGE" },
  ];

  // Tower Config (must match server)
  const TOWER_TYPES = {
    0: { name: "Gatling", cost: 50, color: "#ffff00", desc: "Fast Fire", upgradeCost: 40, icon: "⚡" },
    1: { name: "Railgun", cost: 120, color: "#00ff00", desc: "Bouncing Beam", upgradeCost: 80, icon: "⚡" },
    2: { name: "Missile", cost: 250, color: "#ff0000", desc: "Splash Dmg", upgradeCost: 150, icon: "🚀" }
  };
  const MAX_TOWER_LEVEL = 5;

  // PvP Attack Types
  const ATTACK_TYPES = {
    swarm: { name: "Swarm", cost: 25, desc: "3 fast weak", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 35, desc: "Very tanky", color: "#ff4444", icon: "🪨" },
    carrier: { name: "Carrier", cost: 60, desc: "Spawns minions!", color: "#ff00ff", icon: "👑" },
    splitter: { name: "Splitter", cost: 50, desc: "Splits x15", color: "#00ffff", icon: "💎" },
    ghost: { name: "Ghost", cost: 40, desc: "2 phasing", color: "#8800ff", icon: "👻" },
    berserker: { name: "Berserker", cost: 0, desc: "Speeds up!", color: "#ff2200", icon: "🔥" }
  };

  // ===== DOM Elements =====
  const menuScreen = document.getElementById("menuScreen");
  const gameScreen = document.getElementById("gameScreen");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const serverSection = document.querySelector('#menuScreen .section:first-of-type');
  if (serverSection) {
    serverSection.innerHTML = `
      <label>SERVER STATUS</label>
      <div class="server-status-row">
        <div class="status-light-container">
          <div id="statusLED" class="led red"></div>
          <div id="statusText" class="status-text">OFFLINE</div>
        </div>
      </div>
    `;
  }

  const nameInput = document.getElementById("nameInput");
  const lobbyEl = document.getElementById("lobby");
  const playersEl = document.getElementById("players");
  const readyBtn = document.getElementById("readyBtn");
  const launchBtn = document.getElementById("launchBtn");
  const statusLED = document.getElementById("statusLED");
  const statusText = document.getElementById("statusText");
  const leaderboardPanel = document.getElementById("leaderboardPanel");
  const leaderboardList = document.getElementById("leaderboardList");
  const clearLeaderboardBtn = document.getElementById("clearLeaderboardBtn");

  // Load saved name from localStorage
  const savedName = localStorage.getItem("rogueAsteroidPlayerName");
  if (savedName && nameInput) {
    nameInput.value = savedName;
  }

  // ===== Boss Images =====
  const bossImages = {
    boss: new Image(),
    ad1: new Image(),
    ad2: new Image(),
    ad3: new Image(),
    ad4: new Image(),
    ad5: new Image()
  };
  let bossImagesLoaded = false;
  let imagesLoadedCount = 0;
  let imagesSuccessCount = 0;
  const totalImages = 6;
  
  function onBossImageLoad(name) {
    imagesLoadedCount++;
    imagesSuccessCount++;
    console.log(`✓ Boss image loaded: ${name} (${imagesSuccessCount}/${totalImages} successful)`);
    if (imagesLoadedCount >= totalImages) {
      bossImagesLoaded = imagesSuccessCount > 0; // Only mark loaded if at least one succeeded
      console.log(`Boss images ready: ${imagesSuccessCount}/${totalImages} loaded`);
    }
  }
  
  function onBossImageError(name) {
    console.warn(`✗ Failed to load boss image: ${name} - Check that file exists in docs/images/`);
    imagesLoadedCount++;
    if (imagesLoadedCount >= totalImages) {
      bossImagesLoaded = imagesSuccessCount > 0;
      console.log(`Boss images ready: ${imagesSuccessCount}/${totalImages} loaded`);
    }
  }
  
  // Load boss image
  bossImages.boss.onload = () => onBossImageLoad("Boss.png");
  bossImages.boss.onerror = () => onBossImageError("Boss.png");
  bossImages.boss.src = "images/Boss.png";
  
  // Load boss ad images (1-5)
  for (let i = 1; i <= 5; i++) {
    const imgName = `boss-ad-${i}.png`;
    bossImages[`ad${i}`].onload = () => onBossImageLoad(imgName);
    bossImages[`ad${i}`].onerror = () => onBossImageError(imgName);
    bossImages[`ad${i}`].src = `images/${imgName}`;
  }

  // ===== Main Turret Sprites =====
  const turretImages = {
    base: new Image(),
    barrel: new Image()
  };
  let turretImagesLoaded = false;
  let turretImagesCount = 0;
  
  function onTurretImageLoad(name) {
    turretImagesCount++;
    console.log(`✓ Turret image loaded: ${name}`);
    if (turretImagesCount >= 2) {
      turretImagesLoaded = true;
      console.log("Turret images ready");
    }
  }
  
  function onTurretImageError(name) {
    console.warn(`✗ Failed to load turret image: ${name}`);
    turretImagesCount++;
  }
  
  turretImages.base.onload = () => onTurretImageLoad("turret-main-base.png");
  turretImages.base.onerror = () => onTurretImageError("turret-main-base.png");
  turretImages.base.src = "images/turret-main-base.png";
  
  turretImages.barrel.onload = () => onTurretImageLoad("turret-main-barrel.png");
  turretImages.barrel.onerror = () => onTurretImageError("turret-main-barrel.png");
  turretImages.barrel.src = "images/turret-main-barrel.png";

  // ===== State =====
  let ws = null;
  let myId = null;
  let mySlot = 0;
  let isHost = false;
  let connected = false;

  let phase = "menu";
  let world = { width: 360, height: 600, segmentWidth: 360 };
  let wave = 0;

  let lobbyPlayers = [];
  let allReady = false;
  let readyCount = 0;
  let leaderboard = [];
  let lastSnap = null;
  let upgradeOptions = [];
  let upgradePicked = false;
  let upgradeQueueSize = 0; // How many upgrades are pending
  let upgradeWaveNum = 0; // Which wave this upgrade is from
  let attackHitFeedback = null; // Feedback when attack hits opponent
  let interestFeedback = null; // Feedback for wave interest
  let refundFeedback = null; // Feedback for attack refund
  
  // Death mod (spite) system
  let spiteFeedback = null; // Feedback when spite earned
  let deathModFeedback = null; // Feedback when death mod used
  let deathModError = null; // Feedback when death mod failed
  let goldStolenFeedback = null; // Curse of Greed stole gold
  let spiteDamageFeedback = null; // Shield Breaker damage
  let activeSpeedDemon = null; // Speed demon effect active
  let hoveredDeathMod = null; // Which death mod button is hovered
  
  const DEATH_MODS = {
    meteorShower: { id: "meteorShower", name: "Meteor Shower", icon: "☄️", cost: 2, desc: "Spawn 8 extra asteroids for all players" },
    speedDemon: { id: "speedDemon", name: "Speed Demon", icon: "💨", cost: 3, desc: "All enemies move 50% faster for 10 seconds" },
    curseOfGreed: { id: "curseOfGreed", name: "Curse of Greed", icon: "💸", cost: 4, desc: "Steal 15% gold from each living player" },
    shieldBreaker: { id: "shieldBreaker", name: "Shield Breaker", icon: "💔", cost: 5, desc: "All living players take 3 damage" },
    chaosRift: { id: "chaosRift", name: "Chaos Rift", icon: "🌀", cost: 7, desc: "Summon a mini-boss for each living player" }
  };
  let gameOverData = null;
  
  // Latency tracking
  let latency = 0;
  let lastPingTime = 0;
  let pingInterval = null;
  
  // Module Card System
  let moduleCardPhase = false;
  let moduleCards = [];
  let modulePickOrder = [];
  let currentModulePicker = null;
  let modulePickTimeLeft = 0;
  let moduleFeedback = null;
  let bossKillerFeedback = null;
  let moduleErrorFeedback = null;
  let selectedInventoryModule = null; // For drag-drop
  let hoveredModuleSlot = null; // Tower slot being hovered
  let hoveredModuleCard = -1; // Module card being hovered during selection
  let selectedInventoryIndex = -1; // Track which module we are holding
  
  // Pause system
  let gamePaused = false;
  let pauseCountdown = 0;
  let pausedBy = null;
  let hoveredPauseButton = false;
  
  // Spectator mode
  let isSpectator = false;
  let spectatorCount = 0;
  let canSpectate = false;
  let spectateReason = "";

  // Chat system
  let chatMessages = [];
  let chatOpen = false; // In-game chat popup state
  let chatUnread = 0; // Unread message count
  let chatInput = ""; // Current input text
  let chatInputFocused = false;
  let lastReadTimestamp = 0; // Track when chat was last viewed
  let gameChatInputText = ""; // In-game chat input

  // Input
  let mouseX = 0;
  let mouseY = 0;
  let mouseDown = false;
  let uiHovered = false; // Track if mouse is over any UI element (prevents shooting)
  let hoveredUpgrade = -1;
  let forcedDisconnect = false;

  // Build Mode State
  let buildMenuOpen = null;
  let hoveredBuildOption = -1;

  // PvP Attack Panel (always visible)
  let hoveredAttack = null;
  let incomingAttacks = [];
  let recentAttackSent = null; // For feedback animation
  let attackQuantityMode = 1; // 1, 10, or "max"
  let hoveredQuantityBtn = null; // Track which quantity button is hovered

  // Stats panel
  let statsPanelOpen = false;
  let hoveredStatsBtn = false;
  let showDamageNumbers = localStorage.getItem("rogueAsteroidDmgNumbers") !== "false"; // Default true

  // Upgrade reroll
  let currentRerollCost = 10;
  let hoveredReroll = false;
  let hoveredBanish = false;
  let banishMode = false; // When true, clicking a card banishes it instead of selecting it
  let banishedCount = 0;  // Number of upgrades player has banished
  let banishFeedback = null; // Feedback when banish succeeds
  let banishError = null; // Feedback when banish fails
  let hoveredOpponentTower = null; // { playerId, towerIndex, x, y, tower } - for showing module tooltip
  
  // Buy additional upgrade
  let buyUpgradeCost = 30;
  let hoveredBuyUpgrade = false;
  
  // GAME MODIFIERS
  let activeGameModifier = null; // Current game's modifier { id, name, icon, color, desc, flavor }
  let gameModifierCard = null; // Card animation state { modifier, animTime, phase }

  // Visual
  let stars = [];
  let time = 0;

  // CLIENT-SIDE RENDERING (offloaded from server)
  let clientParticles = [];      // Particles generated from events
  let clientBullets = [];        // Local bullet simulation
  let clientDamageNumbers = [];  // Damage numbers generated from events
  let clientLightning = [];      // Lightning effects from tesla coil
  let railgunBeams = [];         // Railgun beam visual effects
  let pendingTracers = [];       // Tracer lines for module effects
  let asteroidCache = new Map(); // Cache: id -> {vertices, rotSpeed, rotation, color}
  let lastUpdateTime = Date.now();
  
  // ===== MUSIC PLAYER =====
  let musicAudio = null;
  let musicPermissionGranted = localStorage.getItem("rogueAsteroidMusicPermission") === "true";
  let musicState = {
    track: 0,
    trackName: "",
    trackList: [],
    playing: true,
    shuffle: false,
    volume: parseFloat(localStorage.getItem("rogueAsteroidMusicVolume") || "0.5"),
    muted: localStorage.getItem("rogueAsteroidMusicMuted") === "true",
    serverStartTime: 0,
    serverTime: 0,
    expanded: false,  // UI expanded state
    syncing: false,
    hostId: null,     // Who controls music in lobby
    serverPhase: null // Server's current phase
  };
  let musicPlayerHover = null; // Which button is hovered
  let showMusicPermissionPrompt = false;
  
  function initMusicPlayer() {
    if (!musicAudio) {
      musicAudio = new Audio();
      musicAudio.volume = musicState.muted ? 0 : musicState.volume;
      musicAudio.preload = "auto"; // Hint to browser to load quickly
      musicAudio.addEventListener("ended", () => {
        // Report to server that track ended
        send({ t: "musicTrackEnded", track: musicState.track });
      });
      // Use 'canplay' instead of 'canplaythrough' - fires much sooner
      // canplaythrough waits until entire file can play without buffering (30+ seconds)
      // canplay fires when enough data is loaded to start playing
      musicAudio.addEventListener("canplay", () => {
        // Sync to server time when loaded
        syncMusicToServer();
      });
      // Also try on loadeddata as backup
      musicAudio.addEventListener("loadeddata", () => {
        syncMusicToServer();
      });
    }
    
    // Always request current music state from server
    send({ t: "getMusicState" });
    
    // Show permission prompt if not granted
    if (!musicPermissionGranted) {
      showMusicPermissionPrompt = true;
    }
  }
  
  function grantMusicPermission() {
    musicPermissionGranted = true;
    localStorage.setItem("rogueAsteroidMusicPermission", "true");
    showMusicPermissionPrompt = false;
    // Try to play immediately after user interaction
    if (musicAudio && musicState.trackName) {
      loadMusicTrack(musicState.trackName);
      musicAudio.play().catch(() => {});
    }
  }
  
  function syncMusicToServer() {
    if (!musicAudio || !musicState.trackName || musicState.syncing) return;
    if (!musicPermissionGranted) return; // Don't try to play without permission
    
    musicState.syncing = true;
    
    // Calculate how far into the track we should be
    const elapsed = (Date.now() - musicState.serverTime) + (musicState.serverTime - musicState.serverStartTime);
    const elapsedSeconds = elapsed / 1000;
    
    // Only sync if we're more than 0.5s off
    if (Math.abs(musicAudio.currentTime - elapsedSeconds) > 0.5) {
      musicAudio.currentTime = Math.max(0, elapsedSeconds);
    }
    
    if (musicState.playing && musicAudio.paused) {
      musicAudio.play().catch(() => {}); // Ignore autoplay errors
    }
    
    musicState.syncing = false;
  }
  
  function loadMusicTrack(trackName) {
    if (!musicAudio) initMusicPlayer();
    const url = `Music/${encodeURIComponent(trackName)}`;
    // Check if we need to load a new track
    if (!musicAudio.src.endsWith(encodeURIComponent(trackName))) {
      musicAudio.src = url;
      musicAudio.load();
      // Try to play immediately if we have permission (don't wait for canplay)
      if (musicPermissionGranted && musicState.playing) {
        musicAudio.play().catch(() => {});
      }
    }
  }
  
  function setMusicVolume(vol) {
    musicState.volume = Math.max(0, Math.min(1, vol));
    localStorage.setItem("rogueAsteroidMusicVolume", musicState.volume.toString());
    if (musicAudio && !musicState.muted) {
      musicAudio.volume = musicState.volume;
    }
  }
  
  function toggleMusicMute() {
    musicState.muted = !musicState.muted;
    localStorage.setItem("rogueAsteroidMusicMuted", musicState.muted.toString());
    if (musicAudio) {
      musicAudio.volume = musicState.muted ? 0 : musicState.volume;
    }
  }
  
  // SMOOTH INTERPOLATION for fluid movement
  let missileStates = new Map();  // id -> true (tracking only, no position prediction)
  let bulletStates = new Map();   // id -> true (tracking only, no position prediction)
  
  // Reusable objects to reduce GC pressure
  const tempIdSet = new Set();
  const prevMissilesMap = new Map(); // Reused for interpolation
  const prevBulletsMap = new Map();  // Reused for interpolation
  const rgbaCache = new Map(); // Cache for hexToRgba results

  // ===== Utilities =====
  function hexToRgba(hex, alpha) {
    // Use cache to avoid repeated string creation
    const key = hex + alpha;
    let result = rgbaCache.get(key);
    if (result) return result;
    
    let c = hex.replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    result = `rgba(${r},${g},${b},${alpha})`;
    
    // Limit cache size to prevent memory leak
    if (rgbaCache.size > 500) rgbaCache.clear();
    rgbaCache.set(key, result);
    return result;
  }

  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Performance helpers - shadow caching to avoid redundant state changes
  let currentShadowColor = null;
  let currentShadowBlur = 0;
  
  function setShadow(ctx, color, blur) {
    // Skip shadows with 3+ players for performance
    if (lastKnownPlayerCount >= 3) return;
    if (currentShadowColor !== color || currentShadowBlur !== blur) {
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
      currentShadowColor = color;
      currentShadowBlur = blur;
    }
  }
  
  function clearShadow(ctx) {
    if (lastKnownPlayerCount >= 3) return;
    if (currentShadowBlur !== 0) {
      ctx.shadowBlur = 0;
      currentShadowBlur = 0;
      currentShadowColor = null;
    }
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < 150; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        size: Math.random() * 1.2 + 0.3,
        speed: Math.random() * 0.01 + 0.002,
        twinkle: Math.random() * Math.PI * 2,
      });
    }
  }
  initStars();

  // ===== CLIENT-SIDE VISUAL EFFECTS (offloaded from server) =====
  function createClientParticle(x, y, color, count = 8, speedMult = 1) {
    // Use high quality settings
    const adjustedCount = Math.ceil(count * HIGH_QUALITY_SETTINGS.particleMultiplier);
    if (clientParticles.length >= HIGH_QUALITY_SETTINGS.maxParticles) return;
    
    for (let i = 0; i < adjustedCount; i++) {
      if (clientParticles.length >= HIGH_QUALITY_SETTINGS.maxParticles) break;
      const angle = (i / adjustedCount) * Math.PI * 2 + Math.random() * 0.5;
      const speed = (60 + Math.random() * 60) * speedMult;
      clientParticles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.2,
        maxLife: 0.5,
        color: color || "#f80",
        size: 2 + Math.random() * 2,
      });
    }
  }

  function createClientDamageNumber(x, y, amount, isCrit, customColor = null) {
    // Limit damage numbers for performance
    if (clientDamageNumbers.length >= HIGH_QUALITY_SETTINGS.maxDamageNumbers) {
      // Remove oldest damage number
      clientDamageNumbers.shift();
    }
    clientDamageNumbers.push({
      x, y,
      amount: typeof amount === 'string' ? amount : Math.round(amount * 10) / 10,
      isCrit,
      customColor,
      life: 1.0,
      vy: -60
    });
  }

  function createLightningEffect(points, isCrit, slot) {
    if (!points || points.length < 2) return;
    
    // Generate jagged lightning segments between each pair of points
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      segments.push(generateLightningBolt(start.x, start.y, end.x, end.y));
    }
    
    clientLightning.push({
      segments,
      isCrit,
      slot,
      life: 0.4,
      maxLife: 0.4
    });
  }

  function generateLightningBolt(x1, y1, x2, y2) {
    // Create jagged lightning path between two points
    const points = [{ x: x1, y: y1 }];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const segments = Math.max(4, Math.floor(dist / 15));
    
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const baseX = x1 + dx * t;
      const baseY = y1 + dy * t;
      // Perpendicular offset for jaggedness
      const perpX = -dy / dist;
      const perpY = dx / dist;
      const offset = (Math.random() - 0.5) * 30 * (1 - Math.abs(t - 0.5) * 2); // More offset in middle
      points.push({
        x: baseX + perpX * offset,
        y: baseY + perpY * offset
      });
    }
    points.push({ x: x2, y: y2 });
    return points;
  }

  function updateClientEffects(dt) {
	
	// Simulate local bullets (Bandwidth Fix + Wall/Ricochet Logic)
    // OPTIMIZED: Use forward iteration with swap-and-pop instead of splice
    const GROUND_Y = 560; // Matches server ground level
    
    // PERFORMANCE FIX: Bucket missiles by slot ONCE per frame
    // This turns O(bullets × all_missiles) into O(bullets × missiles_per_slot)
    // With 4 players: 48,000 checks → ~12,000 checks (4x faster)
    const missiles = lastSnap?.missiles || [];
    const missilesBySlot = [[], [], [], []]; // Pre-allocated for 4 slots
    
    for (let i = 0; i < missiles.length; i++) {
      const m = missiles[i];
      if (m.targetSlot !== undefined && m.targetSlot >= 0 && m.targetSlot < 4) {
        missilesBySlot[m.targetSlot].push(m);
      }
    }
    
    let bulletWriteIdx = 0;
    for (let i = 0; i < clientBullets.length; i++) {
      const b = clientBullets[i];
      
      // CLIENT-SIDE HOMING: Predict missile tracking between server updates
      if (b.isHoming) {
        const slotMissiles = missilesBySlot[b.slot];
        let target = null;
        
        // Try to find current target
        if (b.targetId && slotMissiles) {
          for (let mi = 0; mi < slotMissiles.length; mi++) {
            if (slotMissiles[mi].id === b.targetId) {
              target = slotMissiles[mi];
              break;
            }
          }
        }
        
        // If target dead or missing, find closest new target
        if (!target && slotMissiles && slotMissiles.length > 0) {
          let closestDist = Infinity;
          for (let mi = 0; mi < slotMissiles.length; mi++) {
            const m = slotMissiles[mi];
            const dx = m.x - b.x;
            const dy = m.y - b.y;
            const dist = dx * dx + dy * dy;
            if (dist < closestDist) {
              closestDist = dist;
              target = m;
            }
          }
          if (target) b.targetId = target.id;
        }
        
        // Steer toward target
        if (target) {
          const dx = target.x - b.x;
          const dy = target.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            const desiredVx = (dx / dist) * b.homingSpeed;
            const desiredVy = (dy / dist) * b.homingSpeed;
            const turnRate = 8;
            b.vx += (desiredVx - b.vx) * turnRate * dt;
            b.vy += (desiredVy - b.vy) * turnRate * dt;
            // Normalize speed
            const currentSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (currentSpeed > 0) {
              b.vx = (b.vx / currentSpeed) * b.homingSpeed;
              b.vy = (b.vy / currentSpeed) * b.homingSpeed;
            }
          }
        }
      }
      
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      
      b.lifespan -= dt;

      // Calculate lane boundaries for this bullet's owner
      // Default to 360 if world isn't loaded yet
      const segW = (world && world.segmentWidth) ? world.segmentWidth : 360;
      const x0 = b.slot * segW;
      const x1 = (b.slot + 1) * segW;
      
      // Temporal Boomerang & Boundary Logic
      const hitLeft = b.x < x0;
      const hitRight = b.x > x1;
      const hitTop = b.y < -50;
      const hitBottom = b.y > GROUND_Y;

      if (hitLeft || hitRight || hitTop || hitBottom) {
        // Temporal Boomerang: Bounce back to source on wall/ceiling hit
        // OPTIMIZED: Check the flag instead of searching a list
        if (b.isBoomerang && !b.returning && !hitBottom) {
           b.returning = true;
           if (b.hitSet) b.hitSet.clear(); // Reset hits so it can damage again
           
           // Aim back at source
           const sx = b.sourceX !== undefined ? b.sourceX : (x0 + segW/2);
           const sy = b.sourceY !== undefined ? b.sourceY : GROUND_Y;
           
           const dx = sx - b.x;
           const dy = sy - b.y;
           const dist = Math.hypot(dx, dy) || 1;
           const speed = Math.hypot(b.vx, b.vy);
           
           b.vx = (dx / dist) * speed;
           b.vy = (dy / dist) * speed;
           
           // Push back inside bounds so it doesn't get stuck
           if (hitLeft) b.x = x0 + 2;
           if (hitRight) b.x = x1 - 2;
           if (hitTop) b.y = -48;
           
           // Reset lifespan so it doesn't fade out
           b.lifespan = b.maxLifespan || 3.0;
        } else {
           continue; // Normal bullets die at border
        }
      }
      
      // CLIENT-SIDE COLLISION PREDICTION: Handle bullet-enemy hits with pierce
      // ORDER OF OPERATIONS: Ricochet first (if target exists), then pierce
      // OPTIMIZED: Only check missiles in the SAME SLOT (not all missiles)
      let shouldRemove = false;
      const slotMissiles = missilesBySlot[b.slot];
      if (slotMissiles) {
        for (let mi = 0; mi < slotMissiles.length; mi++) {
          const m = slotMissiles[mi];
          // Skip enemies we've already hit
          if (b.hitSet && b.hitSet.has(m.id)) continue;
          
          const dx = m.x - b.x;
          const dy = m.y - b.y;
          const rr = (m.r || 15) + (b.r || 3);
          if (dx * dx + dy * dy <= rr * rr) {
            // Hit! Add to hitSet
            if (!b.hitSet) b.hitSet = new Set();
            b.hitSet.add(m.id);
            
            // ORDER: Ricochet is used FIRST (if there's a target), then pierce
            // NOTE: Don't remove bullet on ricochet hit - let server handle it
            // Server will send bulletDeaths for old bullet and bulletSpawn for new one
            // This prevents desync when server's ricochet safety checks fail
            if (b.ricochet > 0) {
              // Check if there's another enemy to bounce to
              let hasBounceTarget = false;
              const bounceRange = 250;
              for (let bi = 0; bi < slotMissiles.length; bi++) {
                const m2 = slotMissiles[bi];
                if (m2 === m || (b.hitSet && b.hitSet.has(m2.id))) continue;
                const bdx = m2.x - m.x;
                const bdy = m2.y - m.y;
                if (bdx * bdx + bdy * bdy <= bounceRange * bounceRange) {
                  hasBounceTarget = true;
                  break;
                }
              }
              
              if (hasBounceTarget) {
                // Ricochet will trigger - but DON'T remove bullet yet!
                // Server will send bulletDeaths event when it actually spawns the ricochet
                // Just decrement ricochet count locally so we don't keep triggering
                b.ricochet--;
                break; // Stop checking for more hits this frame
              }
              // No bounce target - fall through to pierce
            }
            
            // Pierce logic (used when ricochet = 0 OR no bounce target)
            if (b.pierce > 0) {
              b.pierce--;
              // Don't remove, bullet continues through
            } else {
              // No pierce left - bullet dies
              shouldRemove = true;
              break;
            }
          }
        }
      }
      
      if (shouldRemove) {
        continue; // Don't keep - bullet died on hit
      }
      
      // Keep this bullet
      clientBullets[bulletWriteIdx++] = b;
    }
    clientBullets.length = bulletWriteIdx;
	 
    // Pre-calculate common values
    const damping = 1 - (1 - 0.95) * dt * 60; 
    
    // SMOOTHING FACTOR: Adjusts how fast objects snap to server position
    // Using time-based smoothing for consistency across frame rates
    // Higher value = snappier response, lower = smoother but more lag feel
    const smoothFactor = 1 - Math.pow(0.05, dt); // Slightly slower blend for smoother motion 

    // OPTIMIZED: Use swap-and-pop for all effect arrays to avoid O(n) splice operations
    
    // Update particles
    let particleWriteIdx = 0;
    for (let i = 0; i < clientParticles.length; i++) {
      const p = clientParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.vx *= damping;
      p.vy *= damping;
      if (p.life > 0) {
        clientParticles[particleWriteIdx++] = p;
      }
    }
    clientParticles.length = particleWriteIdx;
    
    // Update damage numbers
    let dmgWriteIdx = 0;
    for (let i = 0; i < clientDamageNumbers.length; i++) {
      const d = clientDamageNumbers[i];
      d.y += d.vy * dt;
      d.life -= dt * 1.5;
      if (d.life > 0) {
        clientDamageNumbers[dmgWriteIdx++] = d;
      }
    }
    clientDamageNumbers.length = dmgWriteIdx;
    
    // Update lightning effects
    let lightningWriteIdx = 0;
    for (let i = 0; i < clientLightning.length; i++) {
      const l = clientLightning[i];
      l.life -= dt;
      if (l.life > 0) {
        clientLightning[lightningWriteIdx++] = l;
      }
    }
    clientLightning.length = lightningWriteIdx;
    
    // Update tracer effects
    let tracerWriteIdx = 0;
    for (let i = 0; i < pendingTracers.length; i++) {
      const t = pendingTracers[i];
      t.life -= dt;
      if (t.life > 0) {
        pendingTracers[tracerWriteIdx++] = t;
      }
    }
    pendingTracers.length = tracerWriteIdx;
    
    // Update railgun beam effects
    let beamWriteIdx = 0;
    for (let i = 0; i < railgunBeams.length; i++) {
      const beam = railgunBeams[i];
      beam.life -= dt;
      if (beam.life > 0) {
        railgunBeams[beamWriteIdx++] = beam;
      }
    }
    railgunBeams.length = beamWriteIdx;
    
    // Update cached asteroid rotations
    for (const [id, data] of asteroidCache) {
      data.rotation += data.rotSpeed * dt;
    }

    // CLIENT-SIDE INTERPOLATION + EXTRAPOLATION
    // Use velocity to predict positions between server updates
    // This makes movement smooth even at 15Hz broadcast rate
    if (lastSnap) {
      // Smooth Missiles with velocity extrapolation
      if (lastSnap.missiles) {
        for (const m of lastSnap.missiles) {
          if (typeof m.targetX === 'number') {
            // EXTRAPOLATION: Use velocity to predict where asteroid should be
            // This fills in the gaps between 15-22Hz server updates
            if (m.vx !== undefined && m.vy !== undefined) {
              // Extrapolate target position based on velocity
              m.targetX += m.vx * dt;
              m.targetY += m.vy * dt;
            }
            
            // Smooth interpolation toward extrapolated target
            m.x += (m.targetX - m.x) * smoothFactor;
            m.y += (m.targetY - m.y) * smoothFactor;
          }
        }
      }
      // Smooth Bullets (already have their own simulation, just smooth)
      if (lastSnap.bullets) {
        for (const b of lastSnap.bullets) {
          if (typeof b.targetX === 'number') {
            b.x += (b.targetX - b.x) * smoothFactor;
            b.y += (b.targetY - b.y) * smoothFactor;
          }
        }
      }
    }
  }

  function processServerEvents(events, skipVisualEffects = false) {
    if (!events || !Array.isArray(events)) return;
    
    for (const ev of events) {
      switch (ev.t) {
        case "spawn":
          // BANDWIDTH OPTIMIZATION: Cache ALL static data from spawn event
          // Server no longer sends r, type, maxHp, targetSlot in state updates
          asteroidCache.set(ev.id, {
            // Visual data
            vertices: ev.vertices,
            rotSpeed: ev.rotSpeed,
            rotation: Math.random() * Math.PI * 2,
            color: ev.color || "#fa0",
            // Static data (stripped from broadcast to save bandwidth)
            r: ev.r,
            type: ev.type,
            maxHp: ev.hp, // HP at spawn = maxHp
            targetSlot: ev.targetSlot,
            attackType: ev.attackType,
            // Boss flags
            isBoss: ev.isBoss || false,
            isBossAd: ev.isBossAd || false,
            bossAdVariant: ev.bossAdVariant || null,
            isMiniBoss: ev.isMiniBoss || false,
            isMiniBossAd: ev.isMiniBossAd || false
          });
          // Just mark that we know about this missile (no position tracking)
          missileStates.set(ev.id, true);
          break;
          
        case "explosion":
          // Skip visual effects if tab was hidden
          if (!skipVisualEffects) {
            createClientParticle(ev.x, ev.y, ev.color, ev.radius > 30 ? 12 : 8, ev.radius / 25);
          }
          break;
          
        case "confettiExplosion":
          // 🎉🎊 CONFETTI PARTY EXPLOSION!!! 🎊🎉
          if (!skipVisualEffects) {
            const numParticles = 6 + Math.floor((ev.size || 5) / 2); // 50% fewer particles
            for (let i = 0; i < numParticles; i++) {
              const hue = (i / numParticles) * 360; // Rainbow distribution!
              const angle = (i / numParticles) * Math.PI * 2 + Math.random() * 0.5;
              const speed = 80 + Math.random() * 120;
              const size = 2 + Math.random() * 4;
              
              // Different shapes for confetti particles
              const shapeRand = Math.random();
              clientParticles.push({
                x: ev.x,
                y: ev.y,
                vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 40,
                vy: Math.sin(angle) * speed + (Math.random() - 0.5) * 40 - 30, // Upward bias
                life: 0.8 + Math.random() * 0.6,
                maxLife: 1.4,
                color: `hsl(${hue}, 100%, 65%)`,
                size: size,
                isConfetti: true, // Special flag for confetti rendering
                confettiShape: shapeRand < 0.33 ? 'star' : shapeRand < 0.66 ? 'square' : 'circle',
                spin: (Math.random() - 0.5) * 15, // Rotation speed
                rotation: Math.random() * Math.PI * 2
              });
            }
            
            // Extra sparkle burst (reduced by 50%)
            for (let i = 0; i < 4; i++) {
              const sparkAngle = Math.random() * Math.PI * 2;
              const sparkDist = 5 + Math.random() * 15;
              clientParticles.push({
                x: ev.x + Math.cos(sparkAngle) * sparkDist,
                y: ev.y + Math.sin(sparkAngle) * sparkDist,
                vx: Math.cos(sparkAngle) * 150,
                vy: Math.sin(sparkAngle) * 150 - 50,
                life: 0.3 + Math.random() * 0.2,
                maxLife: 0.5,
                color: '#ffffff',
                size: 1 + Math.random() * 2,
              });
            }
          }
          break;
          
        case "damage":
          if (!skipVisualEffects) {
            createClientDamageNumber(ev.x, ev.y, ev.amount, ev.isCrit);
          }
          break;
          
        case "lightning":
          // Tesla coil lightning effect
          if (!skipVisualEffects) {
            createLightningEffect(ev.points, ev.isCrit, ev.slot);
          }
          break;
          
        case "elusiveTeleport":
          // Quantum Drift teleport visual effect
          if (!skipVisualEffects) {
            // Ghost trail at old position
            for (let i = 0; i < 8; i++) {
              const angle = (i / 8) * Math.PI * 2;
              clientParticles.push({
                x: ev.oldX,
                y: ev.oldY,
                vx: Math.cos(angle) * 30,
                vy: Math.sin(angle) * 30,
                life: 0.4,
                maxLife: 0.4,
                color: "#aa88ff",
                size: 4 + Math.random() * 3
              });
            }
            // Arrival effect at new position
            for (let i = 0; i < 8; i++) {
              const angle = (i / 8) * Math.PI * 2;
              clientParticles.push({
                x: ev.newX,
                y: ev.newY,
                vx: Math.cos(angle) * 50,
                vy: Math.sin(angle) * 50,
                life: 0.5,
                maxLife: 0.5,
                color: "#ff88ff",
                size: 5 + Math.random() * 3
              });
            }
            // Connecting line tracer
            pendingTracers.push({
              x1: ev.oldX, y1: ev.oldY,
              x2: ev.newX, y2: ev.newY,
              color: "#aa88ff",
              life: 0.3
            });
          }
          break;
        
        case "railgun":
          // Railgun bouncing beam effect
          if (!skipVisualEffects && ev.segments && ev.segments.length > 0) {
            const beamColor = ev.isCrit ? "#ffff00" : "#00ff00";
            
            // Create beam for each segment
            for (const seg of ev.segments) {
              railgunBeams.push({
                x1: seg.x1, y1: seg.y1,
                x2: seg.x2, y2: seg.y2,
                slot: ev.slot,
                isCrit: ev.isCrit,
                life: 0.25,
                maxLife: 0.25,
                color: beamColor
              });
            }
            
            // Muzzle flash at origin
            const firstSeg = ev.segments[0];
            const firstAngle = Math.atan2(firstSeg.y2 - firstSeg.y1, firstSeg.x2 - firstSeg.x1);
            for (let i = 0; i < 6; i++) {
              const angle = firstAngle + (Math.random() - 0.5) * 0.5;
              clientParticles.push({
                x: firstSeg.x1,
                y: firstSeg.y1,
                vx: Math.cos(angle) * (60 + Math.random() * 40),
                vy: Math.sin(angle) * (60 + Math.random() * 40),
                life: 0.15 + Math.random() * 0.1,
                maxLife: 0.25,
                color: beamColor,
                size: 3 + Math.random() * 3
              });
            }
            
            // Spark particles at each bounce point
            for (let i = 0; i < ev.segments.length - 1; i++) {
              const seg = ev.segments[i];
              // Bounce point is at end of segment
              for (let j = 0; j < 4; j++) {
                const sparkAngle = Math.random() * Math.PI * 2;
                clientParticles.push({
                  x: seg.x2,
                  y: seg.y2,
                  vx: Math.cos(sparkAngle) * (40 + Math.random() * 30),
                  vy: Math.sin(sparkAngle) * (40 + Math.random() * 30),
                  life: 0.2 + Math.random() * 0.1,
                  maxLife: 0.3,
                  color: "#ffffff",
                  size: 2 + Math.random() * 2
                });
              }
            }
          }
          break;
          
        case "bulletSpawn":
          // Create local bullet from server event
          // PERFORMANCE: Cap client bullets to prevent overwhelming rendering
          if (clientBullets.length >= MAX_CLIENT_BULLETS) {
            // Drop oldest bullets if we're at cap
            clientBullets.shift();
          }
          // DESYNC FIX: Use 3.0 second lifespan to match server BULLET_LIFESPAN
          clientBullets.push({
            id: ev.id,
            x: ev.x, y: ev.y,
            vx: ev.vx, vy: ev.vy,
            r: ev.r || 3,
            isCrit: ev.isCrit,
            bulletColor: ev.bulletColor,
            bulletType: ev.bulletType, // For visual rendering (gatling/sniper/missile/main)
            slot: ev.slot,
            ricochet: ev.ricochet || 0,
            pierce: ev.pierce || 0, // For client-side pierce prediction
            hitSet: new Set(), // Track which enemies this bullet has hit
            lifespan: ev.lifespan || 3.0, // Match server BULLET_LIFESPAN
            isHoming: ev.isHoming || false, // Homing missile
            targetId: ev.targetId || null, // Target asteroid ID
            homingSpeed: Math.sqrt(ev.vx * ev.vx + ev.vy * ev.vy), // Store initial speed for homing
            
            // OPTIMIZED: Only store the boolean flag, not the heavy array
            isBoomerang: ev.isBoomerang || false,
            sourceX: ev.x,
            sourceY: ev.y,
            maxLifespan: ev.lifespan || 3.0,
            returning: false
          });
          break;

        case "bulletDeaths":
          // Remove bullets that died on server
          // OPTIMIZED: Use swap-and-pop instead of filter to avoid O(n) array allocation
          if (ev.ids && ev.ids.length > 0) {
            const deadSet = new Set(ev.ids);
            let writeIdx = 0;
            for (let i = 0; i < clientBullets.length; i++) {
              if (!deadSet.has(clientBullets[i].id)) {
                clientBullets[writeIdx++] = clientBullets[i];
              }
            }
            clientBullets.length = writeIdx;
          }
          break;
          
        case "pinballBounce":
          // Pinball Wizard bounce effect
          // DESYNC FIX: Sync bullet position and velocity from server
          if (ev.id) {
            for (let i = 0; i < clientBullets.length; i++) {
              if (clientBullets[i].id === ev.id) {
                clientBullets[i].x = ev.x;
                clientBullets[i].y = ev.y;
                clientBullets[i].vx = ev.vx;
                clientBullets[i].vy = ev.vy;
                break;
              }
            }
          }
          if (!skipVisualEffects) {
            createClientParticle(ev.x, ev.y, "#ff6600", 6, 0.8);
            // Draw tracer line to next target
            pendingTracers.push({
              x1: ev.x, y1: ev.y,
              x2: ev.tx, y2: ev.ty,
              color: "#ff6600",
              life: 0.3
            });
          }
          break;
          
        case "homingRetarget":
          // Homing missile retargeted to new enemy
          if (ev.bulletId) {
            for (let i = 0; i < clientBullets.length; i++) {
              if (clientBullets[i].id === ev.bulletId) {
                clientBullets[i].targetId = ev.targetId;
                clientBullets[i].x = ev.x;
                clientBullets[i].y = ev.y;
                clientBullets[i].vx = ev.vx;
                clientBullets[i].vy = ev.vy;
                break;
              }
            }
          }
          break;
          
        case "taxmanGold":
          // Taxman gold generation effect
          if (!skipVisualEffects) {
            createClientDamageNumber(ev.x, ev.y - 20, "+$1", false, "#00ff00");
          }
          break;
          
        case "infected":
          // Viral Payload infection effect
          if (!skipVisualEffects) {
            createClientParticle(ev.x, ev.y, "#00ff00", 10, 1.2);
          }
          break;
          
        case "infectionSpread":
          // Infection spreading between asteroids
          if (!skipVisualEffects) {
            pendingTracers.push({
              x1: ev.x1, y1: ev.y1,
              x2: ev.x2, y2: ev.y2,
              color: "#00ff00",
              life: 0.5
            });
            createClientParticle(ev.x2, ev.y2, "#00ff00", 8, 1.0);
          }
          break;
      }
    }
  }

  // ===== Networking =====
  function connect() {
    forcedDisconnect = false;
    if (statusText) statusText.textContent = "CONNECTING...";
    if (statusLED) statusLED.className = "led";

    if (ws) try { ws.close(); } catch { }

    // Hardcoded connection to your Koyeb server
    ws = new WebSocket(DEFAULT_SERVER);

    ws.onopen = () => {
      connected = true;
      if (statusText) {
        statusText.textContent = "ONLINE";
        statusText.className = "status-text connected";
      }
      if (statusLED) statusLED.className = "led green";

      lobbyEl.style.display = "block";

      const name = nameInput.value.trim() || `Player`;
      if (name) ws.send(JSON.stringify({ t: "setName", name }));
      
      // Start ping interval for latency measurement
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === 1) {
          lastPingTime = Date.now();
          ws.send(JSON.stringify({ t: "ping", ts: lastPingTime }));
        }
      }, 2000); // Ping every 2 seconds
    };

    ws.onclose = () => {
      connected = false;
      // Clear ping interval
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      latency = 0;
      
      const currentStatus = statusText?.textContent || "";
      const wasRejected = currentStatus.includes("PROGRESS") || currentStatus.includes("FULL");

      if (!wasRejected) {
        if (statusText) {
          statusText.textContent = "OFFLINE - RETRYING...";
          statusText.className = "status-text";
        }
        if (statusLED) statusLED.className = "led red";
      } else if (currentStatus.includes("PROGRESS")) {
        if (statusText) statusText.textContent = "GAME IN PROGRESS - RETRYING...";
      }

      lobbyEl.style.display = "none";

      if (!forcedDisconnect) {
        setTimeout(connect, 3000);
      } else if (phase !== "menu") {
        showMenu();
      }
    };

    ws.onerror = () => {
      if (statusText) statusText.textContent = "ERROR";
      if (statusLED) statusLED.className = "led red";
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case "pong":
        // Calculate round-trip latency
        if (msg.ts) {
          latency = Date.now() - msg.ts;
        }
        break;
        
      case "welcome":
        myId = msg.id;
        mySlot = msg.slot;
        isHost = msg.isHost;
        world = msg.world;
        phase = "lobby";
        // Reset spectator state
        isSpectator = false;
        canSpectate = false;
        hideSpectateOption();
        // Make sure lobby is visible
        if (lobbyEl) lobbyEl.style.display = "block";
        // Update attack types from server if provided
        if (msg.attackTypes) {
          for (const [key, val] of Object.entries(msg.attackTypes)) {
            if (ATTACK_TYPES[key]) {
              ATTACK_TYPES[key].cost = val.cost;
              ATTACK_TYPES[key].desc = val.desc || ATTACK_TYPES[key].desc;
            }
          }
        }
        // Store tower modules
        if (msg.towerModules) {
          window.TOWER_MODULES = msg.towerModules;
        }
        break;

      case "reject":
        if (statusText) {
          statusText.textContent = msg.reason.toUpperCase();
          statusText.className = "status-text";
        }
        if (msg.reason.toLowerCase().includes("full")) {
          forcedDisconnect = true;
          if (statusLED) statusLED.className = "led red";
        } else {
          forcedDisconnect = false;
          if (statusLED) statusLED.className = "led yellow";
        }
        break;
      
      case "spectateOffer":
        // Server is offering spectator mode
        canSpectate = msg.canSpectate;
        spectateReason = msg.reason;
        spectatorCount = msg.spectatorCount || 0;
        phase = "menu"; // Stay in menu phase
        if (statusText) {
          statusText.textContent = msg.reason.toUpperCase();
          statusText.className = "status-text";
        }
        if (statusLED) statusLED.className = "led yellow";
        // Hide lobby since we're not a player
        if (lobbyEl) lobbyEl.style.display = "none";
        // Make sure menu is visible
        showMenu();
        // Show spectate button if game in progress
        if (canSpectate) {
          showSpectateOption();
        }
        break;
      
      case "spectateStart":
        // Now spectating
        isSpectator = true;
        phase = "playing";
        world = msg.world;
        wave = msg.wave;
        spectatorCount = msg.spectatorCount || 0;
        // Update attack types from server
        if (msg.attackTypes) {
          for (const [key, val] of Object.entries(msg.attackTypes)) {
            if (ATTACK_TYPES[key]) {
              ATTACK_TYPES[key].cost = val.cost;
              ATTACK_TYPES[key].desc = val.desc || ATTACK_TYPES[key].desc;
            }
          }
        }
        // Clear client-side caches
        clientParticles = [];
        clientDamageNumbers = [];
        clientLightning = [];
        pendingTracers = [];
        railgunBeams = [];
        asteroidCache.clear();
        missileStates.clear();
        bulletStates.clear();
        showGame();
        break;
      
      case "spectateEnd":
        // Game ended, reconnect to join lobby
        isSpectator = false;
        if (statusText) {
          statusText.textContent = "GAME ENDED - RECONNECTING...";
          statusText.className = "status-text";
        }
        setTimeout(() => connect(), 1500);
        break;
      
      case "spectatorUpdate":
        spectatorCount = msg.count || 0;
        break;
      
      case "becameSpectator":
        // Successfully became a spectator from lobby
        isSpectator = true;
        spectatorCount = msg.spectatorCount || 0;
        myId = null; // No longer a player
        mySlot = -1;
        // Stay in lobby view but as spectator
        updateLobbyUI();
        break;

      case "kicked":
        if (statusText) {
          statusText.textContent = msg.reason?.toUpperCase() || "KICKED";
          statusText.className = "status-text";
        }
        if (statusLED) statusLED.className = "led red";
        forcedDisconnect = true;
        connected = false;
        break;

      case "lobby":
        lobbyPlayers = msg.players;
        allReady = msg.allReady;
        readyCount = msg.readyCount || 0;
        leaderboard = msg.leaderboard || [];
        isHost = msg.hostId === myId;
        if (phase === "playing" || phase === "upgrades" || phase === "gameover") {
          lastSnap = null;
          upgradeOptions = [];
          upgradePicked = false;
          waitingFor = [];
          gameOverData = null;
          wave = 0;
          buildMenuOpen = null;
          hoveredAttack = null;
          // Reset module card state
          moduleCardPhase = false;
          moduleCards = [];
          modulePickOrder = [];
          currentModulePicker = null;
          modulePickTimeLeft = 0;
          moduleFeedback = null;
          bossKillerFeedback = null;
          selectedInventoryModule = null;
          selectedInventoryIndex = -1;
          // Reset upgrade purchase state
          upgradeQueueSize = 0;
          currentRerollCost = 10;
          buyUpgradeCost = 30; // Reset buy upgrade cost
          hoveredBuyUpgrade = false;
          // Reset attack state
          incomingAttacks = [];
          recentAttackSent = null;
          attackQuantityMode = 1;
          // Reset pause state
          gamePaused = false;
          pauseCountdown = 0;
          pausedBy = null;
          // Reset death mod states
          spiteFeedback = null;
          deathModFeedback = null;
          deathModError = null;
          goldStolenFeedback = null;
          spiteDamageFeedback = null;
          activeSpeedDemon = null;
          // Reset banish states
          banishMode = false;
          banishedCount = 0;
          banishFeedback = null;
          banishError = null;
          // Reset game modifier state
          activeGameModifier = null;
          gameModifierCard = null;
          showMenu();
        }
        phase = "lobby";
        lobbyEl.style.display = "block";
        updateLobbyUI();
        // Music only plays during game, not in lobby
        break;
      
      case "gameModifier":
        // Game modifier card reveal - show animated card before game starts
        activeGameModifier = msg.modifier;
        gameModifierCard = {
          modifier: msg.modifier,
          animTime: 0,
          phase: "entering", // entering -> display -> exiting
          hasSkipped: false,
          skippedCount: msg.skippedCount || 0,
          totalPlayers: msg.totalPlayers || 1
        };
        // Show a transitional screen with the card (same as showGame but different phase)
        menuScreen.style.display = "none";
        lobbyEl.style.display = "none";
        gameScreen.style.display = "block";
        resizeCanvas();
        phase = "modifier_reveal";
        break;
      
      case "modifierSkipUpdate":
        // Update skip count during modifier reveal
        if (gameModifierCard) {
          gameModifierCard.skippedCount = msg.skippedCount;
          gameModifierCard.totalPlayers = msg.totalPlayers;
        }
        break;

      case "started":
        phase = "playing";
        world = msg.world;
        wave = msg.wave;
        upgradeOptions = [];
        upgradePicked = false;
        buildMenuOpen = null;
        incomingAttacks = [];
        // Store game modifier if provided
        if (msg.gameModifier) {
          // Keep the modifier info but clear the card animation
          gameModifierCard = null;
        }
        // Reset upgrade costs
        currentRerollCost = 10;
        buyUpgradeCost = 30;
        upgradeQueueSize = 0;
        // Reset pause state
        gamePaused = false;
        pauseCountdown = 0;
        pausedBy = null;
        // If this is a spectator watching from lobby, mark as spectator
        if (msg.isSpectator) {
          isSpectator = true;
        }
        // Clear client-side visual caches
        clientParticles = [];
        clientDamageNumbers = [];
        clientLightning = [];
        pendingTracers = [];
        railgunBeams = [];
        asteroidCache.clear();
        // Clear prediction states
        missileStates.clear();
        bulletStates.clear();
        // Initialize music player
        initMusicPlayer();
        showGame();
        break;

      case "musicState":
        // Synchronized music state from server
        musicState.track = msg.track;
        musicState.trackName = msg.trackName;
        musicState.trackList = msg.trackList || musicState.trackList;
        musicState.playing = msg.playing;
        musicState.shuffle = msg.shuffle;
        musicState.serverStartTime = msg.startTime;
        musicState.serverTime = msg.serverTime;
        musicState.hostId = msg.hostId; // Who controls in lobby
        musicState.serverPhase = msg.phase; // Server's current phase
        // Load and sync the track - ONLY during gameplay, not lobby
        if (msg.trackName && musicPermissionGranted && phase === "playing") {
          loadMusicTrack(msg.trackName);
          // Try to play immediately - don't wait for load events
          if (musicAudio) {
            syncMusicToServer();
            // Also set a short timeout to retry in case audio wasn't ready
            setTimeout(() => {
              if (musicAudio && musicAudio.paused && musicPermissionGranted && phase === "playing") {
                syncMusicToServer();
              }
            }, 500);
          }
        }
        break;

      case "wave":
        wave = msg.wave;
        // FIX: Comment out this line so the menu stays open!
        // selectedTower = null; 
        break;

      case "upgrade":
        upgradeOptions = msg.options;
        upgradePicked = false;
        banishMode = false; // Reset banish mode when new upgrade appears
        // Don't close buildMenuOpen - let tower menu stay open
        if (msg.rerollCost !== undefined) currentRerollCost = msg.rerollCost;
        if (msg.queueSize !== undefined) upgradeQueueSize = msg.queueSize;
        if (msg.wave !== undefined) upgradeWaveNum = msg.wave;
        break;

      case "upgradeQueued":
        // More upgrades pending - show indicator
        if (msg.queueSize !== undefined) upgradeQueueSize = msg.queueSize;
        break;

      case "upgradeQueueEmpty":
        upgradeOptions = [];
        upgradePicked = true;
        upgradeQueueSize = 0;
        banishMode = false;
        break;

      case "picked":
        upgradePicked = true;
        banishMode = false;
        break;

      case "upgradeBanished":
        // Upgrade was banished successfully
        upgradeOptions = msg.options;
        banishMode = false;
        if (msg.rerollCost !== undefined) currentRerollCost = msg.rerollCost;
        if (msg.queueSize !== undefined) upgradeQueueSize = msg.queueSize;
        if (msg.wave !== undefined) upgradeWaveNum = msg.wave;
        if (msg.banishedCount !== undefined) banishedCount = msg.banishedCount;
        // Show feedback
        banishFeedback = { name: msg.defName, time: Date.now() };
        break;

      case "banishFailed":
        // Banish failed
        banishMode = false;
        banishError = { reason: msg.reason, time: Date.now() };
        break;

      case "attackHit":
        // Show gold earned from attack hitting opponent
        attackHitFeedback = { gold: msg.gold, target: msg.target, time: Date.now() };
        break;

      case "interest":
        // Show interest earned at wave end
        interestFeedback = { amount: msg.amount, time: Date.now() };
        break;

      case "spiteEarned":
        // Dead player earned spite currency
        spiteFeedback = { spite: msg.spite, time: Date.now() };
        break;

      case "deathModUsed":
        // Someone used a death mod
        deathModFeedback = { 
          modName: msg.modName, 
          modIcon: msg.modIcon,
          playerName: msg.playerName,
          time: Date.now() 
        };
        break;

      case "deathModFailed":
        // Death mod failed
        deathModError = { reason: msg.reason, time: Date.now() };
        break;

      case "goldStolen":
        // Curse of Greed stole our gold
        goldStolenFeedback = { amount: msg.amount, by: msg.by, time: Date.now() };
        break;

      case "spiteDamage":
        // Shield Breaker damaged us
        spiteDamageFeedback = { amount: msg.amount, by: msg.by, time: Date.now() };
        break;

      case "deathModEffect":
        // A timed death mod effect started
        if (msg.effect === "speedDemon") {
          activeSpeedDemon = { endTime: Date.now() + msg.duration * 1000 };
        }
        break;

      case "deathModExpired":
        // A timed death mod effect ended
        if (msg.effect === "speedDemon") {
          activeSpeedDemon = null;
        }
        break;

      case "attackRefund":
        // Show refund when attack target is dead
        refundFeedback = { gold: msg.gold, reason: msg.reason, time: Date.now() };
        break;

      case "moduleCardPhase":
        // Boss wave ended - show module card selection
        moduleCardPhase = true;
        moduleCards = msg.cards || [];
        modulePickOrder = msg.pickOrder || [];
        currentModulePicker = msg.currentPicker;
        modulePickTimeLeft = msg.timeLeft || 10;
        break;

      case "modulePickTurn":
        // Next player's turn to pick
        currentModulePicker = msg.playerId;
        modulePickTimeLeft = msg.timeLeft || 10;
        // Update cards list from server
        if (msg.remainingCards) {
          moduleCards = msg.remainingCards;
        }
        break;

      case "moduleCardPicked":
        // A player picked a card - use server's authoritative card list
        if (msg.remainingCards) {
          moduleCards = msg.remainingCards;
        } else {
          moduleCards = moduleCards.filter((c, i) => i !== msg.cardIndex);
        }
        if (msg.playerId === myId) {
          // We picked - show confirmation and clear our turn
          moduleFeedback = { moduleId: msg.moduleId, time: Date.now() };
          // Clear current picker until server tells us who's next
          // This prevents double-picks if events arrive out of order
          currentModulePicker = null;
        }
        break;

      case "moduleCardPhaseEnd":
        // Module selection done
        moduleCardPhase = false;
        moduleCards = [];
        break;

      case "bossKilled":
        // Show boss killer announcement
        bossKillerFeedback = { name: msg.killerName, isMe: msg.killerId === myId, position: msg.killPosition || 1, time: Date.now() };
        break;

      case "moduleSlotted":
        // Module was slotted into tower
        break;

      case "moduleError":
        // Show error (module locked, etc)
        moduleErrorFeedback = { error: msg.error, time: Date.now() };
        break;

      case "gamePaused":
        // Game was paused
        gamePaused = true;
        pausedBy = msg.pausedBy;
        pauseCountdown = 0;
        break;

      case "gameUnpausing":
        // Countdown started to resume
        pauseCountdown = msg.countdown;
        break;

      case "gameResumed":
        // Game has resumed
        gamePaused = false;
        pauseCountdown = 0;
        pausedBy = null;
        break;

      case "state":
        // Process server events
        if (msg.events) {
          processServerEvents(msg.events, !isTabVisible);
        }

        // PREPARE FOR INTERPOLATION
        // OPTIMIZED: Reuse Maps instead of creating new ones every frame
        prevMissilesMap.clear();
        prevBulletsMap.clear();

        if (lastSnap) {
          if (lastSnap.missiles) {
            for (let i = 0; i < lastSnap.missiles.length; i++) {
              const m = lastSnap.missiles[i];
              prevMissilesMap.set(m.id, m);
            }
          }
          if (lastSnap.bullets) {
            for (let i = 0; i < lastSnap.bullets.length; i++) {
              const b = lastSnap.bullets[i];
              prevBulletsMap.set(b.id, b);
            }
          }
        }

        // Process Missiles: Set Targets, Keep Current Visual Position
        // BANDWIDTH OPTIMIZATION: Hydrate static data from cache (server no longer sends it)
        if (msg.missiles) {
          tempIdSet.clear();
          for (const m of msg.missiles) {
            tempIdSet.add(m.id);
            const cached = asteroidCache.get(m.id);
            if (cached) {
              // Visual data
              m.vertices = cached.vertices;
              m.rotation = cached.rotation;
              m.color = cached.color;
              
              // HYDRATE STATIC DATA (stripped from broadcast to save bandwidth)
              m.r = cached.r;
              m.type = cached.type;
              m.maxHp = cached.maxHp;
              m.targetSlot = cached.targetSlot;
              m.attackType = cached.attackType;
              
              // If server didn't send HP, asteroid is at full health
              if (m.hp === undefined) m.hp = cached.maxHp;
              
              // Boss flags (also cached since they don't change)
              m.isBoss = cached.isBoss;
              m.isBossAd = cached.isBossAd;
              m.bossAdVariant = cached.bossAdVariant;
              m.isMiniBoss = cached.isMiniBoss;
              m.isMiniBossAd = cached.isMiniBossAd;
            }
            
            // MAGIC: Store the server position as "target", use old visual position as "current"
            m.targetX = m.x;
            m.targetY = m.y;
            
            const prev = prevMissilesMap.get(m.id);
            if (prev) {
              // Start this frame at the old visual position to prevent jumping
              m.x = prev.x; 
              m.y = prev.y;
            }
            // If new, it spawns at m.x/m.y (from server) immediately
          }
          // Clean up cache
          for (const id of asteroidCache.keys()) {
            if (!tempIdSet.has(id)) asteroidCache.delete(id);
          }
        }

        // Process Bullets: Same logic
        if (msg.bullets) {
          for (const b of msg.bullets) {
            b.targetX = b.x;
            b.targetY = b.y;
            
            const prev = prevBulletsMap.get(b.id);
            if (prev) {
              b.x = prev.x;
              b.y = prev.y;
            }
          }
        }

        // Track player count for performance scaling
        const playerCount = msg.players?.length || 1;
        updatePlayerCount(playerCount);
        
        // Use client-side particles/damage numbers
        if (!msg.particles || msg.particles.length === 0) msg.particles = clientParticles;
        if (!msg.damageNumbers || msg.damageNumbers.length === 0) msg.damageNumbers = clientDamageNumbers;
        
        // Update global state
        lastSnap = msg;
        phase = msg.phase;
        wave = msg.wave;
        world = msg.world;
        
        // Safety: Clear interaction states if player is dead
        if (msg.players) {
          const myP = msg.players.find(p => p.id === myId);
          if (myP && myP.hp <= 0) {
            // Player is dead - clear any stuck interaction states
            selectedInventoryIndex = -1;
            selectedInventoryModule = null;
            buildMenuOpen = null;
          }
        }
        
        if (msg.spectatorCount !== undefined) spectatorCount = msg.spectatorCount;
        if (msg.moduleCardPhase !== undefined) moduleCardPhase = msg.moduleCardPhase;
        if (msg.modulePickTimer !== undefined) modulePickTimeLeft = msg.modulePickTimer;
        if (msg.currentModulePicker !== undefined) currentModulePicker = msg.currentModulePicker;
        if (msg.moduleCards !== undefined && msg.moduleCards.length > 0) moduleCards = msg.moduleCards;
        if (msg.modulePickOrder !== undefined && msg.modulePickOrder.length > 0) modulePickOrder = msg.modulePickOrder;
        
        if (msg.gamePaused !== undefined) gamePaused = msg.gamePaused;
        if (msg.pauseCountdown !== undefined) pauseCountdown = msg.pauseCountdown;
        if (msg.pausedBy !== undefined) pausedBy = msg.pausedBy;
        break;

      case "attackQueued":
        // Visual feedback that attack was queued
        recentAttackSent = { type: msg.attackType, target: msg.targetName, time: Date.now() };
        break;

      case "incomingAttack":
        incomingAttacks.push({ type: msg.attackType, from: msg.from, time: Date.now() });
        break;

      case "gameOver":
        phase = "gameover";
        gameOverData = msg;
        buildMenuOpen = null;
        // Stop the music completely
        if (musicAudio) {
          musicAudio.pause();
          musicAudio.currentTime = 0;
          musicAudio.src = ""; // Clear the source to prevent auto-resume
        }
        // Clear music state
        musicState.trackName = "";
        // If spectating, auto-reconnect after showing results
        if (isSpectator || msg.wasSpectating) {
          setTimeout(() => {
            isSpectator = false;
            connect();
          }, 6000);
        }
        break;

      case "chatHistory":
        chatMessages = msg.messages || [];
        lastReadTimestamp = Date.now();
        chatUnread = 0;
        updateChatUI();
        break;

      case "chatMsg":
        chatMessages.push({
          id: msg.id,
          from: msg.from,
          text: msg.text,
          timestamp: msg.timestamp
        });
        if (chatMessages.length > 50) chatMessages.shift();
        // Count as unread if chat is closed (in game) or we're in game
        if (phase !== "lobby" && phase !== "menu" && !chatOpen) {
          chatUnread++;
        }
        updateChatUI();
        break;
    }
  }

  // ===== UI =====
  function showMenu() {
    phase = "menu";
    menuScreen.style.display = "flex";
    gameScreen.style.display = "none";
  }

  function showGame() {
    menuScreen.style.display = "none";
    gameScreen.style.display = "block";
    resizeCanvas();
  }
  
  function showSpectateOption() {
    // Show a "Watch Game" button prominently in the menu
    let spectateContainer = document.getElementById("spectateContainer");
    if (!spectateContainer) {
      spectateContainer = document.createElement("div");
      spectateContainer.id = "spectateContainer";
      spectateContainer.style.cssText = "text-align: center; padding: 20px; margin-top: 20px;";
      
      const infoText = document.createElement("div");
      infoText.style.cssText = "color: #888; font-size: 14px; margin-bottom: 15px;";
      infoText.textContent = "A game is currently in progress";
      spectateContainer.appendChild(infoText);
      
      const spectateBtn = document.createElement("button");
      spectateBtn.id = "spectateBtn";
      spectateBtn.className = "btn spectate";
      spectateBtn.textContent = "👁 WATCH GAME";
      spectateBtn.style.cssText = "background: linear-gradient(180deg, #2a4a6a 0%, #1a2a3a 100%); border: 2px solid #4af; font-size: 16px; padding: 12px 24px;";
      spectateBtn.onclick = () => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "spectate" }));
        }
      };
      spectateContainer.appendChild(spectateBtn);
      
      // Insert after status area or at end of menu
      const statusArea = document.querySelector(".status-area");
      if (statusArea && statusArea.parentNode) {
        statusArea.parentNode.insertBefore(spectateContainer, statusArea.nextSibling);
      } else {
        menuScreen.appendChild(spectateContainer);
      }
    }
    spectateContainer.style.display = "block";
    
    const spectateBtn = document.getElementById("spectateBtn");
    if (spectateBtn) {
      const countText = spectatorCount > 0 ? ` (${spectatorCount} watching)` : "";
      spectateBtn.textContent = `👁 WATCH GAME${countText}`;
    }
  }
  
  function hideSpectateOption() {
    const spectateContainer = document.getElementById("spectateContainer");
    if (spectateContainer) spectateContainer.style.display = "none";
    const spectateBtn = document.getElementById("spectateBtn");
    if (spectateBtn) spectateBtn.style.display = "none";
  }

  function updateLobbyUI() {
    playersEl.innerHTML = "";
    for (const p of lobbyPlayers) {
      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      const isMe = p.id === myId;
      const div = document.createElement("div");
      div.className = "player-card" + (p.ready ? " ready" : "");
      div.innerHTML = `
        <div class="player-color" style="background:${color.main}"></div>
        <div class="player-info">
          <div class="player-name" style="color:${color.main}">${p.name}${isMe ? " (you)" : ""}</div>
          <div class="player-status">${p.ready ? "✓ READY" : "waiting..."}</div>
        </div>
      `;
      playersEl.appendChild(div);
    }
    
    // Show spectator count in lobby
    let spectatorInfo = document.getElementById("lobbySpectatorInfo");
    if (!spectatorInfo) {
      spectatorInfo = document.createElement("div");
      spectatorInfo.id = "lobbySpectatorInfo";
      spectatorInfo.style.cssText = "text-align: center; color: #888; font-size: 12px; margin-top: 10px;";
      playersEl.parentNode.insertBefore(spectatorInfo, playersEl.nextSibling);
    }
    if (spectatorCount > 0) {
      spectatorInfo.textContent = `👁 ${spectatorCount} spectator${spectatorCount > 1 ? 's' : ''} watching`;
      spectatorInfo.style.display = "block";
    } else {
      spectatorInfo.style.display = "none";
    }
    
    // If we're a spectator, show spectator UI
    if (isSpectator) {
      readyBtn.style.display = "none";
      launchBtn.style.display = "none";
      
      // Show spectator status
      let spectatorStatus = document.getElementById("lobbySpectatorStatus");
      if (!spectatorStatus) {
        spectatorStatus = document.createElement("div");
        spectatorStatus.id = "lobbySpectatorStatus";
        spectatorStatus.style.cssText = "text-align: center; padding: 15px; background: rgba(255,100,100,0.2); border: 1px solid #f66; border-radius: 8px; margin: 15px 0;";
        spectatorStatus.innerHTML = `
          <div style="font-size: 18px; margin-bottom: 5px;">👁 SPECTATOR MODE</div>
          <div style="font-size: 12px; color: #aaa;">Watching lobby - game will start when players are ready</div>
        `;
        readyBtn.parentNode.insertBefore(spectatorStatus, readyBtn);
      }
      spectatorStatus.style.display = "block";
      
      // Hide become spectator button
      const becomeSpecBtn = document.getElementById("becomeSpectatorBtn");
      if (becomeSpecBtn) becomeSpecBtn.style.display = "none";
      
      return;
    }
    
    // Normal player UI
    let spectatorStatus = document.getElementById("lobbySpectatorStatus");
    if (spectatorStatus) spectatorStatus.style.display = "none";
    
    const me = lobbyPlayers.find(p => p.id === myId);
    readyBtn.textContent = me?.ready ? "✓ READY" : "READY UP";
    readyBtn.className = "btn" + (me?.ready ? " ready" : "");
    readyBtn.style.display = "block";
    
    // Launch button: show if ready, enable force start if some players ready
    const canForceStart = readyCount >= 1 && !allReady && me?.ready;
    launchBtn.style.display = me?.ready ? "block" : "none";
    launchBtn.disabled = !allReady && !canForceStart;
    
    if (allReady) {
      launchBtn.textContent = "▶ BATTLE";
      launchBtn.className = "btn launch";
    } else if (canForceStart) {
      launchBtn.textContent = `⚡ FORCE (${readyCount}/${lobbyPlayers.length})`;
      launchBtn.className = "btn launch force";
    } else {
      launchBtn.textContent = "▶ BATTLE";
      launchBtn.className = "btn launch disabled";
    }
    
    // Add "Become Spectator" button if not already spectating
    let becomeSpecBtn = document.getElementById("becomeSpectatorBtn");
    if (!becomeSpecBtn) {
      becomeSpecBtn = document.createElement("button");
      becomeSpecBtn.id = "becomeSpectatorBtn";
      becomeSpecBtn.className = "btn";
      becomeSpecBtn.textContent = "👁 SPECTATE INSTEAD";
      becomeSpecBtn.style.cssText = "margin-top: 10px; background: linear-gradient(180deg, #444 0%, #222 100%); border: 2px solid #666; font-size: 12px; padding: 8px 16px;";
      becomeSpecBtn.onclick = () => {
        if (confirm("Leave player slot and become a spectator?")) {
          send({ t: "becomeSpectator" });
        }
      };
      // Insert after launch button
      if (launchBtn && launchBtn.parentNode) {
        launchBtn.parentNode.insertBefore(becomeSpecBtn, launchBtn.nextSibling);
      }
    }
    becomeSpecBtn.style.display = "block";
    
    // Update leaderboard
    updateLeaderboardUI();
  }
  
  function updateLeaderboardUI() {
    if (!leaderboardList) return;
    
    if (leaderboard && leaderboard.length > 0) {
      leaderboardList.innerHTML = "";
      // Add a header row for clarity
      const header = document.createElement("div");
      header.className = "leaderboard-entry header";
      header.style.color = "#888";
      header.style.fontSize = "10px";
      header.innerHTML = `
        <div class="leaderboard-rank">#</div>
        <div class="leaderboard-name">NAME</div>
        <div class="leaderboard-score">DAMAGE</div>
        <div class="leaderboard-wave">WAVE</div>
      `;
      leaderboardList.appendChild(header);

      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const div = document.createElement("div");
        const rankClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
        div.className = "leaderboard-entry " + rankClass;
        
        // Handle old scores (fallback to score if damage is missing)
        const displayValue = entry.damage !== undefined ? Math.round(entry.damage) : (Math.round(entry.score) + " (pts)");
        
        div.innerHTML = `
          <div class="leaderboard-rank">#${i + 1}</div>
          <div class="leaderboard-name">${entry.name}</div>
          <div class="leaderboard-score">${displayValue}</div>
          <div class="leaderboard-wave">W${entry.wave}</div>
        `;
        leaderboardList.appendChild(div);
      }
    } else {
      leaderboardList.innerHTML = '<div class="leaderboard-empty">No records yet!</div>';
    }
  }
  
  // Clear leaderboard button with password
  if (clearLeaderboardBtn) {
    clearLeaderboardBtn.addEventListener("click", () => {
      const password = prompt("Enter password to clear leaderboard:");
      if (password === "1122") {
        send({ t: "clearLeaderboard", password: password });
      } else if (password !== null) {
        alert("Incorrect password!");
      }
    });
  }

  // ===== Chat System =====
  function updateChatUI() {
    const lobbyChatContainer = document.getElementById("lobbyChatContainer");
    const lobbyChatMessages = document.getElementById("lobbyChatMessages");
    
    if (lobbyChatMessages) {
      lobbyChatMessages.innerHTML = "";
      for (const msg of chatMessages) {
        const div = document.createElement("div");
        div.className = "chat-message";
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `<span class="chat-time">${time}</span> <span class="chat-name">${escapeHtml(msg.from)}:</span> <span class="chat-text">${escapeHtml(msg.text)}</span>`;
        lobbyChatMessages.appendChild(div);
      }
      lobbyChatMessages.scrollTop = lobbyChatMessages.scrollHeight;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function sendChatMessage(text) {
    if (!text.trim() || !connected) return;
    send({ t: "chat", text: text.trim() });
  }

  function toggleGameChat() {
    chatOpen = !chatOpen;
    if (chatOpen) {
      chatUnread = 0;
      lastReadTimestamp = Date.now();
    }
  }

  // Setup lobby chat input
  const lobbyChatInput = document.getElementById("lobbyChatInput");
  const lobbyChatSend = document.getElementById("lobbyChatSend");
  
  if (lobbyChatInput) {
    lobbyChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(lobbyChatInput.value);
        lobbyChatInput.value = "";
      }
    });
    lobbyChatInput.addEventListener("focus", () => { chatInputFocused = true; });
    lobbyChatInput.addEventListener("blur", () => { chatInputFocused = false; });
  }
  
  if (lobbyChatSend) {
    lobbyChatSend.addEventListener("click", () => {
      sendChatMessage(lobbyChatInput.value);
      lobbyChatInput.value = "";
    });
  }

  // ===== Canvas =====
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // ===== Input =====
  canvas.addEventListener("mousemove", (e) => { 
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
  });
  canvas.addEventListener("mousedown", (e) => {
    // ===== START OF NEW INTERACTION CODE =====
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    // Handle modifier skip button click
    if (phase === "modifier_reveal" && gameModifierCard && !gameModifierCard.hasSkipped && !isSpectator) {
      if (window.modifierSkipBtnBounds) {
        const btn = window.modifierSkipBtnBounds;
        if (mx >= btn.x && mx <= btn.x + btn.w && my >= btn.y && my <= btn.y + btn.h) {
          gameModifierCard.hasSkipped = true;
          send({ t: "skipModifier" });
          return;
        }
      }
    }

    // Handle music permission popup click (highest priority)
    if (showMusicPermissionPrompt && window.musicPermissionBtnBounds) {
      const btn = window.musicPermissionBtnBounds;
      if (mx >= btn.x && mx <= btn.x + btn.w && my >= btn.y && my <= btn.y + btn.h) {
        grantMusicPermission();
        return;
      }
    }

    // 1. Handle Inventory Clicks (Select Module)
    // Safety: Only process if player is alive and has inventory visible
    const myP = lastSnap ? lastSnap.players.find(p => p.id === myId) : null;
    const playerAlive = myP && myP.hp > 0;
    const hasInventory = myP && myP.inventory && myP.inventory.length > 0;
    
    // Clear selection if player died or no longer has inventory
    if (selectedInventoryIndex !== -1 && (!playerAlive || !hasInventory)) {
      selectedInventoryIndex = -1;
    }
    if (selectedInventoryModule && !playerAlive) {
      selectedInventoryModule = null;
    }
    
    if (window.invBounds && window.invBounds.length > 0 && lastSnap && playerAlive && hasInventory) {
      for (let i = 0; i < window.invBounds.length; i++) {
        const b = window.invBounds[i];
        if (!b) continue; // Safety check
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
          // Toggle selection - if already selected, deselect
          if (selectedInventoryIndex === i) {
            selectedInventoryIndex = -1;
            return;
          }
          
          // Check if any towers have empty module slots
          let hasAvailableSlot = false;
          if (myP && myP.towers) {
            for (let tIdx = 0; tIdx < 4; tIdx++) {
              const tower = myP.towers[tIdx];
              if (tower && tower.modules) {
                const emptySlot = tower.modules.indexOf(null);
                if (emptySlot !== -1) {
                  hasAvailableSlot = true;
                  break;
                }
              }
            }
          }
          
          if (hasAvailableSlot) {
            // Select the module
            selectedInventoryIndex = i;
          } else {
            // No slots available - show error feedback
            moduleErrorFeedback = { error: "No empty tower slots available!", time: Date.now() };
            selectedInventoryIndex = -1;
          }
          return; // Stop other clicks
        }
      }
    }

    // 2. Handle Module Slot Popup Clicks (when module selected)
    if (selectedInventoryIndex !== -1 && playerAlive && window.moduleSlotPopups && window.moduleSlotPopups.length > 0) {
      for (const slot of window.moduleSlotPopups) {
        if (mx >= slot.x && mx <= slot.x + slot.w && my >= slot.y && my <= slot.y + slot.h) {
          // Slot the module!
          send({ 
            t: "slotModule", 
            towerIndex: slot.towerIndex, 
            moduleSlot: slot.moduleSlot, 
            inventoryIndex: selectedInventoryIndex 
          });
          selectedInventoryIndex = -1; // Deselect
          return;
        }
      }
    }

    // 3. Handle Tower Clicks (Drop Module) - when module is selected (fallback for clicking tower directly)
    // Note: selectedInventoryIndex should already be cleared if player is dead (from check above)
    if (selectedInventoryIndex !== -1 && lastSnap && !buildMenuOpen && playerAlive) {
      if (myP) {
        // Get scale to convert world to screen coords
        const sw = canvas.width;
        const sh = canvas.height;
        const ww = world.width;
        const wh = world.height;
        const playerCount = lastSnap?.players?.length || 1;
        const panelReserve = (playerCount > 1) ? 195 : 0;
        const availableWidth = sw - panelReserve;
        const scale = Math.min(availableWidth / ww, sh / wh);
        const offsetX = (availableWidth - ww * scale) / 2;
        const offsetY = (sh - wh * scale) / 2;
        
        // Calculate tower positions (same as buildMenuOpen logic)
        const segX0 = myP.slot * world.segmentWidth;
        const cx = (segX0 + world.segmentWidth / 2) * scale + offsetX;
        const cy = 560 * scale + offsetY;
        const offsets = [-110, -50, 50, 110];
        
        for (let tIdx = 0; tIdx < 4; tIdx++) {
           const screenX = cx + offsets[tIdx] * scale;
           const screenY = cy - 18 * scale; // Adjust for tower center
           const dx = mx - screenX;
           const dy = my - screenY;
           const hitRadius = 35 * scale;
           // Hit tower?
           if (dx*dx + dy*dy < hitRadius*hitRadius) {
             const tower = myP.towers[tIdx];
             if (tower) {
               // Find first empty slot
               const emptySlotIdx = tower.modules.indexOf(null);
               if (emptySlotIdx !== -1) {
                 // SLOT IT!
                 send({ 
                   t: "slotModule", 
                   towerIndex: tIdx, 
                   moduleSlot: emptySlotIdx, 
                   inventoryIndex: selectedInventoryIndex 
                 });
                 selectedInventoryIndex = -1; // Deselect
                 return;
               }
             }
           }
        }
      }
      
      // If we got here with a module selected, clicking elsewhere cancels selection
      if (e.button === 0) {
        selectedInventoryIndex = -1;
        return;
      }
    }
    
    // Right click to cancel selection
    if (e.button === 2 && selectedInventoryIndex !== -1) {
      selectedInventoryIndex = -1;
      return;
    }
    // ===== END OF NEW INTERACTION CODE =====

    // (The original code continues below here...)
    if (e.button === 0) { mouseDown = true; handleClick(); }
  });
  window.addEventListener("mouseup", (e) => { if (e.button === 0) mouseDown = false; });
  canvas.addEventListener("touchstart", (e) => { e.preventDefault(); mouseDown = true; if (e.touches[0]) { mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; } handleClick(); });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); if (e.touches[0]) { mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; } });
  canvas.addEventListener("touchend", (e) => { e.preventDefault(); mouseDown = false; });
  
  // Prevent context menu on right-click (used for canceling module selection)
  canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); });

  // Keyboard handling for in-game chat
  let gameChatTyping = false;
  
  document.addEventListener("keydown", (e) => {
    // Don't handle if in lobby chat input
    if (chatInputFocused) return;
    
    // Only handle in-game
    if (phase !== "playing" && phase !== "upgrades") return;
    
    // Escape to close chat
    if (e.key === "Escape" && chatOpen) {
      chatOpen = false;
      gameChatTyping = false;
      gameChatInputText = "";
      return;
    }
    
    // T to open chat and start typing
    if (e.key === "t" || e.key === "T") {
      if (!chatOpen) {
        chatOpen = true;
        chatUnread = 0;
      }
      gameChatTyping = true;
      e.preventDefault();
      return;
    }
    
    // Space bar to pause/unpause (only when not typing)
    if (e.key === " " && !gameChatTyping && !isSpectator && phase === "playing") {
      if (gamePaused && pauseCountdown <= 0) {
        send({ t: "unpauseGame" });
      } else if (!gamePaused && pauseCountdown <= 0) {
        send({ t: "pauseGame" });
      }
      e.preventDefault();
      return;
    }
    
    // Enter to send message when typing
    if (e.key === "Enter" && gameChatTyping && gameChatInputText.trim()) {
      sendChatMessage(gameChatInputText);
      gameChatInputText = "";
      e.preventDefault();
      return;
    }
    
    // Backspace when typing
    if (e.key === "Backspace" && gameChatTyping) {
      gameChatInputText = gameChatInputText.slice(0, -1);
      e.preventDefault();
      return;
    }
    
    // Regular characters when typing
    if (gameChatTyping && e.key.length === 1 && gameChatInputText.length < 200) {
      gameChatInputText += e.key;
      e.preventDefault();
      return;
    }
  });

  function handleClick() {
    // Track if we clicked on UI (to prevent shooting)
    let uiClicked = false;
    
    // Handle in-game chat button click
    if ((phase === "playing" || phase === "upgrades") && window.gameChatBtnBounds) {
      const btn = window.gameChatBtnBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        toggleGameChat();
        mouseDown = false;
        return;
      }
    }
    
    // Handle chat close button
    if (chatOpen && window.gameChatCloseBounds) {
      const btn = window.gameChatCloseBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        chatOpen = false;
        mouseDown = false;
        return;
      }
    }
    
    // Handle game over return to menu button
    if (phase === "gameover" && gameOverData && gameOverData.menuBtnBounds) {
      const btn = gameOverData.menuBtnBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        send({ t: "returnToLobby" });
        mouseDown = false;
        return;
      }
    }
    
    if (phase === "playing" && hoveredUpgrade >= 0 && !upgradePicked && upgradeOptions.length > 0) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) {
        if (banishMode) {
          // In banish mode, banish the card instead of picking it
          send({ t: "banishUpgrade", defId: opt.defId });
        } else {
          // Normal mode, pick the upgrade
          send({ t: "pickUpgrade", key: opt.key });
        }
      }
      mouseDown = false;
      return;
    }

    // Handle module card selection (BEFORE buildMenuOpen check!)
    if (phase === "playing" && moduleCardPhase && hoveredModuleCard >= 0 && currentModulePicker === myId) {
      const selectedCard = moduleCards[hoveredModuleCard];
      if (selectedCard) {
        // Send both index and moduleId for server verification
        send({ t: "pickModuleCard", cardIndex: hoveredModuleCard, moduleId: selectedCard.id });
      }
      mouseDown = false;
      return;
    }
    
    // Check if clicking inside module card panel (even if not on a card)
    if (phase === "playing" && moduleCardPhase && moduleCards.length > 0) {
      const panelW = 220;
      const panelX = 15;
      const panelY = 80;
      const panelH = Math.min(canvas.height - 160, 60 + moduleCards.length * 95 + 50);
      if (mouseX >= panelX && mouseX <= panelX + panelW && mouseY >= panelY && mouseY <= panelY + panelH) {
        // Clicked inside module card panel - don't process further
        mouseDown = false;
        return;
      }
    }

    // Handle pause button click
    if (phase === "playing" && hoveredPauseButton && !isSpectator) {
      if (gamePaused && pauseCountdown <= 0) {
        send({ t: "unpauseGame" });
      } else if (!gamePaused) {
        send({ t: "pauseGame" });
      }
      mouseDown = false;
      return;
    }

    // Handle music player clicks
    if (musicPlayerHover && window.musicPlayerBounds) {
      const mpBounds = window.musicPlayerBounds;
      
      // FIX: Safety check - ensure mouse is actually in bounds
      if (mouseX >= mpBounds.x && mouseX <= mpBounds.x + mpBounds.w && 
          mouseY >= mpBounds.y && mouseY <= mpBounds.y + mpBounds.h) {
          
        if (musicPlayerHover === "expand") {
          musicState.expanded = true;
        } else if (musicPlayerHover === "collapse") {
          musicState.expanded = false;
        } else if (musicPlayerHover === "prev") {
          send({ t: "musicPrev" });
        } else if (musicPlayerHover === "next") {
          send({ t: "musicNext" });
        } else if (musicPlayerHover === "shuffle") {
          send({ t: "musicToggleShuffle" });
        } else if (musicPlayerHover === "mute") {
          toggleMusicMute();
        } else if (musicPlayerHover === "volume") {
          // Calculate volume from click position
          const volX = mpBounds.x + 10;
          const volW = mpBounds.w - 20;
          const clickVol = Math.max(0, Math.min(1, (mouseX - volX) / volW));
          setMusicVolume(clickVol);
        } else if (musicPlayerHover === "lobbyToggle") {
          toggleMusicMute();
        }
        mouseDown = false;
        return;
      }
      // If we're here, hover was stuck but mouse moved away - clear it
      musicPlayerHover = null;
    }

    // Handle death mod button clicks
    if (phase === "playing" && hoveredDeathMod) {
      send({ t: "useDeathMod", modId: hoveredDeathMod });
      mouseDown = false;
      return;
    }

    // Handle reroll button click
    if (phase === "playing" && hoveredReroll && !upgradePicked && upgradeOptions.length > 0) {
      const myPlayer = lastSnap?.players.find(p => p.id === myId);
      if (myPlayer && myPlayer.gold >= currentRerollCost) {
        send({ t: "rerollUpgrades" });
      }
      mouseDown = false;
      return;
    }

    // Handle banish button click - toggle banish mode (only if not already used)
    if (phase === "playing" && hoveredBanish && !upgradePicked && upgradeOptions.length > 0 && banishedCount < 1) {
      banishMode = !banishMode;
      mouseDown = false;
      return;
    }

// Handle buy upgrade button click
    // Note: We removed "!upgradePicked" and "upgradeOptions.length > 0" checks
    // because this button is now independent!
    if (phase === "playing" && hoveredBuyUpgrade) {
      const myPlayer = lastSnap?.players.find(p => p.id === myId);
      if (myPlayer && myPlayer.gold >= buyUpgradeCost) {
        send({ t: "buyUpgrade", cost: buyUpgradeCost });
        // Increase cost: +10 gold + 10% of new cost
        const newCost = buyUpgradeCost + 10;
        buyUpgradeCost = Math.round(newCost * 1.10);
      }
      mouseDown = false;
      return;
    }

    // Handle stats panel button click
    if (phase === "playing" && hoveredStatsBtn) {
      statsPanelOpen = !statsPanelOpen;
      mouseDown = false;
      return;
    }

    // Handle damage numbers toggle click
    if (phase === "playing" && statsPanelOpen && window.dmgToggleBounds) {
      const b = window.dmgToggleBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        showDamageNumbers = !showDamageNumbers;
        localStorage.setItem("rogueAsteroidDmgNumbers", showDamageNumbers.toString());
        mouseDown = false;
        return;
      }
    }

    // Handle quantity mode button clicks
    if (hoveredQuantityBtn && phase === "playing") {
      attackQuantityMode = hoveredQuantityBtn;
      mouseDown = false;
      return;
    }

    // Handle attack panel clicks (always visible, no popup)
    if (hoveredAttack && phase === "playing" && lastSnap && lastSnap.players.length > 1) {
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      const atkDef = ATTACK_TYPES[hoveredAttack];
      if (myPlayer && atkDef && myPlayer.gold >= atkDef.cost) {
        send({ t: "buyAttack", attackType: hoveredAttack, quantity: attackQuantityMode });
        recentAttackSent = { type: hoveredAttack, time: Date.now(), quantity: attackQuantityMode };
      }
      mouseDown = false;
      return;
    }
    
    // Check if clicking on inventory panel
    if (phase === "playing" && lastSnap) {
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      const inv = myPlayer?.inventory || [];
      if (inv.length > 0) {
        const invPanelW = 180;
        const invPanelH = 40 + Math.ceil(inv.length / 4) * 45;
        const invPanelX = 15;
        const invPanelY = canvas.height - invPanelH - 60;
        if (mouseX >= invPanelX && mouseX <= invPanelX + invPanelW && mouseY >= invPanelY && mouseY <= invPanelY + invPanelH) {
          // Clicked on inventory - select the module if hovering one
          if (selectedInventoryModule) {
            // Already selected one, keep it selected for slotting
          }
          mouseDown = false;
          return;
        }
      }
    }

    // Handle build/upgrade menu clicks
    if (buildMenuOpen) {
      // First check if we're clicking in any UI area - don't close menu if so
      // Module card panel check
      if (moduleCardPhase && moduleCards.length > 0) {
        const panelW = 220, panelX = 15, panelY = 80;
        const panelH = Math.min(canvas.height - 160, 60 + moduleCards.length * 95 + 50);
        if (mouseX >= panelX && mouseX <= panelX + panelW && mouseY >= panelY && mouseY <= panelY + panelH) {
          mouseDown = false;
          return; // Don't close build menu, clicked in module panel
        }
      }
      
      // Check if clicking on a module slot
      if (hoveredModuleSlot) {
        if (hoveredModuleSlot.hasModule && !hoveredModuleSlot.locked) {
          // Unslot the module
          send({ t: "unslotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex });
          mouseDown = false;
          return;
        } else if (!hoveredModuleSlot.hasModule && selectedInventoryModule) {
          // Slot module from inventory
          send({ t: "slotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex, inventoryIndex: selectedInventoryModule.index });
          selectedInventoryModule = null;
          mouseDown = false;
          return;
        }
        mouseDown = false;
        return;
      }
      
      if (hoveredBuildOption === "upgrade") {
        send({ t: "upgradeTower", slotIndex: buildMenuOpen.slotIndex });
        buildMenuOpen = null;
        mouseDown = false;
        return;
      } else if (hoveredBuildOption === "sell") {
        send({ t: "sellTower", slotIndex: buildMenuOpen.slotIndex });
        buildMenuOpen = null;
        mouseDown = false;
        return;
      } else if (typeof hoveredBuildOption === "number" && hoveredBuildOption >= 0) {
        send({ t: "buyTower", slotIndex: buildMenuOpen.slotIndex, type: hoveredBuildOption });
        buildMenuOpen = null;
        mouseDown = false;
        return;
      } else {
        // Clicking outside menu options - close menu
        buildMenuOpen = null;
        mouseDown = false;
        return;
      }
    }

    // Handle inventory item click (select for slotting)
    if (phase === "playing" && selectedInventoryModule) {
      // If clicking outside tower menu, deselect
      selectedInventoryModule = null;
    }

    if (phase === "playing" && lastSnap) {
      const { sx, sy, offsetX, offsetY } = getScale();
      const me = lastSnap.players.find(p => p.id === myId);

      // Only allow tower interaction if player is alive
      if (me && me.hp > 0 && me.towers) {
        const segX0 = me.slot * world.segmentWidth;
        const cx = (segX0 + world.segmentWidth / 2) * sx + offsetX;
        const cy = 560 * sy + offsetY;
        const offsets = [-110, -50, 50, 110];

        for (let i = 0; i < 4; i++) {
          const tx = cx + offsets[i] * sx;
          const clickRadius = me.towers[i] ? 25 * sx : 20 * sx;
          if (Math.hypot(mouseX - tx, mouseY - (cy - 18 * sy)) < clickRadius) {
            buildMenuOpen = {
              slotIndex: i,
              x: tx,
              y: cy,
              hasTower: !!me.towers[i],
              tower: me.towers[i]
            };
            return;
          }
        }
      }
    }
  }

  // ===== Input Loop =====
  let lastInputX = 0, lastInputY = 0, lastInputShooting = false;
  function sendInput() {
    if (phase !== "playing" || !lastSnap || isSpectator) return;
    const scale = getScale();
    const worldX = (mouseX - scale.offsetX) / scale.sx;
    const worldY = (mouseY - scale.offsetY) / scale.sy;
    const shooting = mouseDown && !buildMenuOpen && !uiHovered;
    
    // Only send if position changed significantly or shooting state changed
    const dx = Math.abs(worldX - lastInputX);
    const dy = Math.abs(worldY - lastInputY);
    if (dx > 2 || dy > 2 || shooting !== lastInputShooting) {
      send({ t: "input", x: worldX, y: worldY, shooting });
      lastInputX = worldX;
      lastInputY = worldY;
      lastInputShooting = shooting;
    }
  }
  setInterval(sendInput, 60); // ~16Hz input rate (reduced from 22Hz to lower packet overhead)

  // ===== Rendering =====
  function getScale() {
    const sw = canvas.width;
    const sh = canvas.height;
    const ww = world.width;
    const wh = world.height;
    
    // Reserve space for the right panel in multiplayer (when panel would be shown)
    const playerCount = lastSnap?.players?.length || 1;
    const panelReserve = (playerCount > 1) ? 195 : 0; // 175 panel + 20 margin
    const availableWidth = sw - panelReserve;
    
    const scale = Math.min(availableWidth / ww, sh / wh);
    const renderW = ww * scale;
    const renderH = wh * scale;
    const offsetX = (availableWidth - renderW) / 2;
    const offsetY = (sh - renderH) / 2;
    return { sx: scale, sy: scale, offsetX, offsetY, renderW, renderH, panelReserve };
  }

  function drawNeonText(text, x, y, color, size, align = "left") {
    ctx.save();
    ctx.font = `bold ${size}px 'Orbitron', 'Courier New', monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    
    ctx.shadowColor = color;
    ctx.shadowBlur = 15;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.6;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ===== Unique Projectile Rendering (OPTIMIZED) =====
  // PERFORMANCE: Removed ctx.save()/restore() wrapper - only use for transforms
  function drawBullet(b, sx, sy, baseColor) {
    const x = b.x * sx;
    const y = b.y * sy;
    const r = b.r * sx;

    const angle = Math.atan2(b.vy, b.vx);
    const fadeStart = 0.5;
    const alpha = b.lifespan < fadeStart ? Math.max(0.2, b.lifespan / fadeStart) : 1.0;

    // PERFORMANCE: No ctx.save()/restore() here - only used for missile rotation below

    switch (b.bulletType) {
      case "confetti":
        // 🎉🎊 MAXIMUM CONFETTI PARTY MODE!!! 🎊🎉
        const confettiColor = b.bulletColor || `hsl(${(Date.now() / 10) % 360}, 100%, 60%)`;
        const time = Date.now() / 1000;
        const sparkle = 0.7 + Math.sin(time * 15 + b.x + b.y) * 0.3; // Twinkle effect
        const wobble = Math.sin(time * 8 + b.x * 0.1) * 3; // Wobble side to side!
        const bounce = Math.abs(Math.sin(time * 12 + b.y * 0.1)) * 2; // Bouncy!
        const pulse = 1 + Math.sin(time * 10) * 0.2; // Size pulsing
        
        // Helper for confetti colors
        const getConfettiAlpha = (c, a) => {
          if (!c) return `rgba(255,255,255,${a})`;
          if (c.startsWith("#")) return hexToRgba(c, a);
          if (c.startsWith("hsl")) return c.replace("hsl", "hsla").replace(")", `, ${a})`);
          return c;
        };
        
        // RAINBOW TRAIL - 5 colors cycling through the rainbow!
        const trailLen = 25 * sx;
        for (let i = 0; i < 5; i++) {
          const trailHue = (parseInt(confettiColor.match(/\d+/)?.[0] || 0) + i * 30 + time * 100) % 360;
          const trailOffset = i * 0.25;
          const waveOffset = Math.sin(time * 6 + i) * 3 * sx;
          ctx.strokeStyle = `hsla(${trailHue}, 100%, 65%, ${(0.5 - i * 0.08) * alpha})`;
          ctx.lineWidth = (r * (2 - i * 0.3)) * pulse;
          ctx.lineCap = "round";
          ctx.beginPath();
          const startX = x - Math.cos(angle) * (trailOffset * trailLen) + Math.cos(angle + Math.PI/2) * waveOffset;
          const startY = y - Math.sin(angle) * (trailOffset * trailLen) + Math.sin(angle + Math.PI/2) * waveOffset;
          const endX = x - Math.cos(angle) * trailLen * (1 + trailOffset) + Math.cos(angle + Math.PI/2) * waveOffset * 0.5;
          const endY = y - Math.sin(angle) * trailLen * (1 + trailOffset) + Math.sin(angle + Math.PI/2) * waveOffset * 0.5;
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        }
        
        // Double glow rings - pulsing!
        for (let ring = 0; ring < 2; ring++) {
          const ringHue = (parseInt(confettiColor.match(/\d+/)?.[0] || 0) + ring * 60 + time * 50) % 360;
          ctx.strokeStyle = `hsla(${ringHue}, 100%, 70%, ${(0.4 - ring * 0.15) * alpha * sparkle})`;
          ctx.lineWidth = 2 - ring;
          ctx.beginPath();
          ctx.arc(x + wobble, y + bounce, r * (2.2 + ring * 0.8) * pulse, 0, Math.PI * 2);
          ctx.stroke();
        }
        
        // Random shape based on bullet id hash - MORE SHAPES!
        const shapeType = (b.id?.charCodeAt(0) || 0) % 8;
        ctx.fillStyle = getConfettiAlpha(confettiColor, alpha * sparkle);
        
        ctx.save();
        ctx.translate(x + wobble, y + bounce);
        const spinSpeed = 4 + (b.id?.charCodeAt(2) || 0) % 4; // Variable spin speed
        ctx.rotate(time * spinSpeed + (b.id?.charCodeAt(1) || 0));
        ctx.scale(pulse, pulse); // Pulsing size!
        
        switch (shapeType) {
          case 0: // Star ⭐ (5 pointed)
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
              const outerAngle = (i * 4 * Math.PI / 5) - Math.PI / 2;
              const innerAngle = outerAngle + Math.PI / 5;
              if (i === 0) {
                ctx.moveTo(Math.cos(outerAngle) * r, Math.sin(outerAngle) * r);
              } else {
                ctx.lineTo(Math.cos(outerAngle) * r, Math.sin(outerAngle) * r);
              }
              ctx.lineTo(Math.cos(innerAngle) * r * 0.4, Math.sin(innerAngle) * r * 0.4);
            }
            ctx.closePath();
            ctx.fill();
            // Add a white center
            ctx.fillStyle = `rgba(255,255,255,${0.7 * alpha})`;
            ctx.beginPath();
            ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2);
            ctx.fill();
            break;
            
          case 1: // Heart ❤️
            ctx.beginPath();
            ctx.moveTo(0, r * 0.4);
            ctx.bezierCurveTo(r, -r * 0.3, r * 0.8, -r, 0, -r * 0.4);
            ctx.bezierCurveTo(-r * 0.8, -r, -r, -r * 0.3, 0, r * 0.4);
            ctx.fill();
            // Shine on heart
            ctx.fillStyle = `rgba(255,255,255,${0.5 * alpha})`;
            ctx.beginPath();
            ctx.arc(-r * 0.3, -r * 0.3, r * 0.2, 0, Math.PI * 2);
            ctx.fill();
            break;
            
          case 2: // Diamond 💎
            ctx.beginPath();
            ctx.moveTo(0, -r * 1.2);
            ctx.lineTo(r * 0.8, 0);
            ctx.lineTo(0, r * 1.2);
            ctx.lineTo(-r * 0.8, 0);
            ctx.closePath();
            ctx.fill();
            // Inner facet
            ctx.fillStyle = `rgba(255,255,255,${0.4 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(0, -r * 0.6);
            ctx.lineTo(r * 0.3, 0);
            ctx.lineTo(0, r * 0.4);
            ctx.lineTo(-r * 0.3, 0);
            ctx.closePath();
            ctx.fill();
            break;
            
          case 3: // Moon 🌙
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#111";
            ctx.beginPath();
            ctx.arc(r * 0.4, -r * 0.1, r * 0.7, 0, Math.PI * 2);
            ctx.fill();
            break;
            
          case 4: // Flower 🌸
            const petalCount = 6;
            for (let i = 0; i < petalCount; i++) {
              const petalAngle = (i / petalCount) * Math.PI * 2;
              ctx.fillStyle = getConfettiAlpha(confettiColor, alpha * sparkle);
              ctx.beginPath();
              ctx.ellipse(
                Math.cos(petalAngle) * r * 0.5,
                Math.sin(petalAngle) * r * 0.5,
                r * 0.6, r * 0.3,
                petalAngle, 0, Math.PI * 2
              );
              ctx.fill();
            }
            // Center of flower
            ctx.fillStyle = "#ffff00";
            ctx.beginPath();
            ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
            ctx.fill();
            break;
            
          case 5: // Lightning bolt ⚡
            ctx.beginPath();
            ctx.moveTo(r * 0.3, -r);
            ctx.lineTo(-r * 0.2, -r * 0.1);
            ctx.lineTo(r * 0.2, -r * 0.1);
            ctx.lineTo(-r * 0.3, r);
            ctx.lineTo(r * 0.1, r * 0.1);
            ctx.lineTo(-r * 0.3, r * 0.1);
            ctx.closePath();
            ctx.fill();
            break;
            
          case 6: // Spiral/Swirl 🌀
            ctx.beginPath();
            for (let i = 0; i < 720; i += 20) {
              const spiralAngle = (i / 180) * Math.PI;
              const spiralR = (i / 720) * r;
              if (i === 0) {
                ctx.moveTo(Math.cos(spiralAngle) * spiralR, Math.sin(spiralAngle) * spiralR);
              } else {
                ctx.lineTo(Math.cos(spiralAngle) * spiralR, Math.sin(spiralAngle) * spiralR);
              }
            }
            ctx.strokeStyle = getConfettiAlpha(confettiColor, alpha);
            ctx.lineWidth = r * 0.4;
            ctx.lineCap = "round";
            ctx.stroke();
            break;
            
          default: // Classic circle with sparkle burst
            // Outer ring
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            // Inner white sparkle
            ctx.fillStyle = `rgba(255,255,255,${0.9 * alpha * sparkle})`;
            ctx.beginPath();
            ctx.arc(-r * 0.25, -r * 0.25, r * 0.35, 0, Math.PI * 2);
            ctx.fill();
            // Tiny highlight
            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
            ctx.beginPath();
            ctx.arc(-r * 0.15, -r * 0.4, r * 0.15, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
        
        // SPARKLE EXPLOSION! Multiple particles
        for (let sp = 0; sp < 2; sp++) {
          if (Math.random() < 0.4) {
            const sparkleHue = (Math.random() * 360);
            ctx.fillStyle = `hsla(${sparkleHue}, 100%, 85%, ${(0.6 + Math.random() * 0.4) * alpha})`;
            const sparkDist = r * (2 + Math.random() * 3);
            const sparkAngle = Math.random() * Math.PI * 2;
            const sparkX = x + wobble + Math.cos(sparkAngle) * sparkDist;
            const sparkY = y + bounce + Math.sin(sparkAngle) * sparkDist;
            const sparkSize = 1 + Math.random() * 2.5;
            
            // Some sparkles are stars, some are circles
            if (Math.random() < 0.3) {
              // Mini 4-point star
              ctx.save();
              ctx.translate(sparkX, sparkY);
              ctx.rotate(time * 5);
              ctx.beginPath();
              for (let i = 0; i < 4; i++) {
                const a = (i / 4) * Math.PI * 2;
                const nextA = ((i + 0.5) / 4) * Math.PI * 2;
                ctx.lineTo(Math.cos(a) * sparkSize * 1.5, Math.sin(a) * sparkSize * 1.5);
                ctx.lineTo(Math.cos(nextA) * sparkSize * 0.5, Math.sin(nextA) * sparkSize * 0.5);
              }
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            } else {
              ctx.beginPath();
              ctx.arc(sparkX, sparkY, sparkSize, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        break;

      case "gatling":
        // Gatling: Simple yellow tracer with trail
        const gatlingTrail = 10 * sx;
        ctx.strokeStyle = hexToRgba("#ffff00", 0.5 * alpha);
        ctx.lineWidth = r * 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * gatlingTrail, y - Math.sin(angle) * gatlingTrail);
        ctx.stroke();
        ctx.fillStyle = hexToRgba("#ffff00", alpha);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
        break;

      case "sniper":
        // Legacy sniper bullet (railgun no longer uses projectiles)
        const laserLen = 35 * sx;
        const laserWidth = r * 0.6;
        ctx.strokeStyle = hexToRgba("#00ff00", 0.8 * alpha);
        ctx.lineWidth = laserWidth * 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        break;

      case "missile":
        // Missile: Simplified red rocket with smoke trail
        const missileLen = 12 * sx;
        const missileWidth = r * 1.2;
        ctx.fillStyle = hexToRgba("#ff6600", 0.6 * alpha);
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(angle) * missileLen * 0.5, y - Math.sin(angle) * missileLen * 0.5);
        ctx.lineTo(x - Math.cos(angle) * missileLen * 2, y - Math.sin(angle) * missileLen * 2);
        ctx.lineTo(x - Math.cos(angle) * missileLen * 1.5 + Math.cos(angle - 0.5) * 4 * sx,
                   y - Math.sin(angle) * missileLen * 1.5 + Math.sin(angle - 0.5) * 4 * sx);
        ctx.closePath();
        ctx.fill();
        // PERFORMANCE: Only save/restore for rotate transform
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = hexToRgba("#ff4444", alpha);
        ctx.beginPath();
        ctx.ellipse(0, 0, missileLen, missileWidth, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      
      case "drone":
        // Drone bullet: Small cyan energy bolt
        const droneBulletR = r * 0.6;
        ctx.fillStyle = hexToRgba("#44aaff", alpha);
        ctx.beginPath();
        ctx.arc(x, y, droneBulletR, 0, Math.PI * 2);
        ctx.fill();
        // Small trail
        ctx.strokeStyle = hexToRgba("#88ccff", 0.5 * alpha);
        ctx.lineWidth = droneBulletR;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * 8 * sx, y - Math.sin(angle) * 8 * sx);
        ctx.stroke();
        break;

      default:
        // Main turret: Player-colored energy bolt
        const trail = 12 * sx;
        const color = b.isCrit ? "#ffffff" : (b.bulletColor || baseColor);
        
        // Helper to safe-wrap colors (handles HEX and HSL from confetti)
        const getColorAlpha = (c, a) => {
          if (!c) return `rgba(255,255,255,${a})`;
          if (c.startsWith("#")) return hexToRgba(c, a);
          if (c.startsWith("hsl")) return c.replace("hsl", "hsla").replace(")", `, ${a})`);
          return c;
        };

        // Trail always drawn
        ctx.strokeStyle = getColorAlpha(color, 0.5 * alpha);
        ctx.lineWidth = r * 1.8;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * trail, y - Math.sin(angle) * trail);
        ctx.stroke();

        // Bullet body
        ctx.fillStyle = getColorAlpha(color, alpha);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
    // PERFORMANCE: No ctx.restore() needed - we only modified fillStyle/strokeStyle/lineWidth
    // which get overwritten by the next draw call anyway
  }

  // Track last frame time for smooth delta time calculation
  let lastFrameTime = performance.now();
  let isTabVisible = true;
  
  // Handle visibility change - pause heavy rendering when tab is hidden
  document.addEventListener("visibilitychange", () => {
    const wasHidden = !isTabVisible;
    isTabVisible = !document.hidden;
    
    if (isTabVisible && wasHidden) {
      // Clear all accumulated visual effects when returning to tab
      // This prevents a burst of particles/numbers trying to render at once
      clientParticles = [];
      clientDamageNumbers = [];
      clientLightning = [];
      pendingTracers = [];
      railgunBeams = [];
      lastFrameTime = performance.now(); // Reset to avoid huge dt jump
    }
  });

  function draw() {
    requestAnimationFrame(draw);
    
    // Skip heavy rendering when tab is hidden (still process state)
    if (!isTabVisible) return;

    // FIX: Reset hover state every frame to prevent stuck UI
    musicPlayerHover = null;

    try {
      // Calculate actual delta time for smooth animations
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.05); // Cap at 50ms to prevent huge jumps
      lastFrameTime = now;
      
      // PERFORMANCE: Track FPS and reduce effects when struggling
      // If dt > 33ms (below 30 FPS), we're struggling - skip some effects
      const isLowFPS = dt > 0.033;
      
      time += dt;
      // Update client-side visual effects (particles, damage numbers, asteroid rotations)
      updateClientEffects(dt);

      ctx.fillStyle = "#050510";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Stars - optimized with rectangles instead of arcs
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.y += s.speed;
        if (s.y > 1) s.y = 0;
        // Simple rectangle stars (much faster than arc)
        ctx.fillRect(s.x * canvas.width, s.y * canvas.height, s.size, s.size);
      }

      if (phase === "menu" || phase === "lobby") {
        drawNeonText("ROGUE ASTEROID", canvas.width / 2, 50, "#0ff", 28, "center");
        drawNeonText("PvP", canvas.width / 2, 85, "#f44", 18, "center");
        return;
      }
      
      // GAME MODIFIER CARD REVEAL ANIMATION
      if (phase === "modifier_reveal" && gameModifierCard) {
        const card = gameModifierCard;
        const mod = card.modifier;
        card.animTime += dt;
        
        // Animation phases
        const enterDuration = 0.8;
        
        let cardAlpha = 1;
        let cardScale = 1;
        let cardY = canvas.height / 2;
        
        if (card.animTime < enterDuration) {
          // Entering: slide up from bottom with scale
          const t = card.animTime / enterDuration;
          const easeOut = 1 - Math.pow(1 - t, 3); // Ease out cubic
          cardY = canvas.height + 150 - (canvas.height / 2 + 150) * easeOut;
          cardScale = 0.5 + 0.5 * easeOut;
          cardAlpha = easeOut;
        } else {
          // Display: slight floating animation (stays until game starts)
          const displayT = card.animTime - enterDuration;
          cardY = canvas.height / 2 + Math.sin(displayT * 2) * 5;
        }
        
        // Draw dark overlay
        ctx.fillStyle = `rgba(5, 5, 16, ${0.9 * cardAlpha})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Card dimensions
        const cardW = 320 * cardScale;
        const cardH = 420 * cardScale;
        const cardX = canvas.width / 2 - cardW / 2;
        const cardTopY = cardY - cardH / 2;
        
        ctx.save();
        ctx.globalAlpha = cardAlpha;
        
        // Card background with glow
        const glowColor = mod.color || "#ffffff";
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 30 * cardScale;
        
        // Card border (gradient)
        const grad = ctx.createLinearGradient(cardX, cardTopY, cardX, cardTopY + cardH);
        grad.addColorStop(0, mod.color || "#888");
        grad.addColorStop(0.5, "#ffffff");
        grad.addColorStop(1, mod.color || "#888");
        
        // Outer border
        ctx.fillStyle = grad;
        ctx.beginPath();
        const borderR = 15 * cardScale;
        ctx.roundRect(cardX - 4, cardTopY - 4, cardW + 8, cardH + 8, borderR);
        ctx.fill();
        
        // Inner card
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(15, 15, 30, 0.98)";
        ctx.beginPath();
        ctx.roundRect(cardX, cardTopY, cardW, cardH, borderR - 2);
        ctx.fill();
        
        // Header bar
        ctx.fillStyle = mod.color || "#666";
        ctx.globalAlpha = cardAlpha * 0.3;
        ctx.fillRect(cardX, cardTopY, cardW, 60 * cardScale);
        ctx.globalAlpha = cardAlpha;
        
        // "GAME MODIFIER" label
        ctx.font = `bold ${14 * cardScale}px monospace`;
        ctx.fillStyle = "#888";
        ctx.textAlign = "center";
        ctx.fillText("⚙️ GAME MODIFIER ⚙️", canvas.width / 2, cardTopY + 25 * cardScale);
        
        // Icon (large, centered)
        ctx.font = `${80 * cardScale}px serif`;
        ctx.fillText(mod.icon, canvas.width / 2, cardTopY + 150 * cardScale);
        
        // Name
        ctx.font = `bold ${26 * cardScale}px monospace`;
        ctx.fillStyle = mod.color || "#fff";
        ctx.fillText(mod.name, canvas.width / 2, cardTopY + 210 * cardScale);
        
        // Description (word wrap)
        ctx.font = `${15 * cardScale}px monospace`;
        ctx.fillStyle = "#ddd";
        const words = mod.desc.split(' ');
        let line = '';
        let lineY = cardTopY + 260 * cardScale;
        const maxWidth = cardW - 40 * cardScale;
        
        for (const word of words) {
          const testLine = line + word + ' ';
          if (ctx.measureText(testLine).width > maxWidth && line !== '') {
            ctx.fillText(line.trim(), canvas.width / 2, lineY);
            line = word + ' ';
            lineY += 22 * cardScale;
          } else {
            line = testLine;
          }
        }
        ctx.fillText(line.trim(), canvas.width / 2, lineY);
        
        // Flavor text
        ctx.font = `italic ${12 * cardScale}px serif`;
        ctx.fillStyle = "#888";
        ctx.fillText(mod.flavor, canvas.width / 2, cardTopY + 370 * cardScale);
        
        // Skip button and countdown (server waits 15 seconds total)
        if (card.animTime > enterDuration) {
          const timeRemaining = 15 - card.animTime; // 15 second total delay
          const countdown = Math.ceil(timeRemaining);
          
          // Skip button
          const skipBtnW = 120;
          const skipBtnH = 40;
          const skipBtnX = canvas.width / 2 - skipBtnW / 2;
          const skipBtnY = cardTopY + cardH + 20;
          
          // Store button bounds for click detection
          window.modifierSkipBtnBounds = { x: skipBtnX, y: skipBtnY, w: skipBtnW, h: skipBtnH };
          
          const isHovered = mouseX >= skipBtnX && mouseX <= skipBtnX + skipBtnW &&
                           mouseY >= skipBtnY && mouseY <= skipBtnY + skipBtnH;
          
          if (!card.hasSkipped && !isSpectator) {
            // Draw skip button
            ctx.fillStyle = isHovered ? "rgba(100, 200, 100, 0.4)" : "rgba(60, 120, 60, 0.3)";
            ctx.strokeStyle = isHovered ? "#8f8" : "#6a6";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(skipBtnX, skipBtnY, skipBtnW, skipBtnH, 8);
            ctx.fill();
            ctx.stroke();
            
            ctx.font = "bold 16px monospace";
            ctx.fillStyle = isHovered ? "#fff" : "#cfc";
            ctx.fillText("⏩ SKIP", canvas.width / 2, skipBtnY + 26);
          } else if (card.hasSkipped) {
            // Show "Skipped" status
            ctx.font = "bold 14px monospace";
            ctx.fillStyle = "#8f8";
            ctx.fillText("✓ Skipped", canvas.width / 2, skipBtnY + 26);
          }
          
          // Show skip count and countdown
          const statusY = skipBtnY + skipBtnH + 25;
          ctx.font = "14px monospace";
          ctx.fillStyle = "#aaa";
          
          if (card.totalPlayers > 1) {
            ctx.fillText(`${card.skippedCount}/${card.totalPlayers} players ready`, canvas.width / 2, statusY);
          }
          
          // Countdown
          if (countdown > 0) {
            ctx.font = "12px monospace";
            ctx.fillStyle = "#666";
            ctx.fillText(`Auto-start in ${countdown}s`, canvas.width / 2, statusY + 20);
          } else {
            ctx.font = "14px monospace";
            ctx.fillStyle = "#8f8";
            ctx.fillText("Starting...", canvas.width / 2, statusY + 20);
          }
        }
        
        ctx.restore();
        return;
      }

      if (!lastSnap) return;

      // Reset UI hover state - will be set true if mouse is over any UI element
      uiHovered = false;
      
      // Check UI bounds for hover blocking (prevents shooting when over UI)
      const uiCheckPlayer = lastSnap.players?.find(p => p.id === myId);
      
      // Module card selection panel
      if (moduleCardPhase && moduleCards.length > 0) {
        const panelW = 220, panelX = 15, panelY = 80;
        const panelH = Math.min(canvas.height - 160, 60 + moduleCards.length * 95 + 50);
        if (mouseX >= panelX && mouseX <= panelX + panelW && mouseY >= panelY && mouseY <= panelY + panelH) {
          uiHovered = true;
        }
      }
      
      // Upgrade cards panel
      if (upgradeOptions.length > 0 && !upgradePicked) {
        const cardW = 140, cardH = 100, cardGap = 15;
        const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * cardGap;
        const startX = canvas.width / 2 - totalW / 2, cardY = 50;
        if (mouseX >= startX - 10 && mouseX <= startX + totalW + 10 && mouseY >= cardY - 10 && mouseY <= cardY + cardH + 60) {
          uiHovered = true;
        }
      }
      
      // Inventory panel
      const uiCheckInv = uiCheckPlayer?.inventory || [];
      if (uiCheckInv.length > 0) {
        const invPanelW = 180;
        const invPanelH = 40 + Math.ceil(uiCheckInv.length / 4) * 45;
        const invPanelX = 15;
        const invPanelY = canvas.height - invPanelH - 60;
        if (mouseX >= invPanelX && mouseX <= invPanelX + invPanelW && mouseY >= invPanelY && mouseY <= invPanelY + invPanelH) {
          uiHovered = true;
        }
      }
      
      // Attack panel (right side) - only in multiplayer
      if (lastSnap.players?.length > 1) {
        const panelX = canvas.width - 175 - 15;
        const panelY = 10;
        const panelH = 400; // approximate
        if (mouseX >= panelX && mouseX <= canvas.width - 10 && mouseY >= panelY && mouseY <= panelY + panelH) {
          uiHovered = true;
        }
      }
      
      // Pause button (in HUD bar)
      if (phase === "playing" && !isSpectator) {
        const pauseBtnX = 115, pauseBtnY = 11, pauseBtnW = 36, pauseBtnH = 28;
        if (mouseX >= pauseBtnX && mouseX <= pauseBtnX + pauseBtnW && mouseY >= pauseBtnY && mouseY <= pauseBtnY + pauseBtnH) {
          uiHovered = true;
        }
      }
      
      // Build menu
      if (buildMenuOpen) {
        uiHovered = true;
      }

      const { sx, sy, offsetX, offsetY } = getScale();
      ctx.save();
      ctx.translate(offsetX, offsetY);

      // Grid
      ctx.strokeStyle = "rgba(0,255,255,0.03)";
      ctx.lineWidth = 1;
      for (let x = 0; x < world.width; x += 30) {
        ctx.beginPath();
        ctx.moveTo(x * sx, 0);
        ctx.lineTo(x * sx, world.height * sy);
        ctx.stroke();
      }
      for (let y = 0; y < world.height; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y * sy);
        ctx.lineTo(world.width * sx, y * sy);
        ctx.stroke();
      }

      // Segment dividers - solid walls between players
      const segCount = Math.round(world.width / world.segmentWidth);
      for (let i = 1; i < segCount; i++) {
        const x = i * world.segmentWidth * sx;
        
        // Wall glow effect
        const gradient = ctx.createLinearGradient(x - 15, 0, x + 15, 0);
        gradient.addColorStop(0, "rgba(160,0,255,0)");
        gradient.addColorStop(0.5, "rgba(160,0,255,0.15)");
        gradient.addColorStop(1, "rgba(160,0,255,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x - 15, 0, 30, world.height * sy);
        
        // Main wall line
        ctx.strokeStyle = "rgba(160,0,255,0.8)";
        ctx.lineWidth = 3;
        setShadow(ctx, "#a000ff", 15);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, world.height * sy);
        ctx.stroke();
        clearShadow(ctx);
        
        // Energy pulse effect
        const pulseY = ((time * 100) % (world.height * sy));
        ctx.fillStyle = "rgba(200,100,255,0.6)";
        ctx.beginPath();
        ctx.arc(x, pulseY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, world.height * sy - pulseY, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ground line
      const groundY = 560 * sy;
      ctx.strokeStyle = "#0ff";
      ctx.lineWidth = 3;
      setShadow(ctx, "#0ff", 20);
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(world.width * sx, groundY);
      ctx.stroke();
      clearShadow(ctx);

      // Player effects (slowfield, shield)
      for (const p of lastSnap.players) {
        if (p.slowfield) {
          ctx.fillStyle = hexToRgba(PLAYER_COLORS[p.slot]?.main || "#fff", 0.04);
          ctx.fillRect(p.slot * world.segmentWidth * sx, 0, world.segmentWidth * sx, 560 * sy);
        }
      }
      for (const p of lastSnap.players) {
        if (p.shieldActive > 0) {
          const cx = (p.slot * world.segmentWidth + world.segmentWidth / 2) * sx;
          ctx.strokeStyle = hexToRgba(PLAYER_COLORS[p.slot]?.main || "#fff", 0.5);
          ctx.lineWidth = 3;
          ctx.shadowColor = PLAYER_COLORS[p.slot]?.main;
          ctx.shadowBlur = 15;
          ctx.beginPath();
          ctx.arc(cx, groundY, world.segmentWidth * sx * 0.45, Math.PI, 0);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }

      // Shield Explosions (expanding damage circles)
      if (lastSnap.shieldExplosions) {
        for (const exp of lastSnap.shieldExplosions) {
          const alpha = (exp.life / exp.duration) * 0.6;
          const x = exp.x * sx;
          const y = exp.y * sy;
          const r = exp.radius * sx;
          
          // Outer glow ring
          ctx.strokeStyle = hexToRgba(exp.color, alpha);
          ctx.lineWidth = 4;
          ctx.shadowColor = exp.color;
          ctx.shadowBlur = 20;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          
          // Inner fill (very faint)
          ctx.fillStyle = hexToRgba(exp.color, alpha * 0.15);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          
          // Pulsing inner ring
          const pulseR = r * (0.5 + 0.2 * Math.sin(Date.now() * 0.01));
          ctx.strokeStyle = hexToRgba("#fff", alpha * 0.5);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, pulseR, 0, Math.PI * 2);
          ctx.stroke();
          
          ctx.shadowBlur = 0;
        }
      }

      // Ghost Allies (Necromancer Drive)
      if (lastSnap.ghostAllies) {
        for (const ghost of lastSnap.ghostAllies) {
          const alpha = Math.min(1, ghost.life / 2);
          const x = ghost.x * sx;
          const y = ghost.y * sy;
          const r = ghost.r * sx;
          
          // Ghostly glow
          ctx.shadowColor = "#8844ff";
          ctx.shadowBlur = 15;
          
          // Semi-transparent asteroid shape
          ctx.fillStyle = hexToRgba("#8844ff", alpha * 0.5);
          ctx.strokeStyle = hexToRgba("#aa66ff", alpha);
          ctx.lineWidth = 2;
          
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          
          // Inner glow
          ctx.fillStyle = hexToRgba("#ffffff", alpha * 0.3);
          ctx.beginPath();
          ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.shadowBlur = 0;
        }
      }
      
      // Gravity Wells
      if (lastSnap.gravityWells) {
        for (const well of lastSnap.gravityWells) {
          const alpha = Math.min(1, well.life / 0.5);
          const x = well.x * sx;
          const y = well.y * sy;
          const r = well.radius * sx;
          
          // Swirling effect
          ctx.save();
          ctx.translate(x, y);
          
          const time = Date.now() * 0.003;
          for (let ring = 0; ring < 3; ring++) {
            const ringR = r * (0.3 + ring * 0.25);
            const ringAlpha = alpha * (1 - ring * 0.3);
            
            ctx.strokeStyle = hexToRgba("#440088", ringAlpha);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, ringR, time + ring, time + ring + Math.PI * 1.5);
            ctx.stroke();
          }
          
          // Center dot
          ctx.fillStyle = hexToRgba("#8800ff", alpha);
          ctx.beginPath();
          ctx.arc(0, 0, 5, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.restore();
        }
      }

      // Particles
      if (lastSnap.particles) {
        for (let i = 0; i < lastSnap.particles.length; i++) {
          const p = lastSnap.particles[i];
          const alpha = p.life / (p.maxLife || 0.5);
          const px = p.x * sx;
          const py = p.y * sy;
          const pSize = (p.size || 2) * sx;
          
          // Special confetti particle rendering! 🎉
          if (p.isConfetti) {
            ctx.save();
            ctx.translate(px, py);
            
            // Update and apply rotation
            const rotation = (p.rotation || 0) + (p.spin || 0) * 0.016;
            p.rotation = rotation;
            ctx.rotate(rotation);
            
            // Parse HSL color for the fill
            ctx.fillStyle = p.color.replace(')', `, ${alpha})`).replace('hsl', 'hsla');
            
            switch (p.confettiShape) {
              case 'star':
                // 4-pointed star
                ctx.beginPath();
                for (let j = 0; j < 4; j++) {
                  const a = (j / 4) * Math.PI * 2;
                  const nextA = ((j + 0.5) / 4) * Math.PI * 2;
                  ctx.lineTo(Math.cos(a) * pSize, Math.sin(a) * pSize);
                  ctx.lineTo(Math.cos(nextA) * pSize * 0.4, Math.sin(nextA) * pSize * 0.4);
                }
                ctx.closePath();
                ctx.fill();
                break;
              case 'square':
                // Spinning square/rectangle
                const w = pSize * (0.8 + Math.sin(rotation * 2) * 0.3);
                const h = pSize * (1.2 - Math.sin(rotation * 2) * 0.3);
                ctx.fillRect(-w/2, -h/2, w, h);
                break;
              default:
                // Circle with shine
                ctx.beginPath();
                ctx.arc(0, 0, pSize, 0, Math.PI * 2);
                ctx.fill();
                // Add a little shine
                ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`;
                ctx.beginPath();
                ctx.arc(-pSize * 0.3, -pSize * 0.3, pSize * 0.3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
          } else {
            // Normal particle
            ctx.fillStyle = hexToRgba(p.color, alpha);
            ctx.beginPath();
            ctx.arc(px, py, pSize, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Tesla Coil Lightning Effects
      // PERFORMANCE: Skip outer glow only in low FPS situations
      const drawLightningGlow = !isLowFPS;
      
      for (const lightning of clientLightning) {
        const alpha = lightning.life / lightning.maxLife;
        const playerColor = PLAYER_COLORS[lightning.slot]?.main || "#0ff";
        const coreColor = lightning.isCrit ? "#fff" : playerColor;
        const glowColor = lightning.isCrit ? "#ff0" : "#0ff";
        
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        
        for (const segment of lightning.segments) {
          if (segment.length < 2) continue;
          
          // Outer glow (skip in low quality/FPS)
          if (drawLightningGlow) {
            ctx.strokeStyle = hexToRgba(glowColor, alpha * 0.3);
            ctx.lineWidth = 12 * sx;
            ctx.shadowColor = glowColor;
            ctx.shadowBlur = 20;
            ctx.beginPath();
            ctx.moveTo(segment[0].x * sx, segment[0].y * sy);
            for (let i = 1; i < segment.length; i++) {
              ctx.lineTo(segment[i].x * sx, segment[i].y * sy);
            }
            ctx.stroke();
            
            // Mid glow
            ctx.strokeStyle = hexToRgba(coreColor, alpha * 0.6);
            ctx.lineWidth = 6 * sx;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.moveTo(segment[0].x * sx, segment[0].y * sy);
            for (let i = 1; i < segment.length; i++) {
              ctx.lineTo(segment[i].x * sx, segment[i].y * sy);
            }
            ctx.stroke();
          }
          
          // Bright core (always drawn)
          ctx.strokeStyle = hexToRgba("#fff", alpha);
          ctx.lineWidth = drawLightningGlow ? 2 * sx : 3 * sx;
          ctx.shadowColor = "#fff";
          ctx.shadowBlur = drawLightningGlow ? 5 : 0;
          ctx.beginPath();
          ctx.moveTo(segment[0].x * sx, segment[0].y * sy);
          for (let i = 1; i < segment.length; i++) {
            ctx.lineTo(segment[i].x * sx, segment[i].y * sy);
          }
          ctx.stroke();
        }
        
        ctx.restore();
      }
      
      // Module Effect Tracers (Pinball, Viral spread)
      // PERFORMANCE: Skip shadow and dashes when FPS is low
      for (const tracer of pendingTracers) {
        const alpha = tracer.life / 0.5; // Assuming max life of 0.5
        ctx.strokeStyle = hexToRgba(tracer.color, alpha * 0.8);
        ctx.lineWidth = 3 * sx;
        
        if (!isLowFPS) {
          ctx.save();
          ctx.shadowColor = tracer.color;
          ctx.shadowBlur = 10;
          ctx.setLineDash([5, 5]);
        }
        
        ctx.beginPath();
        ctx.moveTo(tracer.x1 * sx, tracer.y1 * sy);
        ctx.lineTo(tracer.x2 * sx, tracer.y2 * sy);
        ctx.stroke();
        
        if (!isLowFPS) {
          ctx.restore();
        }
      }
      
      // Railgun Beams - bright instant laser effect
      for (const beam of railgunBeams) {
        const alpha = beam.life / beam.maxLife;
        const beamWidth = beam.isCrit ? 8 : 5;
        
        ctx.save();
        
        // Outer glow
        ctx.strokeStyle = hexToRgba(beam.color, alpha * 0.3);
        ctx.lineWidth = (beamWidth + 8) * sx;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(beam.x1 * sx, beam.y1 * sy);
        ctx.lineTo(beam.x2 * sx, beam.y2 * sy);
        ctx.stroke();
        
        // Middle glow
        ctx.strokeStyle = hexToRgba(beam.color, alpha * 0.6);
        ctx.lineWidth = (beamWidth + 4) * sx;
        ctx.beginPath();
        ctx.moveTo(beam.x1 * sx, beam.y1 * sy);
        ctx.lineTo(beam.x2 * sx, beam.y2 * sy);
        ctx.stroke();
        
        // Core beam (white/bright)
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = beamWidth * sx;
        ctx.shadowColor = beam.color;
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.moveTo(beam.x1 * sx, beam.y1 * sy);
        ctx.lineTo(beam.x2 * sx, beam.y2 * sy);
        ctx.stroke();
        
        ctx.restore();
      }

      // Asteroids/Missiles
      // PERFORMANCE: Get render bounds once for culling
      const renderWidth = world.width * sx;
      const renderHeight = world.height * sy;
      
      for (const m of lastSnap.missiles) {
        const x = m.x * sx;
        const y = m.y * sy;
        const r = m.r * sx;

        // PERFORMANCE: Skip missiles that are completely off-screen
        // This helps during spawn when many asteroids are above the viewport
        if (y < -r * 2 - 100 || y > renderHeight + r * 2 || x < -r * 2 || x > renderWidth + r * 2) {
          continue;
        }

        // Get cached data for rotation
        const cached = asteroidCache.get(m.id);
        const rotation = cached?.rotation || 0;

        // Color based on attack type
        // Boss is Dark Red, others are standard colors
        let baseColor = m.type === "boss" ? "#880000" : m.type === "large" ? "#ff4444" : m.type === "medium" ? "#ff8800" : "#ffcc00";
        if (m.attackType && ATTACK_TYPES[m.attackType]) {
          baseColor = ATTACK_TYPES[m.attackType].color;
        }

        // FTL entry effect - Star Wars hyperspace exit style
        if (m.inFTL) {
          // Check if this is a boss/boss-ad with an image
          const isBossFTL = m.isBoss || m.type === "boss";
          const isBossAdFTL = m.isBossAd;
          const bossAdVariantFTL = m.bossAdVariant;
          const isMiniBossFTL = m.isMiniBoss;
          const isMiniBossAdFTL = m.isMiniBossAd;
          
          let ftlBossImage = null;
          if ((isBossFTL || isMiniBossFTL) && bossImages.boss && bossImages.boss.complete && bossImages.boss.naturalWidth > 0) {
            ftlBossImage = bossImages.boss;
          } else if (isBossAdFTL && bossAdVariantFTL >= 1 && bossAdVariantFTL <= 5) {
            const adImg = bossImages[`ad${bossAdVariantFTL}`];
            if (adImg && adImg.complete && adImg.naturalWidth > 0) {
              ftlBossImage = adImg;
            }
          } else if (isMiniBossAdFTL) {
            // Mini-boss ads use a random ad image (cycle based on id)
            const adVariant = (parseInt(m.id, 36) % 5) + 1;
            const adImg = bossImages[`ad${adVariant}`];
            if (adImg && adImg.complete && adImg.naturalWidth > 0) {
              ftlBossImage = adImg;
            }
          }
          
          ctx.save();
          
          // Draw streak lines (simplified - no gradients for performance)
          const streakLength = 80 * sy;
          const numStreaks = isBossFTL ? 8 : (isBossAdFTL ? 5 : (isMiniBossFTL ? 6 : (isMiniBossAdFTL ? 3 : 3)));
          const streakSpread = ftlBossImage ? r * 2 : r * 1.5;
          
          // Use solid colors instead of gradients - mini-boss uses orange-red
          let streakColor = "rgba(180,200,255,0.5)";
          if (isBossFTL) streakColor = "rgba(255,100,50,0.6)";
          else if (isBossAdFTL) streakColor = "rgba(255,150,50,0.5)";
          else if (isMiniBossFTL) streakColor = "rgba(255,80,0,0.7)";
          else if (isMiniBossAdFTL) streakColor = "rgba(255,120,0,0.5)";
          
          ctx.strokeStyle = streakColor;
          ctx.lineWidth = (isMiniBossFTL || isMiniBossAdFTL) ? 3 : 2;
          
          for (let i = 0; i < numStreaks; i++) {
            const offsetX = (i - numStreaks/2) * (streakSpread / numStreaks);
            ctx.beginPath();
            ctx.moveTo(x + offsetX, y - streakLength);
            ctx.lineTo(x + offsetX, y);
            ctx.stroke();
          }
          
          if (ftlBossImage) {
            // Render boss image with FTL effect
            ctx.translate(x, y);
            ctx.scale(1, 1.8); // Less stretch for image (2.5 distorts too much)
            
            // Glow effect - mini-boss uses orange, boss uses red
            const glowColor = (isBossFTL) ? "#ff4400" : (isMiniBossFTL ? "#ff6600" : "#ff8800");
            setShadow(ctx, glowColor, isMiniBossFTL ? 20 : 30);
            
            // Draw the image with slight transparency
            ctx.globalAlpha = 0.9;
            const imgSize = r * 2.2;
            ctx.drawImage(ftlBossImage, -imgSize/2, -imgSize/2, imgSize, imgSize);
            
            // Add white overlay for "emerging from warp" effect
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = 0.3;
            ctx.drawImage(ftlBossImage, -imgSize/2, -imgSize/2, imgSize, imgSize);
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = 1;
            
            clearShadow(ctx);
          } else {
            // Standard FTL blob for regular asteroids
            setShadow(ctx, "#aaccff", 25);
            
            ctx.translate(x, y);
            ctx.scale(1, 2.5); // Stretch vertically
            ctx.rotate(rotation);
            
            const ftlGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
            ftlGrad.addColorStop(0, "#ffffff");
            ftlGrad.addColorStop(0.4, baseColor);
            ftlGrad.addColorStop(1, hexToRgba(baseColor, 0.5));
            ctx.fillStyle = ftlGrad;
            
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            
            clearShadow(ctx);
          }
          
          ctx.restore();
          continue; // Skip normal rendering for FTL asteroids
        }

        // Ghost phasing effect
        const phaseAlpha = m.isPhased ? 0.3 : 0.7;

        // Check if this is a boss or boss ad that should use images
        const isBoss = m.isBoss || m.type === "boss";
        const isBossAd = m.isBossAd;
        const bossAdVariant = m.bossAdVariant;
        const isMiniBoss = m.isMiniBoss || cached?.isMiniBoss;
        const isMiniBossAd = m.isMiniBossAd || cached?.isMiniBossAd;
        const isBerserker = m.attackType === "berserker" || m.isBerserker;
        
        // Calculate berserker rage intensity (0-1 based on HP loss)
        const berserkerRage = isBerserker ? Math.max(0, 1 - (m.hp / m.maxHp)) : 0;
        
        // Determine which image to use (if any) - check individual image directly
        // Mini-boss and mini-boss ads use the same images as boss, just scaled down
        let bossImage = null;
        if ((isBoss || isMiniBoss) && bossImages.boss && bossImages.boss.complete && bossImages.boss.naturalWidth > 0) {
          bossImage = bossImages.boss;
        } else if ((isBossAd || isMiniBossAd) && bossAdVariant >= 1 && bossAdVariant <= 5) {
          const adImg = bossImages[`ad${bossAdVariant}`];
          if (adImg && adImg.complete && adImg.naturalWidth > 0) {
            bossImage = adImg;
          }
        } else if (isMiniBossAd) {
          // Mini-boss ads use a random ad image (cycle based on id)
          const adVariant = (parseInt(m.id, 36) % 5) + 1;
          const adImg = bossImages[`ad${adVariant}`];
          if (adImg && adImg.complete && adImg.naturalWidth > 0) {
            bossImage = adImg;
          }
        }

        ctx.save();
        ctx.translate(x, y);
        
        if (bossImage) {
          // Render boss/boss-ad/mini-boss using image
          ctx.rotate(rotation);
          ctx.globalAlpha = phaseAlpha + 0.3; // Slightly more visible for bosses
          
          // Draw glow effect behind boss
          if (isBoss) {
            setShadow(ctx, "#ff0000", 20);
          } else if (isMiniBoss) {
            setShadow(ctx, "#ff4400", 15); // Orange-red glow for mini-boss
          } else if (isBossAd) {
            setShadow(ctx, "#ff6600", 12);
          } else if (isMiniBossAd) {
            setShadow(ctx, "#ff6600", 8); // Smaller glow for mini-boss ads
          }
          
          // Draw the image centered and scaled to fit the radius
          const imgSize = r * 2.2; // Slightly larger than hitbox
          ctx.drawImage(bossImage, -imgSize/2, -imgSize/2, imgSize, imgSize);
          clearShadow(ctx);
          ctx.globalAlpha = 1;
        } else {
          // Standard procedural asteroid rendering
          ctx.rotate(rotation);
          
          // Special color for mini-boss
          let renderColor = baseColor;
          let glowSize = 8;
          if (isMiniBoss) {
            renderColor = "#ff4400";
            glowSize = 15;
          } else if (isMiniBossAd) {
            renderColor = "#ff6600";
            glowSize = 10;
          } else if (isBerserker) {
            // Berserker glows redder and more intensely as it loses HP
            const r = Math.floor(255);
            const g = Math.floor(100 * (1 - berserkerRage * 0.8));
            const b = Math.floor(50 * (1 - berserkerRage));
            renderColor = `rgb(${r},${g},${b})`;
            glowSize = 8 + berserkerRage * 20;
          }
          
          // Viral Payload: Infected asteroids turn green
          if (m.infected) {
            const pulse = Math.sin(Date.now() * 0.01) * 0.3 + 0.7;
            renderColor = `rgb(0, ${Math.floor(255 * pulse)}, 0)`;
            glowSize = 12 + pulse * 8;
          }
          
          ctx.fillStyle = hexToRgba(renderColor, phaseAlpha);
          ctx.strokeStyle = renderColor;
          ctx.lineWidth = 1.5;
          setShadow(ctx, renderColor, glowSize);

          if (cached?.vertices && cached.vertices.length > 0) {
            ctx.beginPath();
            for (let i = 0; i <= cached.vertices.length; i++) {
              const v = cached.vertices[i % cached.vertices.length];
              const px = Math.cos(v.angle) * r * v.dist;
              const py = Math.sin(v.angle) * r * v.dist;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          clearShadow(ctx);
        }
        
        ctx.restore();

        // Static charge visual (Chain Reaction module)
        if (m.staticCharge && m.staticCharge > 0) {
          const chargeIntensity = Math.min(1, m.staticCharge / 10);
          ctx.save();
          ctx.strokeStyle = hexToRgba("#ffff00", 0.6 + chargeIntensity * 0.4);
          ctx.lineWidth = 2;
          ctx.shadowColor = "#ffff00";
          ctx.shadowBlur = 10 + chargeIntensity * 15;
          
          // Electric arcs around the asteroid
          const arcCount = 3 + Math.floor(chargeIntensity * 3);
          for (let i = 0; i < arcCount; i++) {
            const angle = (Date.now() * 0.005 + i * Math.PI * 2 / arcCount) % (Math.PI * 2);
            const innerR = r * 0.9;
            const outerR = r * (1.2 + Math.random() * 0.3);
            ctx.beginPath();
            ctx.moveTo(x + Math.cos(angle) * innerR, y + Math.sin(angle) * innerR);
            ctx.lineTo(x + Math.cos(angle + 0.2) * outerR, y + Math.sin(angle + 0.2) * outerR);
            ctx.stroke();
          }
          ctx.restore();
        }
        
        // Viral infection visual (Viral Payload module)
        if (m.infected) {
          ctx.save();
          ctx.shadowColor = "#00ff00";
          ctx.shadowBlur = 15;
          
          // Toxic bubbles around the asteroid
          const bubbleCount = 5;
          for (let i = 0; i < bubbleCount; i++) {
            const angle = (Date.now() * 0.003 + i * Math.PI * 2 / bubbleCount) % (Math.PI * 2);
            const bubbleR = r * (1.1 + Math.sin(Date.now() * 0.01 + i) * 0.2);
            const bubbleSize = 3 + Math.sin(Date.now() * 0.008 + i * 2) * 2;
            
            ctx.fillStyle = hexToRgba("#00ff00", 0.6);
            ctx.beginPath();
            ctx.arc(x + Math.cos(angle) * bubbleR, y + Math.sin(angle) * bubbleR, bubbleSize, 0, Math.PI * 2);
            ctx.fill();
          }
          
          // Virus icon indicator
          ctx.font = `${8 * sx}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#00ff00";
          ctx.fillText("🦠", x, y - r - 5 * sy);
          
          ctx.restore();
        }

        // HP bar
        if (m.hp < m.maxHp) {
          const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
          ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
        }

        // Attack type indicator (skip for boss/boss-ads/mini-boss which use images)
        if (!isBoss && !isBossAd && !isMiniBoss && !isMiniBossAd && m.attackType && ATTACK_TYPES[m.attackType]) {
          ctx.font = `${10 * sx}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(ATTACK_TYPES[m.attackType].icon, x, y + r + 12 * sy);
        }
        
        // Mini-boss indicator (skull icon below)
        if (isMiniBoss && !isMiniBossAd) {
          ctx.font = `${12 * sx}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("💀", x, y + r + 14 * sy);
        }
        
        // Berserker rage flames (visual effect when enraged)
        if (isBerserker && berserkerRage > 0.2) {
          ctx.save();
          ctx.globalAlpha = berserkerRage * 0.8;
          const flameCount = Math.floor(3 + berserkerRage * 4);
          for (let i = 0; i < flameCount; i++) {
            const angle = (Date.now() * 0.008 + i * Math.PI * 2 / flameCount) % (Math.PI * 2);
            const flameR = r * (1.0 + Math.random() * 0.3);
            ctx.font = `${(8 + berserkerRage * 6) * sx}px sans-serif`;
            ctx.fillText("🔥", x + Math.cos(angle) * flameR, y + Math.sin(angle) * flameR);
          }
          ctx.restore();
        }
      }

      // Render local bullets
      for (const b of clientBullets) {
        const baseColor = PLAYER_COLORS[b.slot]?.main || "#0ff";
        drawBullet(b, sx, sy, baseColor);
      }

      // Damage numbers
      if (showDamageNumbers && lastSnap.damageNumbers) {
        for (const d of lastSnap.damageNumbers) {
          ctx.font = `bold ${d.isCrit ? 16 : 12}px 'Courier New', monospace`;
          ctx.textAlign = "center";
          // Use custom color if provided, otherwise default crit/normal colors
          if (d.customColor) {
            ctx.fillStyle = hexToRgba(d.customColor, d.life);
          } else {
            ctx.fillStyle = d.isCrit ? `rgba(255,255,0,${d.life})` : `rgba(255,255,255,${d.life})`;
          }
          // Handle string amounts (like "+$1" for Taxman) or numeric amounts
          let displayText;
          if (typeof d.amount === 'string') {
            displayText = d.amount;
          } else {
            const rounded = Math.round(d.amount * 100) / 100;
            displayText = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, '');
          }
          ctx.fillText(displayText, d.x * sx, d.y * sy);
        }
      }

      // Players and turrets
      hoveredOpponentTower = null; // Reset hover state
      for (const p of lastSnap.players) {
        if (p.slot < 0) continue;
        const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
        const cx = (p.slot * world.segmentWidth + world.segmentWidth / 2) * sx;
        const isDead = p.hp <= 0;

        // Aim line for current player
        if (p.id === myId && mouseDown && !buildMenuOpen && !isDead) {
          const turretX = cx;
          const turretY = (560 - 14) * sy;
          const worldMouseX = (mouseX - offsetX) / sx;
          const worldMouseY = (mouseY - offsetY) / sy;
          const dx = worldMouseX - (p.slot * world.segmentWidth + world.segmentWidth / 2);
          const dy = worldMouseY - 560;
          let angle = Math.atan2(dy, dx);
          const maxAngle = (80 * Math.PI) / 180;
          const clampedAngle = -Math.PI / 2 + Math.max(-maxAngle, Math.min(maxAngle, angle - (-Math.PI / 2)));
          const endX = (p.slot * world.segmentWidth + world.segmentWidth / 2) + Math.cos(clampedAngle) * 500;
          const endY = 560 + Math.sin(clampedAngle) * 500;
          ctx.save();
          ctx.strokeStyle = hexToRgba(color.main, 0.4);
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 8]);
          ctx.beginPath();
          ctx.moveTo(turretX, turretY);
          ctx.lineTo(endX * sx, endY * sy);
          ctx.stroke();
          ctx.restore();
        }

        // Main turret using sprites
        const turretAlpha = isDead ? 0.3 : 1;
        const groundY = 560 * sy; // Base of playing field
        
        // Check if turret images are loaded
        const hasBase = turretImages.base.complete && turretImages.base.naturalWidth > 0;
        const hasBarrel = turretImages.barrel.complete && turretImages.barrel.naturalWidth > 0;
        
        if (hasBase && hasBarrel) {
          // Calculate base size preserving aspect ratio
          const baseAspect = turretImages.base.naturalWidth / turretImages.base.naturalHeight;
          const baseW = 43.75 * sx; // Width (35 * 1.25 = 25% bigger)
          const baseH = baseW / baseAspect; // Height calculated from aspect ratio
          
          // Barrel dimensions (preserve aspect ratio)
          const barrelAspect = turretImages.barrel.naturalWidth / turretImages.barrel.naturalHeight;
          const barrelH = 35 * sy;
          const barrelW = barrelH * barrelAspect;
          
          // Position: bottom of base at ground, horizontally centered
          const baseX = cx - baseW / 2;
          const baseY = groundY - baseH;
          const turretCenterX = cx;
          const turretCenterY = groundY - baseH / 2; // Center of base for barrel rotation
          
          ctx.save();
          ctx.globalAlpha = turretAlpha;
          
          // Draw glow effect behind turret
          if (!isDead) {
            setShadow(ctx, color.main, 15);
          }
          
          // Draw the base first (below barrel) - bottom at ground level
          ctx.drawImage(turretImages.base, baseX, baseY, baseW, baseH);
          
          clearShadow(ctx);
          
          // Draw the rotating barrel on top
          ctx.save();
          ctx.translate(turretCenterX, turretCenterY);
          ctx.rotate(p.turretAngle + Math.PI / 2); // Rotate to face target
          // Barrel anchor point at 25% from bottom (75% above, 25% below)
          ctx.drawImage(turretImages.barrel, -barrelW / 2, -barrelH * 0.75, barrelW, barrelH);
          ctx.restore();
          
          ctx.restore();
        } else {
          // Fallback to procedural rendering if sprites not loaded
          const baseW = 24 * sx;
          const baseH = 14 * sy;
          ctx.fillStyle = hexToRgba(color.main, turretAlpha);
          ctx.strokeStyle = color.main;
          ctx.lineWidth = 1.5;
          if (!isDead) setShadow(ctx, color.main, 15);
          ctx.beginPath();
          ctx.roundRect(cx - baseW / 2, 560 * sy - baseH, baseW, baseH, 3);
          ctx.fill();
          ctx.stroke();
          ctx.save();
          ctx.translate(cx, 560 * sy - baseH / 2);
          ctx.rotate(p.turretAngle + Math.PI / 2);
          ctx.fillStyle = hexToRgba(color.main, turretAlpha);
          ctx.fillRect(-2.5 * sx, -22 * sy, 5 * sx, 22 * sy);
          ctx.restore();
          clearShadow(ctx);
        }

        // Tower slots
        const offsets = [-110, -50, 50, 110];
        const towers = p.towers || [null, null, null, null];
        towers.forEach((t, i) => {
          const tx = cx + offsets[i] * sx;
          const ty = 560 * sy;
          
          // Check hover for OPPONENT towers (not own)
          // Note: tx/ty are in translated coordinates, mouseX/mouseY are screen coords
          // Need to add offsetX/offsetY to convert tx/ty to screen coords
          if (t && p.id !== myId) {
            const screenTx = tx + offsetX;
            const screenTy = (ty - 15 * sy) + offsetY;
            const hoverRadius = 20 * sx;
            const dist = Math.sqrt((mouseX - screenTx) ** 2 + (mouseY - screenTy) ** 2);
            if (dist < hoverRadius) {
              hoveredOpponentTower = {
                playerId: p.id,
                playerName: p.name,
                towerIndex: i,
                x: screenTx,
                y: screenTy,
                tower: t,
                color: color.main
              };
            }
          }
          
          if (t) {
            const typeInfo = TOWER_TYPES[t.type];
            if (typeInfo) {
              const tColor = typeInfo.color || "#fff";
              const level = t.level || 1;
              const towerAlpha = isDead ? 0.3 : 1;
              const towerAngle = t.angle !== undefined ? t.angle : -Math.PI / 2;
              const scale = 0.6; // Make towers smaller

              // Platform (doesn't rotate)
              const platformW = 22 * sx * scale;
              const platformH = 6 * sy * scale;
              ctx.fillStyle = hexToRgba("#333", 0.9 * towerAlpha);
              ctx.strokeStyle = hexToRgba(tColor, 0.6 * towerAlpha);
              ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.roundRect(tx - platformW / 2, ty - platformH, platformW, platformH, 2);
                ctx.fill();
                ctx.stroke();

                // Check for Copycat module - render mini main turret INSTEAD of normal tower
                const hasCopycat = t.modules && t.modules.includes && t.modules.includes("copycat");
                
                if (hasCopycat) {
                  // Draw a mini version of the main turret using the same sprites
                  const hasBase = turretImages.base.complete && turretImages.base.naturalWidth > 0;
                  const hasBarrel = turretImages.barrel.complete && turretImages.barrel.naturalWidth > 0;
                  
                  if (hasBase && hasBarrel) {
                    const miniScale = 0.5; // 50% of main turret size
                    const baseAspect = turretImages.base.naturalWidth / turretImages.base.naturalHeight;
                    const baseW = 43.75 * sx * miniScale;
                    const baseH = baseW / baseAspect;
                    
                    const barrelAspect = turretImages.barrel.naturalWidth / turretImages.barrel.naturalHeight;
                    const barrelH = 35 * sy * miniScale;
                    const barrelW = barrelH * barrelAspect;
                    
                    // Position mini turret on the platform
                    const turretCenterX = tx;
                    const turretCenterY = ty - platformH - baseH / 2;
                    
                    ctx.save();
                    ctx.globalAlpha = towerAlpha;
                    
                    // Glow effect matching player color
                    if (!isDead) {
                      setShadow(ctx, color.main, 12);
                    }
                    
                    // Draw mini base on platform
                    ctx.drawImage(turretImages.base, tx - baseW / 2, ty - platformH - baseH, baseW, baseH);
                    
                    clearShadow(ctx);
                    
                    // Draw mini rotating barrel
                    ctx.save();
                    ctx.translate(turretCenterX, turretCenterY);
                    ctx.rotate(towerAngle + Math.PI / 2);
                    ctx.drawImage(turretImages.barrel, -barrelW / 2, -barrelH * 0.75, barrelW, barrelH);
                    ctx.restore();
                    
                    ctx.restore();
                  } else {
                    // Fallback if images not loaded - draw simple copy
                    if (!isDead) setShadow(ctx, color.main, 10);
                    ctx.save();
                    ctx.translate(tx, ty - platformH);
                    ctx.rotate(towerAngle + Math.PI / 2);
                    ctx.fillStyle = hexToRgba(color.main, towerAlpha);
                    ctx.fillRect(-3 * sx * scale, -20 * sy * scale, 6 * sx * scale, 20 * sy * scale);
                    ctx.restore();
                    clearShadow(ctx);
                  }
                } else {
                  // Normal tower rendering
                  if (!isDead) setShadow(ctx, tColor, 8 + level * 2);

                  // Rotating turret part
                  ctx.save();
                  ctx.translate(tx, ty - platformH);
                  ctx.rotate(towerAngle + Math.PI / 2);

                  if (typeInfo.name === "Gatling") {
                    const bodyW = 14 * sx * scale;
                    const bodyH = 12 * sy * scale;
                    ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                    ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.roundRect(-bodyW / 2, -bodyH, bodyW, bodyH, 3);
                    ctx.fill();
                    ctx.stroke();
                    // Triple barrels
                    for (let b = -1; b <= 1; b++) {
                      ctx.fillStyle = hexToRgba(tColor, towerAlpha);
                      ctx.fillRect(b * 3 * sx * scale - 1 * sx * scale, -bodyH - 10 * sy * scale, 2 * sx * scale, 12 * sy * scale);
                    }
                  } else if (typeInfo.name === "Railgun") {
                    const bodyW = 10 * sx * scale;
                    const bodyH = 14 * sy * scale;
                    ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                    ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.roundRect(-bodyW / 2, -bodyH, bodyW, bodyH, 2);
                    ctx.fill();
                    ctx.stroke();
                    // Long barrel (railgun coils)
                    ctx.fillStyle = hexToRgba(tColor, towerAlpha);
                    ctx.fillRect(-2 * sx * scale, -bodyH - 16 * sy * scale, 4 * sx * scale, 18 * sy * scale);
                    // Energy coils
                    ctx.strokeStyle = hexToRgba("#00ffff", towerAlpha * 0.8);
                    ctx.lineWidth = 1.5 * sx * scale;
                    for (let ring = 0; ring < 3; ring++) {
                      const ringY = -bodyH - 4 * sy * scale - ring * 5 * sy * scale;
                      ctx.beginPath();
                      ctx.arc(0, ringY, 3.5 * sx * scale, 0, Math.PI * 2);
                      ctx.stroke();
                    }
                  } else if (typeInfo.name === "Missile") {
                    const bodyW = 16 * sx * scale;
                    const bodyH = 12 * sy * scale;
                    ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                    ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.roundRect(-bodyW / 2, -bodyH, bodyW, bodyH, 3);
                    ctx.fill();
                    ctx.stroke();
                    // Missile tubes
                    ctx.fillStyle = "#222";
                    for (let m = -1; m <= 1; m += 2) {
                      ctx.beginPath();
                      ctx.arc(m * 4 * sx * scale, -bodyH / 2, 3 * sx * scale, 0, Math.PI * 2);
                      ctx.fill();
                    }
                    // Missile tips
                    ctx.fillStyle = hexToRgba("#ff6600", towerAlpha);
                    for (let m = -1; m <= 1; m += 2) {
                      ctx.beginPath();
                      ctx.arc(m * 4 * sx * scale, -bodyH - 2 * sy * scale, 2 * sx * scale, 0, Math.PI * 2);
                      ctx.fill();
                    }
                  }
                  ctx.restore();
                  clearShadow(ctx);
                }
                
                // Drone Command: Render orbiting drone for this tower
                if (t.dronePos) {
                  const droneX = t.dronePos.x * sx;
                  const droneY = t.dronePos.y * sy;
                  const droneSize = 6 * sx;
                  
                  ctx.save();
                  ctx.translate(droneX, droneY);
                  
                  // Drone glow
                  ctx.shadowColor = "#44aaff";
                  ctx.shadowBlur = 8;
                  
                  // Drone body (UFO shape)
                  ctx.fillStyle = hexToRgba("#44aaff", isDead ? 0.3 : 0.9);
                  ctx.beginPath();
                  ctx.ellipse(0, 0, droneSize, droneSize * 0.5, 0, 0, Math.PI * 2);
                  ctx.fill();
                  
                  // Drone dome
                  ctx.fillStyle = hexToRgba("#88ccff", isDead ? 0.3 : 0.8);
                  ctx.beginPath();
                  ctx.arc(0, -droneSize * 0.2, droneSize * 0.4, Math.PI, 0);
                  ctx.fill();
                  
                  // Drone lights (pulsing)
                  const dronePulse = Math.sin(Date.now() / 100 + i) * 0.3 + 0.7;
                  ctx.fillStyle = `rgba(255, 255, 100, ${dronePulse * (isDead ? 0.3 : 1)})`;
                  ctx.beginPath();
                  ctx.arc(-droneSize * 0.6, 0, 1.5 * sx, 0, Math.PI * 2);
                  ctx.arc(droneSize * 0.6, 0, 1.5 * sx, 0, Math.PI * 2);
                  ctx.fill();
                  
                  ctx.restore();
                }

              // Level stars
              if (level > 1) {
                ctx.fillStyle = "#ffd700";
                ctx.font = `bold ${8 * sx}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const levelText = "★".repeat(Math.min(level - 1, 4));
                ctx.fillText(levelText, tx, ty + 8 * sy);
              }

              // Upgrade indicator
              if (p.id === myId && level < MAX_TOWER_LEVEL && !isDead) {
                const pulse = (Math.sin(time * 4) + 1) / 2 * 0.3;
                ctx.strokeStyle = `rgba(255, 215, 0, ${0.3 + pulse})`;
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.arc(tx, ty - 20 * sy, 18 * sx, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            }
          } else if (p.id === myId && !isDead) {
            // Empty slot
            ctx.save();
            const pulse = (Math.sin(time * 8) + 1) / 2;
            ctx.strokeStyle = `rgba(0, 255, 136, ${0.2 + pulse * 0.3})`;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.roundRect(tx - 14 * sx, ty - 8 * sy, 28 * sx, 8 * sy, 3);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = `rgba(0, 255, 136, ${0.15 + pulse * 0.25})`;
            ctx.strokeStyle = `rgba(0, 255, 136, ${0.4 + pulse * 0.4})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(tx, ty - 18 * sy, 12 * sx, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = `bold ${16 * sx}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("+", tx, ty - 18 * sy);
            ctx.restore();
          }
        });

        // Player name and HP
        ctx.font = "bold 11px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = isDead ? "#666" : color.main;
        ctx.fillText(isDead ? `${p.name} 💀` : p.name, cx, groundY + 14);

        // Individual HP bar for PvP
        const hpBarW = 60 * sx;
        const hpBarH = 6 * sy;
        const hpBarX = cx - hpBarW / 2;
        const hpBarY = groundY + 20;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(hpBarX, hpBarY, hpBarW, hpBarH);
        ctx.fillStyle = isDead ? "#444" : (p.hp / p.maxHp) > 0.5 ? "#0f8" : "#f44";
        ctx.fillRect(hpBarX, hpBarY, hpBarW * Math.max(0, p.hp / p.maxHp), hpBarH);
        ctx.strokeStyle = isDead ? "#444" : color.main;
        ctx.strokeRect(hpBarX, hpBarY, hpBarW, hpBarH);
        ctx.font = `bold ${8 * sx}px 'Courier New', monospace`;
        ctx.fillStyle = "#fff";
        ctx.fillText(`${p.hp}/${p.maxHp}`, cx, hpBarY + hpBarH / 2 + 1);
        
        // Gold display under HP bar
        if (!isDead) {
          ctx.font = `bold ${10 * sx}px 'Courier New', monospace`;
          ctx.fillStyle = "#ffd700";
          ctx.fillText(`${p.gold} 🟡`, cx, hpBarY + hpBarH + 12);
          
          // Total income display (what they earned last wave)
          if (p.totalIncome > 0) {
            ctx.font = `bold ${9 * sx}px 'Courier New', monospace`;
            ctx.fillStyle = "#7fff7f";
            ctx.fillText(`+${p.totalIncome}/wave`, cx, hpBarY + hpBarH + 24);
          }
        }
      }
      ctx.restore();

      // ===== OPPONENT TOWER MODULE TOOLTIP =====
      if (hoveredOpponentTower && hoveredOpponentTower.tower) {
        const t = hoveredOpponentTower.tower;
        const typeInfo = TOWER_TYPES[t.type];
        const modules = t.modules || [];
        const MODULES = window.TOWER_MODULES || {};
        
        // Tooltip dimensions
        const tooltipW = 160;
        const hasModules = modules.length > 0 && modules.some(m => m);
        const moduleCount = modules.filter(m => m).length;
        const tooltipH = 45 + (hasModules ? moduleCount * 22 : 20);
        
        // Position tooltip above the tower
        let tooltipX = hoveredOpponentTower.x - tooltipW / 2;
        let tooltipY = hoveredOpponentTower.y - tooltipH - 25;
        
        // Keep on screen
        tooltipX = Math.max(5, Math.min(canvas.width - tooltipW - 5, tooltipX));
        tooltipY = Math.max(5, tooltipY);
        
        // Background
        ctx.fillStyle = "rgba(10,15,30,0.95)";
        ctx.strokeStyle = hoveredOpponentTower.color || "#7ae0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 8);
        ctx.fill();
        ctx.stroke();
        
        // Player name and tower type
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = hoveredOpponentTower.color || "#fff";
        ctx.fillText(`${hoveredOpponentTower.playerName}'s`, tooltipX + 8, tooltipY + 14);
        
        ctx.fillStyle = typeInfo?.color || "#fff";
        ctx.font = "bold 11px 'Courier New', monospace";
        const towerName = typeInfo?.name || "Tower";
        const levelText = t.level > 1 ? ` ${"★".repeat(Math.min(t.level - 1, 4))}` : "";
        ctx.fillText(`${towerName}${levelText}`, tooltipX + 8, tooltipY + 28);
        
        // Modules
        if (hasModules) {
          ctx.font = "9px 'Courier New', monospace";
          ctx.fillStyle = "#888";
          ctx.fillText("MODULES:", tooltipX + 8, tooltipY + 42);
          
          let modY = tooltipY + 56;
          for (const modId of modules) {
            if (!modId) continue;
            const mod = MODULES[modId];
            if (mod) {
              ctx.font = "11px sans-serif";
              ctx.fillStyle = mod.color || "#aaa";
              ctx.fillText(`${mod.icon} ${mod.name}`, tooltipX + 10, modY);
              modY += 22;
            }
          }
        } else {
          ctx.font = "9px 'Courier New', monospace";
          ctx.fillStyle = "#555";
          ctx.fillText("No modules", tooltipX + 8, tooltipY + 42);
        }
        
        ctx.textAlign = "left";
      }

      // HUD
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, canvas.width, 50);
      drawNeonText(`WAVE ${wave}`, 20, 25, "#ff0", 18, "left");
      
      // Gravity indicator (shows when > 1.0x) - below wave text
      const gravityMult = lastSnap.gravityMult || 1;
      if (gravityMult > 1.05) {
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        // Color from green to red based on gravity (1.0 = green, 2.0+ = red)
        const gravityIntensity = Math.min((gravityMult - 1) / 1.0, 1); // 0 to 1
        const r = Math.floor(100 + 155 * gravityIntensity);
        const g = Math.floor(200 * (1 - gravityIntensity));
        ctx.fillStyle = `rgb(${r}, ${g}, 100)`;
        ctx.fillText(`⬇${gravityMult.toFixed(2)}x`, 22, 42);
      }
      
      // Pause button in HUD bar (for non-spectators)
      if (phase === "playing" && !isSpectator) {
        const pauseBtnW = 36;
        const pauseBtnH = 28;
        const pauseBtnX = 115;
        const pauseBtnY = 11;
        
        hoveredPauseButton = mouseX >= pauseBtnX && mouseX <= pauseBtnX + pauseBtnW && 
                             mouseY >= pauseBtnY && mouseY <= pauseBtnY + pauseBtnH;
        
        const isPaused = gamePaused || pauseCountdown > 0;
        const btnColor = isPaused ? "#ff6600" : "#555";
        const btnText = isPaused ? (pauseCountdown > 0 ? `▶${Math.ceil(pauseCountdown)}` : "▶") : "❚❚";
        
        ctx.fillStyle = hoveredPauseButton ? (isPaused ? "rgba(255,102,0,0.3)" : "rgba(100,100,100,0.3)") : "rgba(40,40,60,0.5)";
        ctx.strokeStyle = hoveredPauseButton ? (isPaused ? "#ff6600" : "#888") : btnColor;
        ctx.lineWidth = hoveredPauseButton ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(pauseBtnX, pauseBtnY, pauseBtnW, pauseBtnH, 4);
        ctx.fill();
        ctx.stroke();
        
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = hoveredPauseButton ? "#fff" : (isPaused ? "#ff6600" : "#888");
        ctx.fillText(btnText, pauseBtnX + pauseBtnW / 2, pauseBtnY + pauseBtnH / 2);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
      }
      
      // Game modifier indicator (after pause button, on main line)
      let hudNextX = 160; // After pause button
      if (activeGameModifier && activeGameModifier.id !== "standard") {
        ctx.font = "12px monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = activeGameModifier.color || "#888";
        ctx.fillText(`${activeGameModifier.icon} ${activeGameModifier.name}`, hudNextX, 25);
        hudNextX += ctx.measureText(`${activeGameModifier.icon} ${activeGameModifier.name}`).width + 15;
      }
      
      // Spectator indicator
      if (isSpectator) {
        ctx.fillStyle = "rgba(255,100,100,0.9)";
        ctx.fillRect(canvas.width / 2 - 80, 5, 160, 25);
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText("👁 SPECTATING", canvas.width / 2, 22);
        ctx.textAlign = "left";
      } else if (spectatorCount > 0) {
        // Show spectator count for players
        ctx.font = "12px 'Courier New', monospace";
        ctx.fillStyle = "#888";
        ctx.textAlign = "center";
        ctx.fillText(`👁 ${spectatorCount}`, canvas.width / 2, 42);
        ctx.textAlign = "left";
      }
      
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      if (myPlayer) {
        // Gold display (positioned after modifier or at base position)
        const goldX = Math.max(hudNextX, 160);
        drawNeonText(`${myPlayer.gold} 🟡`, goldX, 25, "#fd0", 14, "left");
        // Show last interest gained (if any)
        const goldWidth = ctx.measureText(`${myPlayer.gold} 🟡`).width;
        if (myPlayer.lastInterest > 0) {
          ctx.font = "bold 10px 'Courier New', monospace";
          ctx.fillStyle = "#0f0";
          ctx.textAlign = "left";
          ctx.fillText(`+${myPlayer.lastInterest}`, goldX + goldWidth + 5, 25);
        }
        // Kills further right
        drawNeonText(`${myPlayer.kills} 💀`, goldX + goldWidth + 50, 25, "#f44", 14, "left");
      }
      
      // Latency display (top right, before scoreboard)
      if (latency > 0) {
        ctx.font = "10px 'Courier New', monospace";
        ctx.textAlign = "right";
        const pingColor = latency < 50 ? "#0f0" : latency < 100 ? "#ff0" : latency < 200 ? "#f80" : "#f44";
        ctx.fillStyle = pingColor;
        ctx.fillText(`${latency}ms`, canvas.width - 20, 45);
        ctx.textAlign = "left";
      }

      // Scoreboard (Now shows DAMAGE)
      ctx.textAlign = "right";
      ctx.font = "12px 'Courier New', monospace";
      let scoreX = canvas.width - 20;
      for (let i = lastSnap.players.length - 1; i >= 0; i--) {
        const p = lastSnap.players[i];
        const color = PLAYER_COLORS[p.slot]?.main || "#fff";
        ctx.fillStyle = p.hp <= 0 ? "#666" : color;
        // SHOW DAMAGE instead of score
        const text = `${p.name}: ${Math.round(p.damageDealt || 0)} dmg`;
        ctx.fillText(text, scoreX, 30);
        scoreX -= ctx.measureText(text).width + 20;
      }
      ctx.textAlign = "left";

      // ===== MUSIC PLAYER (Above Stats Button - Bottom Right) =====
      // Only show during gameplay (not lobby or gameover)
      if (musicState.trackName && phase === "playing") {
        const mpW = musicState.expanded ? 220 : 40;
        const mpH = musicState.expanded ? 80 : 40;
        const mpX = canvas.width - mpW - 12;
        // Position well above stats button (stats btn is at canvas.height - 47)
        const mpY = canvas.height - mpH - 100;
        
        // Store bounds for click detection
        window.musicPlayerBounds = { x: mpX, y: mpY, w: mpW, h: mpH };
        
        // Check hover
        const isHovering = mouseX >= mpX && mouseX <= mpX + mpW && 
                           mouseY >= mpY && mouseY <= mpY + mpH;
        
        // Background
        ctx.fillStyle = isHovering ? "rgba(20,30,50,0.95)" : "rgba(10,17,34,0.9)";
        ctx.strokeStyle = "#7ae0ff55";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(mpX, mpY, mpW, mpH, 8);
        ctx.fill();
        ctx.stroke();
        
        if (musicState.expanded) {
          // Expanded view - full controls
          musicPlayerHover = null;
          
          // Track name (scrolling if too long)
          ctx.save();
          ctx.beginPath();
          ctx.rect(mpX + 8, mpY + 8, mpW - 50, 18);
          ctx.clip();
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.fillStyle = "#7ae0ff";
          const trackNum = musicState.track + 1;
          const displayName = `${trackNum}. ${musicState.trackName.replace('.mp3', '')}`;
          ctx.fillText(displayName, mpX + 8, mpY + 20);
          ctx.restore();
          
          // Check if current player is DAMAGE leader (can control music)
          let isScoreLeader = true;
          let leaderName = "";
          if (lastSnap && lastSnap.players && lastSnap.players.length > 1) {
            const myPlayer = lastSnap.players.find(p => p.id === myId);
            let maxDamage = -1;
            let leader = null;
            for (const p of lastSnap.players) {
              // Check damageDealt instead of score
              const dmg = p.damageDealt || 0;
              if (dmg > maxDamage) {
                maxDamage = dmg;
                leader = p;
              }
            }
            isScoreLeader = myPlayer && leader && myPlayer.id === leader.id;
            leaderName = leader ? leader.name : "";
          }
          
          // Show DJ crown indicator
          ctx.font = "10px sans-serif";
          ctx.fillStyle = isScoreLeader ? "#ffd700" : "#555";
          ctx.textAlign = "right";
          ctx.fillText(isScoreLeader ? "👑 DJ" : `👑 ${leaderName.slice(0,6)}`, mpX + mpW - 30, mpY + 20);
          ctx.textAlign = "left";
          
          // Collapse button (top right)
          const collapseX = mpX + mpW - 28;
          const collapseY = mpY + 8;
          const collapseHover = mouseX >= collapseX && mouseX <= collapseX + 20 && 
                                mouseY >= collapseY && mouseY <= collapseY + 18;
          ctx.fillStyle = collapseHover ? "#7ae0ff" : "#557";
          ctx.font = "14px sans-serif";
          ctx.fillText("▼", collapseX + 4, collapseY + 14);
          if (collapseHover) musicPlayerHover = "collapse";
          
          // Control buttons row
          const btnY = mpY + 32;
          const btnSize = 28;
          const btnSpacing = 6;
          let btnX = mpX + 10;
          
          // Previous button (leader only)
          const prevHover = mouseX >= btnX && mouseX <= btnX + btnSize && 
                            mouseY >= btnY && mouseY <= btnY + btnSize;
          const prevEnabled = isScoreLeader;
          ctx.fillStyle = !prevEnabled ? "rgba(30,30,40,0.4)" : 
                          (prevHover ? "rgba(122,224,255,0.3)" : "rgba(40,60,100,0.4)");
          ctx.strokeStyle = !prevEnabled ? "#333" : (prevHover ? "#7ae0ff" : "#557");
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnSize, btnSize, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = !prevEnabled ? "#444" : (prevHover ? "#fff" : "#aaa");
          ctx.font = "14px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("⏮", btnX + btnSize/2, btnY + btnSize/2 + 5);
          if (prevHover && prevEnabled) musicPlayerHover = "prev";
          btnX += btnSize + btnSpacing;
          
          // Play/Pause (visual only - always playing)
          ctx.fillStyle = "rgba(122,224,255,0.2)";
          ctx.strokeStyle = "#7ae0ff";
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnSize, btnSize, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#7ae0ff";
          ctx.fillText("▶", btnX + btnSize/2, btnY + btnSize/2 + 5);
          btnX += btnSize + btnSpacing;
          
          // Next button (leader only)
          const nextHover = mouseX >= btnX && mouseX <= btnX + btnSize && 
                            mouseY >= btnY && mouseY <= btnY + btnSize;
          const nextEnabled = isScoreLeader;
          ctx.fillStyle = !nextEnabled ? "rgba(30,30,40,0.4)" : 
                          (nextHover ? "rgba(122,224,255,0.3)" : "rgba(40,60,100,0.4)");
          ctx.strokeStyle = !nextEnabled ? "#333" : (nextHover ? "#7ae0ff" : "#557");
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnSize, btnSize, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = !nextEnabled ? "#444" : (nextHover ? "#fff" : "#aaa");
          ctx.fillText("⏭", btnX + btnSize/2, btnY + btnSize/2 + 5);
          if (nextHover && nextEnabled) musicPlayerHover = "next";
          btnX += btnSize + btnSpacing;
          
          // Shuffle button (leader only)
          const shuffleHover = mouseX >= btnX && mouseX <= btnX + btnSize && 
                               mouseY >= btnY && mouseY <= btnY + btnSize;
          const shuffleEnabled = isScoreLeader;
          ctx.fillStyle = !shuffleEnabled ? "rgba(30,30,40,0.4)" : 
                          (shuffleHover ? "rgba(122,224,255,0.3)" : 
                          (musicState.shuffle ? "rgba(122,224,255,0.4)" : "rgba(40,60,100,0.4)"));
          ctx.strokeStyle = !shuffleEnabled ? "#333" : 
                            (shuffleHover || musicState.shuffle ? "#7ae0ff" : "#557");
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnSize, btnSize, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = !shuffleEnabled ? "#444" : 
                          (musicState.shuffle ? "#7ae0ff" : (shuffleHover ? "#fff" : "#aaa"));
          ctx.fillText("🔀", btnX + btnSize/2, btnY + btnSize/2 + 5);
          if (shuffleHover && shuffleEnabled) musicPlayerHover = "shuffle";
          btnX += btnSize + btnSpacing;
          
          // Mute button (everyone can use)
          const muteHover = mouseX >= btnX && mouseX <= btnX + btnSize && 
                            mouseY >= btnY && mouseY <= btnY + btnSize;
          ctx.fillStyle = muteHover ? "rgba(122,224,255,0.3)" : "rgba(40,60,100,0.4)";
          ctx.strokeStyle = muteHover ? "#7ae0ff" : "#557";
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnSize, btnSize, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = muteHover ? "#fff" : "#aaa";
          ctx.fillText(musicState.muted ? "🔇" : "🔊", btnX + btnSize/2, btnY + btnSize/2 + 5);
          if (muteHover) musicPlayerHover = "mute";
          
          // Volume slider
          const volX = mpX + 10;
          const volY = mpY + 66;
          const volW = mpW - 20;
          const volH = 6;
          
          ctx.fillStyle = "rgba(40,60,100,0.6)";
          ctx.beginPath();
          ctx.roundRect(volX, volY, volW, volH, 3);
          ctx.fill();
          
          const volFillW = volW * musicState.volume;
          ctx.fillStyle = "#7ae0ff";
          ctx.beginPath();
          ctx.roundRect(volX, volY, volFillW, volH, 3);
          ctx.fill();
          
          // Volume knob
          const knobX = volX + volFillW;
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(knobX, volY + volH/2, 5, 0, Math.PI * 2);
          ctx.fill();
          
          // Check volume slider hover
          if (mouseX >= volX && mouseX <= volX + volW && mouseY >= volY - 5 && mouseY <= volY + volH + 5) {
            musicPlayerHover = "volume";
          }
          
          ctx.textAlign = "left";
        } else {
          // Collapsed view - just music icon
          musicPlayerHover = null; // Reset first
          ctx.font = "20px sans-serif";
          ctx.fillStyle = isHovering ? "#7ae0ff" : "#557";
          ctx.textAlign = "center";
          ctx.fillText("🎵", mpX + mpW/2, mpY + mpH/2 + 7);
          ctx.textAlign = "left";
          
          if (isHovering) musicPlayerHover = "expand";
        }
      } else {
        // Music player not shown - clear bounds and hover
        window.musicPlayerBounds = null;
        musicPlayerHover = null;
      }

      // ===== DEATH MODS PANEL (For dead players only) =====
      if (phase === "playing" && myPlayer && myPlayer.hp <= 0 && !isSpectator) {
        hoveredDeathMod = null;
        const spite = myPlayer.spite || 0;
        
        const panelW = 200;
        const panelH = 280;
        const panelX = 15;
        const panelY = 60;
        
        // Panel background
        const grad = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelH);
        grad.addColorStop(0, "rgba(40,10,30,0.95)");
        grad.addColorStop(1, "rgba(20,5,15,0.95)");
        ctx.fillStyle = grad;
        ctx.strokeStyle = "#f448";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(panelX, panelY, panelW, panelH, 10);
        ctx.fill();
        ctx.stroke();
        
        // Title
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.fillStyle = "#f44";
        ctx.textAlign = "center";
        ctx.fillText("💀 SPITE POWERS 💀", panelX + panelW / 2, panelY + 22);
        
        // Spite currency
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.fillStyle = "#f88";
        ctx.fillText(`${spite} 💢`, panelX + panelW / 2, panelY + 45);
        
        ctx.font = "9px 'Courier New', monospace";
        ctx.fillStyle = "#888";
        ctx.fillText("+1 per wave while dead", panelX + panelW / 2, panelY + 58);
        
        // Death mod buttons
        const modIds = Object.keys(DEATH_MODS);
        let modY = panelY + 72;
        
        for (const modId of modIds) {
          const mod = DEATH_MODS[modId];
          const canAfford = spite >= mod.cost;
          
          const btnH = 38;
          const btnX = panelX + 8;
          const btnW = panelW - 16;
          
          const isHover = mouseX >= btnX && mouseX <= btnX + btnW && 
                          mouseY >= modY && mouseY <= modY + btnH;
          
          if (isHover) hoveredDeathMod = modId;
          
          // Button background
          ctx.fillStyle = !canAfford ? "rgba(30,20,25,0.6)" : 
                          (isHover ? "rgba(100,40,60,0.7)" : "rgba(60,20,40,0.6)");
          ctx.strokeStyle = !canAfford ? "#333" : (isHover ? "#f66" : "#844");
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(btnX, modY, btnW, btnH, 5);
          ctx.fill();
          ctx.stroke();
          
          // Icon and name
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.textAlign = "left";
          ctx.fillStyle = !canAfford ? "#555" : (isHover ? "#fff" : "#ccc");
          ctx.fillText(`${mod.icon} ${mod.name}`, btnX + 6, modY + 14);
          
          // Cost
          ctx.textAlign = "right";
          ctx.fillStyle = !canAfford ? "#622" : (isHover ? "#f88" : "#f66");
          ctx.fillText(`${mod.cost}💢`, btnX + btnW - 6, modY + 14);
          
          // Description
          ctx.font = "9px 'Courier New', monospace";
          ctx.textAlign = "left";
          ctx.fillStyle = !canAfford ? "#444" : "#888";
          ctx.fillText(mod.desc.slice(0, 30), btnX + 6, modY + 28);
          if (mod.desc.length > 30) {
            ctx.fillText(mod.desc.slice(30), btnX + 6, modY + 36);
          }
          
          modY += btnH + 4;
        }
        
        ctx.textAlign = "left";
      }

      // ===== UNIFIED RIGHT PANEL (Attacks + DPS Meters) =====
      if (phase === "playing" && lastSnap && lastSnap.players.length > 1) {
        hoveredAttack = null;
        const panelW = 220; // 25% bigger (was 175)
        const panelX = canvas.width - panelW - 12;
        let currentY = 15;
        const myGold = myPlayer?.gold || 0;
        const isAlive = myPlayer && myPlayer.hp > 0;

        // Helper function to draw a section panel
        function drawSectionPanel(x, y, w, h, borderColor, title, titleColor) {
          // Panel background with gradient
          const grad = ctx.createLinearGradient(x, y, x, y + h);
          grad.addColorStop(0, "rgba(10,17,34,0.95)");
          grad.addColorStop(1, "rgba(15,20,40,0.95)");
          ctx.fillStyle = grad;
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 12);
          ctx.fill();
          ctx.stroke();
          
          // Title
          if (title) {
            ctx.font = "bold 14px 'Orbitron', sans-serif"; // Bigger font
            ctx.fillStyle = titleColor;
            ctx.textAlign = "center";
            ctx.fillText(title, x + w / 2, y + 20);
            
            // Separator line
            ctx.strokeStyle = hexToRgba(borderColor, 0.4);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 10, y + 30);
            ctx.lineTo(x + w - 10, y + 30);
            ctx.stroke();
          }
        }

        // Helper function to draw player damage row (reusable for both meters)
        function drawPlayerDamageRow(p, rowY, damage, maxDamage, totalDamage, isLeader, panelX, panelW) {
          const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
          const barWidth = maxDamage > 0 ? (damage / maxDamage) * (panelW - 55) : 0;
          const percent = totalDamage > 0 ? ((damage / totalDamage) * 100).toFixed(0) : "0";
          const isMe = p.id === myId;
          
          // Highlight row for current player
          if (isMe) {
            ctx.fillStyle = "rgba(122,224,255,0.08)";
            ctx.beginPath();
            ctx.roundRect(panelX + 4, rowY - 2, panelW - 8, 32, 5);
            ctx.fill();
          }
          
          // Player color indicator
          ctx.fillStyle = color.main;
          ctx.shadowColor = color.main;
          ctx.shadowBlur = isLeader ? 10 : 5;
          ctx.beginPath();
          ctx.roundRect(panelX + 10, rowY + 2, 5, 24, 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          
          // Rank / Crown
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "left";
          if (isLeader && damage > 0) {
            ctx.fillStyle = "#ffd700";
            ctx.fillText("👑", panelX + 20, rowY + 18);
          }
          
          // Player name
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.fillStyle = isLeader ? "#ffd700" : "#e8f0ff";
          const displayName = p.name.length > 10 ? p.name.substring(0, 9) + "…" : p.name;
          ctx.fillText(displayName, panelX + (isLeader ? 36 : 22), rowY + 12);
          
          // Damage amount
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.textAlign = "right";
          ctx.fillStyle = "#91ff7a";
          ctx.fillText(Math.round(damage).toLocaleString(), panelX + panelW - 38, rowY + 12);
          
          // Percentage
          ctx.font = "bold 10px 'Courier New', monospace";
          ctx.fillStyle = isLeader ? "#ffd700" : "#7ae0ff";
          ctx.fillText(percent + "%", panelX + panelW - 10, rowY + 12);
          
          // Damage bar background
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.beginPath();
          ctx.roundRect(panelX + 22, rowY + 18, panelW - 55, 7, 3);
          ctx.fill();
          
          // Damage bar fill
          if (barWidth > 2) {
            const barGrad = ctx.createLinearGradient(panelX + 22, 0, panelX + 22 + barWidth, 0);
            barGrad.addColorStop(0, hexToRgba(color.main, 0.4));
            barGrad.addColorStop(0.5, hexToRgba(color.main, 0.7));
            barGrad.addColorStop(1, color.main);
            ctx.fillStyle = barGrad;
            ctx.beginPath();
            ctx.roundRect(panelX + 22, rowY + 18, barWidth, 7, 3);
            ctx.fill();
            
            // Glow for leader
            if (isLeader) {
              ctx.shadowColor = color.main;
              ctx.shadowBlur = 8;
              ctx.fill();
              ctx.shadowBlur = 0;
            }
            
            // End pip
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.beginPath();
            ctx.arc(panelX + 22 + barWidth - 1, rowY + 21.5, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          
          ctx.textAlign = "left";
        }

        // ===== ATTACK SPAWN PANEL =====
        // GAME MODIFIER: Pacifist Protocol disables attacks
        const attacksDisabled = activeGameModifier && activeGameModifier.id === "noMobs";
        if (isAlive && !attacksDisabled) {
          const attackPanelH = 370; // 25% bigger (was 295)
          drawSectionPanel(panelX, currentY, panelW, attackPanelH, "rgba(255,68,68,0.5)", "⚔️ SEND ATTACKS", "#ff6666");
          
          // Quantity mode buttons (1x, 10x, MAX)
          const qBtnW = (panelW - 30) / 3;
          const qBtnH = 28;
          const qBtnY = currentY + 38;
          hoveredQuantityBtn = null;
          
          const quantityModes = [1, 10, "max"];
          const quantityLabels = ["1x", "10x", "MAX"];
          
          quantityModes.forEach((mode, i) => {
            const qBtnX = panelX + 8 + i * (qBtnW + 4);
            const isSelected = attackQuantityMode === mode;
            const isHovered = mouseX >= qBtnX && mouseX <= qBtnX + qBtnW && mouseY >= qBtnY && mouseY <= qBtnY + qBtnH;
            
            if (isHovered) hoveredQuantityBtn = mode;
            
            // Button background
            ctx.fillStyle = isSelected ? "rgba(255,100,100,0.4)" : 
                            isHovered ? "rgba(255,100,100,0.25)" : "rgba(40,40,60,0.6)";
            ctx.strokeStyle = isSelected ? "#ff6666" : isHovered ? "#ff8888" : "#444";
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.beginPath();
            ctx.roundRect(qBtnX, qBtnY, qBtnW, qBtnH, 5);
            ctx.fill();
            ctx.stroke();
            
            // Label
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = isSelected ? "#fff" : "#999";
            ctx.fillText(quantityLabels[i], qBtnX + qBtnW / 2, qBtnY + 19);
          });

          // Attack buttons
          const attacks = Object.entries(ATTACK_TYPES);
          const btnH = 45; // 25% bigger (was 36)
          const btnGap = 4;
          const startY = currentY + 75;

          attacks.forEach(([key, atk], i) => {
            const btnY = startY + i * (btnH + btnGap);
            const btnX = panelX + 8;
            const btnW = panelW - 16;
            
            // Calculate cost based on quantity mode
            let displayCost = atk.cost;
            let canAfford = myGold >= atk.cost;
            let affordCount = Math.floor(myGold / atk.cost);
            
            if (attackQuantityMode === 10) {
              displayCost = atk.cost * Math.min(10, affordCount);
              canAfford = affordCount >= 1;
            } else if (attackQuantityMode === "max") {
              displayCost = atk.cost * affordCount;
              canAfford = affordCount >= 1;
            }
            
            const isHovered = mouseX >= btnX && mouseX <= btnX + btnW && mouseY >= btnY && mouseY <= btnY + btnH;

            if (isHovered && canAfford) hoveredAttack = key;

            // Button background
            ctx.fillStyle = isHovered && canAfford ? hexToRgba(atk.color, 0.35) : 
                            canAfford ? hexToRgba(atk.color, 0.12) : "rgba(20,20,30,0.6)";
            ctx.strokeStyle = isHovered && canAfford ? atk.color : 
                              canAfford ? hexToRgba(atk.color, 0.4) : "#2a2a3a";
            ctx.lineWidth = isHovered && canAfford ? 2 : 1;
            ctx.beginPath();
            ctx.roundRect(btnX, btnY, btnW, btnH, 8);
            ctx.fill();
            ctx.stroke();

            // Icon
            ctx.font = "20px sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(atk.icon, btnX + 8, btnY + 30);

            // Name
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? atk.color : "#444";
            ctx.fillText(atk.name.toUpperCase(), btnX + 36, btnY + 18);

            // Description with count hint
            ctx.font = "10px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? "rgba(255,255,255,0.5)" : "#333";
            let descText = atk.desc;
            if (attackQuantityMode === 10 && affordCount > 0) {
              descText = `×${Math.min(10, affordCount)}`;
            } else if (attackQuantityMode === "max" && affordCount > 0) {
              descText = `×${affordCount}`;
            }
            ctx.fillText(descText, btnX + 36, btnY + 32);

            // Cost (shows total for multi-buy)
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.textAlign = "right";
            ctx.fillStyle = canAfford ? "#ffd700" : "#444";
            const costText = attackQuantityMode === 1 ? `${atk.cost}g` : `${displayCost}g`;
            ctx.fillText(costText, btnX + btnW - 8, btnY + 26);
          });

          ctx.textAlign = "left";
          currentY += attackPanelH + 10;
        } else if (isAlive && attacksDisabled) {
          // Show disabled message for Pacifist Protocol
          const disabledH = 80;
          drawSectionPanel(panelX, currentY, panelW, disabledH, "rgba(100,100,100,0.3)", "⚔️ ATTACKS", "#666");
          
          ctx.font = "14px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#888";
          ctx.fillText("🕊️ DISABLED", panelX + panelW / 2, currentY + 45);
          ctx.font = "11px 'Courier New', monospace";
          ctx.fillStyle = "#666";
          ctx.fillText("Pacifist Protocol active", panelX + panelW / 2, currentY + 62);
          
          ctx.textAlign = "left";
          currentY += disabledH + 10;
        }

        // ===== TOTAL RUN DPS PANEL =====
        // Count active players without creating new array
        let playerCount = 0;
        let totalDamage = 0;
        let maxDamage = 1;
        for (const p of lastSnap.players) {
          if (p.slot >= 0) {
            playerCount++;
            const dmg = p.damageDealt || 0;
            totalDamage += dmg;
            if (dmg > maxDamage) maxDamage = dmg;
          }
        }
        
        const totalDmgPanelH = 55 + playerCount * 38;
        drawSectionPanel(panelX, currentY, panelW, totalDmgPanelH, "rgba(145,255,122,0.4)", "📊 TOTAL DAMAGE", "#91ff7a");
        
        // Total damage number (centered, big)
        ctx.font = "bold 16px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#91ff7a";
        ctx.shadowColor = "#91ff7a";
        ctx.shadowBlur = 12;
        ctx.fillText(Math.round(totalDamage).toLocaleString(), panelX + panelW / 2, currentY + 45);
        ctx.shadowBlur = 0;
        
        // Sort players by total damage (reuse sortedPlayers array)
        const sortedByTotal = lastSnap.players.slice().sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0));
        
        let rowIndex = 0;
        for (const p of sortedByTotal) {
          if (p.slot < 0) continue;
          const rowY = currentY + 55 + rowIndex * 38;
          drawPlayerDamageRow(p, rowY, p.damageDealt || 0, maxDamage, totalDamage, rowIndex === 0, panelX, panelW);
          rowIndex++;
        }
        
        currentY += totalDmgPanelH + 10;

        // ===== CURRENT WAVE DPS PANEL =====
        // Calculate wave totals
        let totalWaveDamage = 0;
        let maxWaveDamage = 1;
        for (const p of lastSnap.players) {
          if (p.slot >= 0) {
            const dmg = p.waveDamage || 0;
            totalWaveDamage += dmg;
            if (dmg > maxWaveDamage) maxWaveDamage = dmg;
          }
        }
        
        const waveDmgPanelH = 55 + playerCount * 38;
        drawSectionPanel(panelX, currentY, panelW, waveDmgPanelH, "rgba(122,224,255,0.4)", "🌊 WAVE " + wave + " DAMAGE", "#7ae0ff");
        
        // Wave damage number (centered, big)
        ctx.font = "bold 16px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#7ae0ff";
        ctx.shadowColor = "#7ae0ff";
        ctx.shadowBlur = 12;
        ctx.fillText(Math.round(totalWaveDamage).toLocaleString(), panelX + panelW / 2, currentY + 45);
        ctx.shadowBlur = 0;
        
        // Sort players by wave damage
        const sortedByWave = lastSnap.players.slice().sort((a, b) => (b.waveDamage || 0) - (a.waveDamage || 0));
        
        rowIndex = 0;
        for (const p of sortedByWave) {
          if (p.slot < 0) continue;
          const rowY = currentY + 55 + rowIndex * 38;
          drawPlayerDamageRow(p, rowY, p.waveDamage || 0, maxWaveDamage, totalWaveDamage, rowIndex === 0, panelX, panelW);
          rowIndex++;
        }
        
        ctx.textAlign = "left";
      }

// ===== BUY UPGRADE BUTTON (Always visible in playing phase) =====
      if (phase === "playing" && myPlayer) {
        const canAffordBuy = myPlayer.gold >= buyUpgradeCost;
        
        // Logic to dodge the Attack Panel
        const buyW = 140;
        const buyH = 40;
        
        // The attack panel is 220px wide + 12px margin. 
        // We check if we are in PvP (more than 1 player) to apply this offset.
        const isPvP = lastSnap && lastSnap.players && lastSnap.players.length > 1;
        const panelOffset = isPvP ? 232 : 15; // 232 = 220 (panel) + 12 (margin)
        
        // Position: Screen Width - Panel Space - Button Width - Extra Spacing
        const buyX = canvas.width - panelOffset - buyW - 10;
        const buyY = 60; // Below the score/wave HUD

        const isBuyHovered = mouseX >= buyX && mouseX <= buyX + buyW && 
                             mouseY >= buyY && mouseY <= buyY + buyH;
        
        // Store this for the click handler
        hoveredBuyUpgrade = isBuyHovered; 
        window.buyUpgradeBtnBounds = { x: buyX, y: buyY, w: buyW, h: buyH };

        // Draw Button Body
        ctx.fillStyle = isBuyHovered && canAffordBuy ? "rgba(100,255,150,0.4)" : 
                        canAffordBuy ? "rgba(60,200,120,0.25)" : "rgba(40,40,60,0.4)";
        ctx.strokeStyle = isBuyHovered && canAffordBuy ? "#7affaa" : 
                          canAffordBuy ? "rgba(122,255,170,0.5)" : "#444";
        ctx.lineWidth = isBuyHovered && canAffordBuy ? 2 : 1;
        
        ctx.beginPath();
        ctx.roundRect(buyX, buyY, buyW, buyH, 6);
        ctx.fill();
        ctx.stroke();

        // Draw Text
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        ctx.fillStyle = canAffordBuy ? "#7affaa" : "#555";
        ctx.fillText(`BUY UPGRADE (${buyUpgradeCost}g)`, buyX + buyW / 2, buyY + buyH / 2);
        
        // Reset text alignment defaults
        ctx.textAlign = "left"; 
        ctx.textBaseline = "alphabetic";
      }
      
      // ===== INVENTORY PANEL (Module Cards) =====
      // Clear inventory bounds at start
      window.invBounds = [];
      
      if (phase === "playing" && myPlayer && myPlayer.inventory && myPlayer.inventory.length > 0) {
        const MODULES = window.TOWER_MODULES || {};
        const inv = myPlayer.inventory;
        
        const invPanelW = 180;
        const invPanelH = 40 + Math.ceil(inv.length / 4) * 45;
        const invPanelX = 15;
        const invPanelY = canvas.height - invPanelH - 60;
        
        // Panel background
        ctx.fillStyle = "rgba(10,10,30,0.9)";
        ctx.strokeStyle = selectedInventoryIndex !== -1 ? "#00ff00" : "rgba(255,215,0,0.5)";
        ctx.lineWidth = selectedInventoryIndex !== -1 ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(invPanelX, invPanelY, invPanelW, invPanelH, 8);
        ctx.fill();
        ctx.stroke();
        
        // Title
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = selectedInventoryIndex !== -1 ? "#00ff00" : "#ffd700";
        ctx.fillText(selectedInventoryIndex !== -1 ? "🎯 SELECT TOWER" : "🎴 INVENTORY", invPanelX + invPanelW / 2, invPanelY + 18);
        
        // Module cards in inventory
        const cardSize = 36;
        const cardGap = 6;
        const cardsPerRow = 4;
        const startX = invPanelX + 12;
        const startY = invPanelY + 28;
        
        for (let i = 0; i < inv.length; i++) {
          const moduleId = inv[i];
          const mod = MODULES[moduleId];
          if (!mod) continue;
          
          const row = Math.floor(i / cardsPerRow);
          const col = i % cardsPerRow;
          const cardX = startX + col * (cardSize + cardGap);
          const cardY = startY + row * (cardSize + cardGap);
          
          const isHovered = mouseX >= cardX && mouseX <= cardX + cardSize && mouseY >= cardY && mouseY <= cardY + cardSize;
          const isSelected = selectedInventoryIndex === i;
          
          // Store bounds for click detection
          window.invBounds[i] = { x: cardX, y: cardY, w: cardSize, h: cardSize };
          
          // Card background - highlight if selected
          if (isSelected) {
            ctx.fillStyle = hexToRgba("#00ff00", 0.6);
            ctx.strokeStyle = "#00ff00";
            ctx.lineWidth = 3;
            ctx.shadowColor = "#00ff00";
            ctx.shadowBlur = 10;
          } else {
            ctx.fillStyle = isHovered ? hexToRgba(mod.color, 0.5) : hexToRgba(mod.color, 0.25);
            ctx.strokeStyle = mod.color;
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.shadowBlur = 0;
          }
          ctx.beginPath();
          ctx.roundRect(cardX, cardY, cardSize, cardSize, 5);
          ctx.fill();
          ctx.stroke();
          ctx.shadowBlur = 0;
          
          // Icon
          ctx.font = "20px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(mod.icon, cardX + cardSize / 2, cardY + cardSize / 2 + 6);
          
          // Store for hover tooltip (but not for click - that uses invBounds now)
          if (isHovered && !isSelected) {
            selectedInventoryModule = { index: i, moduleId };
            
            // Detailed tooltip panel
            const tooltipW = 220;
            const tooltipH = 100;
            // Position tooltip to the right of the card, or above if near bottom
            let tooltipX = cardX + cardSize + 10;
            let tooltipY = cardY - 20;
            
            // Keep tooltip on screen
            if (tooltipX + tooltipW > canvas.width - 10) {
              tooltipX = cardX - tooltipW - 10;
            }
            if (tooltipY + tooltipH > canvas.height - 10) {
              tooltipY = canvas.height - tooltipH - 10;
            }
            if (tooltipY < 10) tooltipY = 10;
            
            // Tooltip background
            ctx.fillStyle = "rgba(5,5,20,0.97)";
            ctx.strokeStyle = mod.color;
            ctx.lineWidth = 2;
            ctx.shadowColor = mod.color;
            ctx.shadowBlur = 15;
            ctx.beginPath();
            ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 8);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            
            // Module name with icon
            ctx.font = "bold 14px 'Courier New', monospace";
            ctx.fillStyle = mod.color;
            ctx.textAlign = "left";
            ctx.fillText(`${mod.icon} ${mod.name}`, tooltipX + 10, tooltipY + 22);
            
            // Horizontal divider
            ctx.strokeStyle = "rgba(255,255,255,0.2)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tooltipX + 10, tooltipY + 32);
            ctx.lineTo(tooltipX + tooltipW - 10, tooltipY + 32);
            ctx.stroke();
            
            // Description text (word-wrapped)
            ctx.font = "12px 'Courier New', monospace";
            ctx.fillStyle = "#ddd";
            const desc = mod.desc || "No description available.";
            const maxLineW = tooltipW - 20;
            const words = desc.split(" ");
            let line = "";
            let lineY = tooltipY + 50;
            const lineHeight = 16;
            for (const word of words) {
              const testLine = line + (line ? " " : "") + word;
              if (ctx.measureText(testLine).width > maxLineW) {
                ctx.fillText(line, tooltipX + 10, lineY);
                line = word;
                lineY += lineHeight;
                if (lineY > tooltipY + tooltipH - 15) break;
              } else {
                line = testLine;
              }
            }
            if (line && lineY <= tooltipY + tooltipH - 15) {
              ctx.fillText(line, tooltipX + 10, lineY);
            }
            
            // Usage hint at bottom
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.fillStyle = "#888";
            ctx.textAlign = "center";
            ctx.fillText("Click to select, then click tower", tooltipX + tooltipW / 2, tooltipY + tooltipH - 8);
          }
        }
        
        ctx.textAlign = "left";
        
        // Hint text
        ctx.font = "8px 'Courier New', monospace";
        ctx.fillStyle = selectedInventoryIndex !== -1 ? "#00ff00" : "#666";
        ctx.textAlign = "center";
        ctx.fillText(selectedInventoryIndex !== -1 ? "Right-click to cancel" : "Click module to select", invPanelX + invPanelW / 2, invPanelY + invPanelH - 6);
        ctx.textAlign = "left";
      }
      
      // ===== TOWER MODULE SLOT POPUPS (when module selected) =====
      // Store slot bounds for click detection
      window.moduleSlotPopups = [];
      
      if (phase === "playing" && selectedInventoryIndex !== -1 && myPlayer && !buildMenuOpen) {
        ctx.save();
        const { sx, sy, offsetX, offsetY } = getScale();
        const MODULES = window.TOWER_MODULES || {};
        
        // Calculate tower positions (same as buildMenuOpen logic)
        const segX0 = myPlayer.slot * world.segmentWidth;
        const cx = (segX0 + world.segmentWidth / 2) * sx + offsetX;
        const cy = 560 * sy + offsetY;
        const towerOffsets = [-110, -50, 50, 110];
        
        // Get the selected module info
        const selectedModuleId = myPlayer.inventory[selectedInventoryIndex];
        const selectedMod = MODULES[selectedModuleId];
        
        // Check all 4 tower slots
        for (let tIdx = 0; tIdx < 4; tIdx++) {
          const tower = myPlayer.towers[tIdx];
          
          if (tower && tower.modules) {
            // Check if tower has an empty slot
            const emptySlots = tower.modules.map((m, i) => m === null ? i : -1).filter(i => i !== -1);
            
            if (emptySlots.length > 0) {
              // Calculate screen position
              const towerX = cx + towerOffsets[tIdx] * sx;
              const towerY = cy - 18 * sy;
              
              // Draw mini popup above tower
              const popupW = 100;
              const popupH = 70;
              const popupX = towerX - popupW / 2;
              const popupY = towerY - popupH - 35;
              
              // Popup background
              ctx.fillStyle = "rgba(10,20,30,0.95)";
              ctx.strokeStyle = "#00ff00";
              ctx.lineWidth = 2;
              ctx.shadowColor = "#00ff00";
              ctx.shadowBlur = 10;
              ctx.beginPath();
              ctx.roundRect(popupX, popupY, popupW, popupH, 6);
              ctx.fill();
              ctx.stroke();
              ctx.shadowBlur = 0;
              
              // Tower name
              const towerType = TOWER_TYPES[tower.type];
              ctx.font = "bold 9px 'Courier New', monospace";
              ctx.textAlign = "center";
              ctx.fillStyle = towerType?.color || "#fff";
              ctx.fillText(towerType?.name || "Tower", popupX + popupW / 2, popupY + 12);
              
              // Module slots (3 slots)
              const slotSize = 26;
              const slotGap = 6;
              const totalSlotW = 3 * slotSize + 2 * slotGap;
              const slotStartX = popupX + (popupW - totalSlotW) / 2;
              const slotY = popupY + 20;
              
              for (let i = 0; i < 3; i++) {
                const slotX = slotStartX + i * (slotSize + slotGap);
                const moduleId = tower.modules[i];
                const mod = moduleId ? MODULES[moduleId] : null;
                const isEmpty = mod === null;
                
                const isSlotHovered = mouseX >= slotX && mouseX <= slotX + slotSize && mouseY >= slotY && mouseY <= slotY + slotSize;
                
                // Slot background - highlight empty slots
                if (isEmpty) {
                  const pulse = Math.sin(Date.now() / 200) * 0.2 + 0.4;
                  ctx.fillStyle = isSlotHovered ? "rgba(0,255,0,0.6)" : `rgba(0,255,0,${pulse})`;
                  ctx.strokeStyle = "#00ff00";
                  ctx.lineWidth = isSlotHovered ? 2 : 1;
                } else {
                  ctx.fillStyle = hexToRgba(mod.color, 0.3);
                  ctx.strokeStyle = mod.color;
                  ctx.lineWidth = 1;
                }
                ctx.beginPath();
                ctx.roundRect(slotX, slotY, slotSize, slotSize, 4);
                ctx.fill();
                ctx.stroke();
                
                if (mod) {
                  // Module icon
                  ctx.font = "14px sans-serif";
                  ctx.fillStyle = "#fff";
                  ctx.textAlign = "center";
                  ctx.fillText(mod.icon, slotX + slotSize / 2, slotY + slotSize / 2 + 4);
                  
                  // Tooltip for slotted module on hover
                  if (isSlotHovered) {
                    const tooltipW = 180;
                    const tooltipH = 80;
                    let tooltipX = slotX + slotSize + 10;
                    let tooltipY = slotY - 20;
                    
                    // Keep tooltip on screen
                    if (tooltipX + tooltipW > canvas.width - 10) {
                      tooltipX = slotX - tooltipW - 10;
                    }
                    if (tooltipY + tooltipH > canvas.height - 10) {
                      tooltipY = canvas.height - tooltipH - 10;
                    }
                    if (tooltipY < 10) tooltipY = 10;
                    
                    // Tooltip background
                    ctx.fillStyle = "rgba(5,5,20,0.97)";
                    ctx.strokeStyle = mod.color;
                    ctx.lineWidth = 2;
                    ctx.shadowColor = mod.color;
                    ctx.shadowBlur = 12;
                    ctx.beginPath();
                    ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 6);
                    ctx.fill();
                    ctx.stroke();
                    ctx.shadowBlur = 0;
                    
                    // Module name
                    ctx.font = "bold 12px 'Courier New', monospace";
                    ctx.fillStyle = mod.color;
                    ctx.textAlign = "left";
                    ctx.fillText(`${mod.icon} ${mod.name}`, tooltipX + 8, tooltipY + 18);
                    
                    // Description
                    ctx.font = "10px 'Courier New', monospace";
                    ctx.fillStyle = "#ddd";
                    const desc = mod.desc || "No description.";
                    const maxLineW = tooltipW - 16;
                    const words = desc.split(" ");
                    let line = "";
                    let lineY = tooltipY + 36;
                    const lineHeight = 14;
                    for (const word of words) {
                      const testLine = line + (line ? " " : "") + word;
                      if (ctx.measureText(testLine).width > maxLineW) {
                        ctx.fillText(line, tooltipX + 8, lineY);
                        line = word;
                        lineY += lineHeight;
                        if (lineY > tooltipY + tooltipH - 8) break;
                      } else {
                        line = testLine;
                      }
                    }
                    if (line && lineY <= tooltipY + tooltipH - 8) {
                      ctx.fillText(line, tooltipX + 8, lineY);
                    }
                    ctx.textAlign = "center";
                  }
                } else {
                  // Empty slot - show + or selected module preview on hover
                  if (isSlotHovered && selectedMod) {
                    ctx.font = "14px sans-serif";
                    ctx.fillStyle = "#fff";
                    ctx.textAlign = "center";
                    ctx.fillText(selectedMod.icon, slotX + slotSize / 2, slotY + slotSize / 2 + 4);
                  } else {
                    ctx.font = "14px sans-serif";
                    ctx.fillStyle = "#0f0";
                    ctx.textAlign = "center";
                    ctx.fillText("+", slotX + slotSize / 2, slotY + slotSize / 2 + 4);
                  }
                }
                
                // Store empty slot bounds for click detection
                if (isEmpty) {
                  window.moduleSlotPopups.push({
                    x: slotX, y: slotY, w: slotSize, h: slotSize,
                    towerIndex: tIdx, moduleSlot: i
                  });
                }
              }
              
              // "Click slot" hint
              ctx.font = "bold 8px 'Courier New', monospace";
              ctx.fillStyle = "#0f0";
              ctx.textAlign = "center";
              ctx.fillText("CLICK EMPTY SLOT", popupX + popupW / 2, popupY + popupH - 6);
              
              // Draw arrow pointing to tower
              ctx.fillStyle = "#00ff00";
              ctx.beginPath();
              ctx.moveTo(towerX - 6, popupY + popupH);
              ctx.lineTo(towerX + 6, popupY + popupH);
              ctx.lineTo(towerX, popupY + popupH + 10);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }
      
      // ===== STATS PANEL BUTTON & PANEL =====
      if (phase === "playing" && myPlayer) {
        const btnW = 90;
        const btnH = 32;
        const btnX = canvas.width - btnW - 15;
        const btnY = canvas.height - btnH - 15;
        
        // Check if hovering stats button
        hoveredStatsBtn = mouseX >= btnX && mouseX <= btnX + btnW && mouseY >= btnY && mouseY <= btnY + btnH;
        
        // Stats button
        ctx.fillStyle = hoveredStatsBtn ? "rgba(100,180,255,0.4)" : statsPanelOpen ? "rgba(80,150,220,0.35)" : "rgba(40,60,100,0.6)";
        ctx.strokeStyle = hoveredStatsBtn ? "#7ae0ff" : statsPanelOpen ? "#5ac8ff" : "rgba(122,224,255,0.4)";
        ctx.lineWidth = hoveredStatsBtn || statsPanelOpen ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, btnW, btnH, 6);
        ctx.fill();
        ctx.stroke();
        
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = hoveredStatsBtn || statsPanelOpen ? "#fff" : "#aaa";
        ctx.fillText("📊 STATS", btnX + btnW / 2, btnY + 21);
        
        // Stats panel (shows when open)
        if (statsPanelOpen) {
          const u = myPlayer.upgrades || {};
          const panelW = 200;
          const panelH = 400; // Taller to fit quality option
          const panelX = canvas.width - panelW - 15;
          const panelY = btnY - panelH - 10;
          
          // Panel background
          const grad = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelH);
          grad.addColorStop(0, "rgba(10,17,40,0.95)");
          grad.addColorStop(1, "rgba(15,25,50,0.95)");
          ctx.fillStyle = grad;
          ctx.strokeStyle = "rgba(122,224,255,0.5)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(panelX, panelY, panelW, panelH, 10);
          ctx.fill();
          ctx.stroke();
          
          // Title
          ctx.font = "bold 14px 'Orbitron', sans-serif";
          ctx.fillStyle = "#7ae0ff";
          ctx.textAlign = "center";
          ctx.fillText("📊 YOUR STATS", panelX + panelW / 2, panelY + 22);
          
          // Separator
          ctx.strokeStyle = "rgba(122,224,255,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(panelX + 10, panelY + 32);
          ctx.lineTo(panelX + panelW - 10, panelY + 32);
          ctx.stroke();
          
          // Stats list
          ctx.font = "11px 'Courier New', monospace";
          ctx.textAlign = "left";
          let statY = panelY + 52;
          const lineH = 20;
          
          const stats = [
            { label: "Base Damage", value: `+${(u.damageAdd || 0).toFixed(1)}`, color: "#ff6666" },
            { label: "Fire Rate", value: `${((u.fireRateMult || 1) * 100).toFixed(0)}%`, color: "#ffaa00" },
            { label: "Bullet Speed", value: `${((u.bulletSpeedMult || 1) * 100).toFixed(0)}%`, color: "#66ff66" },
            { label: "Bullet Size", value: `+${(((u.bulletSize || 1) - 1) * 100).toFixed(0)}%`, color: "#888888" },
            { label: "Crit Chance", value: `${((u.critChance || 0) * 100).toFixed(0)}%`, color: "#ff66ff" },
            { label: "Multishot", value: `${u.multishot || 1}x`, color: "#66ffff" },
            { label: "Pierce", value: `${u.pierce || 0}`, color: "#ffff66" },
            { label: "Ricochet", value: `${u.ricochet || 0}`, color: "#ff9966" },
            { label: "Chain Chance", value: `${((u.chainChance || 0) * 100).toFixed(0)}%`, color: "#9966ff" },
            { label: "Explosive", value: `${u.explosive || 0}`, color: "#ff4444" },
            { label: "Grav Power", value: `${u.slowfield || 0}`, color: "#00ffff" },
            { label: "Gold Bonus", value: `+${((u.goldBonus || 0) * 100).toFixed(0)}%`, color: "#ffd700" },
          ];
          
          stats.forEach((stat, i) => {
            // Label
            ctx.fillStyle = "#aaa";
            ctx.fillText(stat.label + ":", panelX + 15, statY + i * lineH);
            // Value
            ctx.fillStyle = stat.color;
            ctx.textAlign = "right";
            ctx.fillText(stat.value, panelX + panelW - 15, statY + i * lineH);
            ctx.textAlign = "left";
          });
          
          // Options section
          const optionsY = statY + stats.length * lineH + 10;
          
          // Separator
          ctx.strokeStyle = "rgba(122,224,255,0.3)";
          ctx.beginPath();
          ctx.moveTo(panelX + 10, optionsY);
          ctx.lineTo(panelX + panelW - 10, optionsY);
          ctx.stroke();
          
          ctx.font = "bold 11px 'Orbitron', sans-serif";
          ctx.fillStyle = "#7ae0ff";
          ctx.textAlign = "center";
          ctx.fillText("⚙️ OPTIONS", panelX + panelW / 2, optionsY + 18);
          
          // Damage numbers toggle button
          const toggleY = optionsY + 28;
          const toggleW = panelW - 30;
          const toggleH = 28;
          const toggleX = panelX + 15;
          
          const isHoveringDmgToggle = mouseX >= toggleX && mouseX <= toggleX + toggleW && 
                                       mouseY >= toggleY && mouseY <= toggleY + toggleH;
          window.dmgToggleBounds = { x: toggleX, y: toggleY, w: toggleW, h: toggleH };
          
          ctx.fillStyle = isHoveringDmgToggle ? "rgba(100,180,255,0.3)" : "rgba(40,60,100,0.4)";
          ctx.strokeStyle = isHoveringDmgToggle ? "#7ae0ff" : "rgba(122,224,255,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(toggleX, toggleY, toggleW, toggleH, 5);
          ctx.fill();
          ctx.stroke();
          
          ctx.font = "11px 'Courier New', monospace";
          ctx.textAlign = "left";
          ctx.fillStyle = "#ccc";
          ctx.fillText("Damage Numbers:", toggleX + 8, toggleY + 18);
          
          ctx.textAlign = "right";
          ctx.fillStyle = showDamageNumbers ? "#66ff66" : "#ff6666";
          ctx.fillText(showDamageNumbers ? "ON" : "OFF", toggleX + toggleW - 8, toggleY + 18);
        }
        
        ctx.textAlign = "left";
      }

      // Recent attack sent feedback
      if (recentAttackSent && Date.now() - recentAttackSent.time < 2000) {
        const age = (Date.now() - recentAttackSent.time) / 2000;
        const alpha = 1 - age;
        const atkDef = ATTACK_TYPES[recentAttackSent.type];
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(255,200,100,${alpha})`;
        const targetText = recentAttackSent.target ? ` → ${recentAttackSent.target.toUpperCase()}` : "";
        ctx.fillText(`${atkDef?.icon || "?"} ${atkDef?.name || "?"} QUEUED!${targetText}`, canvas.width / 2, canvas.height - 40);
      }

      // Incoming attack warnings - filter in place to avoid allocation
      const currentTime = Date.now();
      for (let i = incomingAttacks.length - 1; i >= 0; i--) {
        if (currentTime - incomingAttacks[i].time >= 3000) {
          incomingAttacks.splice(i, 1);
        }
      }
      for (let i = 0; i < incomingAttacks.length; i++) {
        const a = incomingAttacks[i];
        const age = (currentTime - a.time) / 3000;
        const alpha = 1 - age;
        const attackDef = ATTACK_TYPES[a.type];
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(255,100,100,${alpha})`;
        ctx.fillText(`⚠️ ${attackDef?.icon || "?"} INCOMING FROM ${a.from.toUpperCase()}!`, canvas.width / 2, 245 + i * 20);
      }

      // Build menu
      if (buildMenuOpen) {
        hoveredBuildOption = null;
        hoveredModuleSlot = null;
        const { x, y, slotIndex } = buildMenuOpen;
        // Always get fresh tower data from lastSnap (fixes module not showing after slotting)
        const freshTower = myPlayer?.towers?.[slotIndex];
        const hasTower = !!freshTower;
        const tower = freshTower;
        const myGold = myPlayer?.gold || 0;
        const myInventory = myPlayer?.inventory || [];
        const MODULES = window.TOWER_MODULES || {};

        if (hasTower && tower) {
          const typeInfo = TOWER_TYPES[tower.type];
          const level = tower.level || 1;
          const upgradeCost = typeInfo.upgradeCost * level;
          const canUpgrade = level < MAX_TOWER_LEVEL && myGold >= upgradeCost;

          let totalInvested = typeInfo.cost;
          for (let lvl = 1; lvl < level; lvl++) {
            totalInvested += typeInfo.upgradeCost * lvl;
          }
          const sellValue = Math.floor(totalInvested * 0.5);

          const menuW = 180;
          const hasModules = tower.modules && tower.modules.some(m => m !== null);
          const menuH = hasModules || myInventory.length > 0 ? 220 : 140;
          const mx = x - menuW / 2;
          const my = y - menuH - 50;

          ctx.fillStyle = "rgba(10,10,30,0.95)";
          ctx.strokeStyle = typeInfo.color;
          ctx.lineWidth = 2;
          ctx.shadowColor = typeInfo.color;
          ctx.shadowBlur = 15;
          ctx.beginPath();
          ctx.roundRect(mx, my, menuW, menuH, 10);
          ctx.fill();
          ctx.stroke();
          ctx.shadowBlur = 0;

          ctx.font = "24px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(typeInfo.icon, mx + menuW / 2, my + 28);
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.fillStyle = typeInfo.color;
          ctx.fillText(typeInfo.name.toUpperCase(), mx + menuW / 2, my + 48);
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.fillStyle = "#ffd700";
          const starText = "★".repeat(level) + "☆".repeat(MAX_TOWER_LEVEL - level);
          ctx.fillText(starText, mx + menuW / 2, my + 65);

          const upY = my + 78;
          const upH = 28;
          const isUpgradeHovered = mouseX >= mx + 10 && mouseX <= mx + menuW - 10 && mouseY >= upY && mouseY <= upY + upH;
          if (isUpgradeHovered && canUpgrade) hoveredBuildOption = "upgrade";

          if (level >= MAX_TOWER_LEVEL) {
            ctx.fillStyle = "rgba(100,100,100,0.3)";
            ctx.fillRect(mx + 10, upY, menuW - 20, upH);
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.fillStyle = "#666";
            ctx.textAlign = "center";
            ctx.fillText("MAX LEVEL", mx + menuW / 2, upY + 18);
          } else {
            ctx.fillStyle = isUpgradeHovered ? "rgba(0,255,136,0.3)" : "rgba(0,255,136,0.1)";
            if (!canUpgrade) ctx.fillStyle = "rgba(50,0,0,0.3)";
            ctx.strokeStyle = canUpgrade ? "#0f8" : "#500";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(mx + 10, upY, menuW - 20, upH, 5);
            ctx.fill();
            ctx.stroke();
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.textAlign = "left";
            ctx.fillStyle = canUpgrade ? "#0f8" : "#555";
            ctx.fillText("⬆ UPGRADE", mx + 18, upY + 18);
            ctx.textAlign = "right";
            ctx.fillStyle = canUpgrade ? "#fd0" : "#555";
            ctx.fillText(upgradeCost + " G", mx + menuW - 18, upY + 18);
          }

          const sellY = my + 110;
          const isSellHovered = mouseX >= mx + 10 && mouseX <= mx + menuW - 10 && mouseY >= sellY && mouseY <= sellY + upH;
          if (isSellHovered) hoveredBuildOption = "sell";

          ctx.fillStyle = isSellHovered ? "rgba(255,68,68,0.3)" : "rgba(255,68,68,0.1)";
          ctx.strokeStyle = "#f44";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(mx + 10, sellY, menuW - 20, upH, 5);
          ctx.fill();
          ctx.stroke();
          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.textAlign = "left";
          ctx.fillStyle = "#f44";
          ctx.fillText("✕ SELL", mx + 18, sellY + 18);
          ctx.textAlign = "right";
          ctx.fillStyle = "#0f8";
          ctx.fillText("+" + sellValue + " G", mx + menuW - 18, sellY + 18);
          
          // Module Slots (3 slots)
          if (tower.modules || myInventory.length > 0) {
            const modY = sellY + 36;
            ctx.font = "bold 9px 'Courier New', monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = "#888";
            ctx.fillText("MODULES", mx + menuW / 2, modY);
            
            const slotSize = 36;
            const slotGap = 8;
            const totalSlotW = 3 * slotSize + 2 * slotGap;
            const slotStartX = mx + (menuW - totalSlotW) / 2;
            const slotY = modY + 8;
            
            for (let i = 0; i < 3; i++) {
              const slotX = slotStartX + i * (slotSize + slotGap);
              const moduleId = tower.modules ? tower.modules[i] : null;
              const mod = moduleId ? MODULES[moduleId] : null;
              const lockWaves = tower.moduleLockWaves ? tower.moduleLockWaves[i] : 0;
              
              const isSlotHovered = mouseX >= slotX && mouseX <= slotX + slotSize && mouseY >= slotY && mouseY <= slotY + slotSize;
              
              // Slot background
              ctx.fillStyle = mod ? hexToRgba(mod.color, 0.3) : "rgba(40,40,60,0.5)";
              ctx.strokeStyle = mod ? mod.color : "#444";
              ctx.lineWidth = isSlotHovered ? 2 : 1;
              ctx.beginPath();
              ctx.roundRect(slotX, slotY, slotSize, slotSize, 5);
              ctx.fill();
              ctx.stroke();
              
              if (mod) {
                // Module icon
                ctx.font = "20px sans-serif";
                ctx.fillStyle = "#fff";
                ctx.fillText(mod.icon, slotX + slotSize / 2, slotY + slotSize / 2 + 6);
                
                // Lock indicator
                if (lockWaves > 0) {
                  ctx.font = "bold 8px 'Courier New', monospace";
                  ctx.fillStyle = "#f00";
                  ctx.fillText("🔒" + lockWaves, slotX + slotSize / 2, slotY + slotSize - 2);
                }
                
                // Tooltip for slotted module on hover
                if (isSlotHovered) {
                  const tooltipW = 200;
                  const tooltipH = 90;
                  let tooltipX = slotX + slotSize + 10;
                  let tooltipY = slotY - 20;
                  
                  // Keep tooltip on screen
                  if (tooltipX + tooltipW > canvas.width - 10) {
                    tooltipX = slotX - tooltipW - 10;
                  }
                  if (tooltipY + tooltipH > canvas.height - 10) {
                    tooltipY = canvas.height - tooltipH - 10;
                  }
                  if (tooltipY < 10) tooltipY = 10;
                  
                  // Tooltip background
                  ctx.fillStyle = "rgba(5,5,20,0.97)";
                  ctx.strokeStyle = mod.color;
                  ctx.lineWidth = 2;
                  ctx.shadowColor = mod.color;
                  ctx.shadowBlur = 15;
                  ctx.beginPath();
                  ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 8);
                  ctx.fill();
                  ctx.stroke();
                  ctx.shadowBlur = 0;
                  
                  // Module name with icon
                  ctx.font = "bold 14px 'Courier New', monospace";
                  ctx.fillStyle = mod.color;
                  ctx.textAlign = "left";
                  ctx.fillText(`${mod.icon} ${mod.name}`, tooltipX + 10, tooltipY + 22);
                  
                  // Description text (word-wrapped)
                  ctx.font = "12px 'Courier New', monospace";
                  ctx.fillStyle = "#ddd";
                  const desc = mod.desc || "No description.";
                  const maxLineW = tooltipW - 20;
                  const words = desc.split(" ");
                  let line = "";
                  let lineY = tooltipY + 45;
                  const lineHeight = 16;
                  for (const word of words) {
                    const testLine = line + (line ? " " : "") + word;
                    if (ctx.measureText(testLine).width > maxLineW) {
                      ctx.fillText(line, tooltipX + 10, lineY);
                      line = word;
                      lineY += lineHeight;
                      if (lineY > tooltipY + tooltipH - 10) break;
                    } else {
                      line = testLine;
                    }
                  }
                  if (line && lineY <= tooltipY + tooltipH - 10) {
                    ctx.fillText(line, tooltipX + 10, lineY);
                  }
                  ctx.textAlign = "center";
                }
              } else {
                // Empty slot
                ctx.font = "16px sans-serif";
                ctx.fillStyle = "#444";
                ctx.fillText("+", slotX + slotSize / 2, slotY + slotSize / 2 + 5);
              }
              
              // Store slot info for click handling
              if (isSlotHovered) {
                hoveredModuleSlot = { towerIndex: buildMenuOpen.slotIndex, slotIndex: i, hasModule: !!mod, locked: lockWaves > 0 };
              }
            }
            
            // Inventory hint
            if (myInventory.length > 0 && !tower.modules?.every(m => m !== null)) {
              ctx.font = "8px 'Courier New', monospace";
              ctx.fillStyle = "#666";
              ctx.fillText(`${myInventory.length} card(s) in inventory`, mx + menuW / 2, slotY + slotSize + 14);
            }
          }
        } else {
          const menuW = 200;
          const menuH = 160;
          const mx = x - menuW / 2;
          const my = y - menuH - 30;

          ctx.fillStyle = "rgba(10,10,30,0.95)";
          ctx.strokeStyle = "#0f8";
          ctx.lineWidth = 2;
          ctx.shadowColor = "#0f8";
          ctx.shadowBlur = 15;
          ctx.beginPath();
          ctx.roundRect(mx, my, menuW, menuH, 10);
          ctx.fill();
          ctx.stroke();
          ctx.shadowBlur = 0;

          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.fillStyle = "#0f8";
          ctx.textAlign = "center";
          ctx.fillText("⚙ BUILD TOWER", mx + menuW / 2, my + 22);
          ctx.strokeStyle = "rgba(0,255,136,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx + 15, my + 32);
          ctx.lineTo(mx + menuW - 15, my + 32);
          ctx.stroke();

          const opts = [
            { id: 0, icon: "⚡", label: "GATLING", desc: "Fast Fire", cost: 50, col: "#ffff00" },
            { id: 1, icon: "🎯", label: "SNIPER", desc: "High Damage", cost: 120, col: "#00ff00" },
            { id: 2, icon: "🚀", label: "MISSILE", desc: "Splash", cost: 250, col: "#ff4444" }
          ];

          for (let i = 0; i < opts.length; i++) {
            const o = opts[i];
            const by = my + 40 + i * 40;
            const bx = mx + 10;
            const bw = menuW - 20;
            const bh = 36;

            const isHovered = mouseX >= bx && mouseX <= bx + bw && mouseY >= by && mouseY <= by + bh;
            if (isHovered) hoveredBuildOption = o.id;
            const canAfford = myGold >= o.cost;

            ctx.fillStyle = isHovered ? hexToRgba(o.col, 0.25) : "rgba(0,0,0,0.4)";
            if (!canAfford) ctx.fillStyle = "rgba(30,0,0,0.4)";
            ctx.strokeStyle = isHovered ? o.col : hexToRgba(o.col, 0.4);
            if (!canAfford) ctx.strokeStyle = "#400";
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, bw, bh, 6);
            ctx.fill();
            ctx.stroke();

            ctx.font = "18px sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(o.icon, bx + 8, by + 24);
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? o.col : "#555";
            ctx.fillText(o.label, bx + 35, by + 16);
            ctx.font = "9px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? "rgba(255,255,255,0.6)" : "#444";
            ctx.fillText(o.desc, bx + 35, by + 28);
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.textAlign = "right";
            ctx.fillStyle = canAfford ? "#fd0" : "#555";
            ctx.fillText(o.cost + " G", bx + bw - 8, by + 22);
          }
        }
        ctx.textAlign = "left";
      }

      // Upgrade cards at top of screen (during gameplay)
      if (phase === "playing" && upgradeOptions.length > 0 && !upgradePicked) {
        // No blocking background - just floating cards with nice borders
        
        // Wave indicator and queue
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 4;
        const queueText = upgradeQueueSize > 1 ? ` (+${upgradeQueueSize - 1} pending)` : "";
        ctx.fillText(`WAVE ${upgradeWaveNum} UPGRADE${queueText}`, canvas.width / 2, 68);
        ctx.shadowBlur = 0;
        
        // Cards - compact horizontal design at top
        const cardW = 140;
        const cardH = 150;
        const gap = 15;
        const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * gap;
        const startX = canvas.width / 2 - totalW / 2;
        const cardY = 78;
        
        hoveredUpgrade = -1;
        
        for (let i = 0; i < upgradeOptions.length; i++) {
          const opt = upgradeOptions[i];
          const cardX = startX + i * (cardW + gap);
          const isHovered = mouseX >= cardX && mouseX <= cardX + cardW && mouseY >= cardY && mouseY <= cardY + cardH;
          if (isHovered) hoveredUpgrade = i;
          
          const rarityColor = opt.rarityColor || "#fff";
          
          // Card background - solid with glow border
          ctx.save();
          
          // Outer glow
          ctx.shadowColor = rarityColor;
          ctx.shadowBlur = isHovered ? 25 : 15;
          
          // Main card body - more opaque
          const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
          cardGrad.addColorStop(0, isHovered ? "rgba(60,60,80,0.98)" : "rgba(20,20,35,0.97)");
          cardGrad.addColorStop(1, isHovered ? "rgba(45,45,65,0.98)" : "rgba(15,15,28,0.97)");
          ctx.fillStyle = cardGrad;
          
          ctx.beginPath();
          ctx.roundRect(cardX, cardY, cardW, cardH, 8);
          ctx.fill();
          
          // Strong border with rarity color
          ctx.strokeStyle = rarityColor;
          ctx.lineWidth = isHovered ? 3 : 2;
          ctx.stroke();
          ctx.restore();
          
          // Rarity indicator bar at top
          ctx.fillStyle = rarityColor;
          ctx.beginPath();
          ctx.roundRect(cardX + 8, cardY + 6, cardW - 16, 2, 1);
          ctx.fill();
          
          // Rarity label
          ctx.font = "bold 8px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = hexToRgba(rarityColor, 0.8);
          ctx.fillText(opt.rarityLabel, cardX + cardW / 2, cardY + 20);
          
          // Icon
          ctx.font = "32px sans-serif";
          ctx.fillStyle = "#fff";
          ctx.fillText(opt.icon, cardX + cardW / 2, cardY + 58);
          
          // Title
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.fillStyle = "#fff";
          ctx.fillText(opt.title, cardX + cardW / 2, cardY + 82);
          
          // Description - compact
          ctx.font = "9px 'Courier New', monospace";
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          const desc = opt.desc;
          if (desc.length > 20) {
            const mid = desc.lastIndexOf(' ', 20);
            if (mid > 0) {
              ctx.fillText(desc.substring(0, mid), cardX + cardW / 2, cardY + 102);
              ctx.fillText(desc.substring(mid + 1), cardX + cardW / 2, cardY + 114);
            } else {
              ctx.fillText(desc.slice(0, 20), cardX + cardW / 2, cardY + 108);
            }
          } else {
            ctx.fillText(desc, cardX + cardW / 2, cardY + 108);
          }
          
          // Hover hint
          if (isHovered) {
            if (banishMode) {
              ctx.fillStyle = "#f44";
              ctx.font = "bold 9px 'Courier New', monospace";
              ctx.fillText("🚫 BANISH", cardX + cardW / 2, cardY + cardH - 12);
            } else {
              ctx.fillStyle = hexToRgba(rarityColor, 0.9);
              ctx.font = "bold 9px 'Courier New', monospace";
              ctx.fillText("CLICK", cardX + cardW / 2, cardY + cardH - 12);
            }
          }
          
          // Banish mode overlay - red tint on cards
          if (banishMode) {
            ctx.fillStyle = "rgba(255,50,50,0.15)";
            ctx.beginPath();
            ctx.roundRect(cardX, cardY, cardW, cardH, 8);
            ctx.fill();
          }
        }
        
        // Reroll button to the right of cards
        const myPlayer = lastSnap?.players.find(p => p.id === myId);
        const myGold = myPlayer?.gold || 0;
        const canAffordReroll = myGold >= currentRerollCost;
        
        const rerollBtnW = 70;
        const rerollBtnH = 50;
        const rerollBtnX = startX + totalW + 20;
        const rerollBtnY = cardY + cardH / 2 - rerollBtnH / 2;
        
        const isRerollHovered = mouseX >= rerollBtnX && mouseX <= rerollBtnX + rerollBtnW && 
                                mouseY >= rerollBtnY && mouseY <= rerollBtnY + rerollBtnH;
        hoveredReroll = isRerollHovered;
        
        // Reroll button background
        ctx.fillStyle = isRerollHovered && canAffordReroll ? "rgba(100,180,255,0.4)" : 
                        canAffordReroll ? "rgba(60,120,200,0.25)" : "rgba(40,40,60,0.4)";
        ctx.strokeStyle = isRerollHovered && canAffordReroll ? "#7ae0ff" : 
                          canAffordReroll ? "rgba(122,224,255,0.5)" : "#444";
        ctx.lineWidth = isRerollHovered && canAffordReroll ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(rerollBtnX, rerollBtnY, rerollBtnW, rerollBtnH, 6);
        ctx.fill();
        ctx.stroke();
        
        // Reroll button text
        ctx.font = "18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = canAffordReroll ? "#7ae0ff" : "#555";
        ctx.fillText("🎲", rerollBtnX + rerollBtnW / 2, rerollBtnY + 25);
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.fillText(`${currentRerollCost}g`, rerollBtnX + rerollBtnW / 2, rerollBtnY + 42);
        
        // Banish button (next to reroll) - ONLY SHOWS IF NOT YET USED
        if (banishedCount < 1) {
          const banishBtnW = 70;
          const banishBtnH = 50;
          const banishBtnX = rerollBtnX + rerollBtnW + 8;
          const banishBtnY = rerollBtnY;
          
          const isBanishHovered = mouseX >= banishBtnX && mouseX <= banishBtnX + banishBtnW && 
                                  mouseY >= banishBtnY && mouseY <= banishBtnY + banishBtnH;
          hoveredBanish = isBanishHovered;
          
          // Banish button background - red/orange theme
          ctx.fillStyle = banishMode ? "rgba(200,80,80,0.5)" :
                          (isBanishHovered ? "rgba(180,100,60,0.4)" : "rgba(100,50,40,0.25)");
          ctx.strokeStyle = banishMode ? "#f44" :
                            (isBanishHovered ? "#f84" : "rgba(200,100,80,0.5)");
          ctx.lineWidth = banishMode || isBanishHovered ? 2 : 1;
          ctx.beginPath();
          ctx.roundRect(banishBtnX, banishBtnY, banishBtnW, banishBtnH, 6);
          ctx.fill();
          ctx.stroke();
          
          // Banish button text
          ctx.font = "18px sans-serif";
          ctx.fillStyle = banishMode ? "#f44" : (isBanishHovered ? "#f84" : "#a64");
          ctx.fillText("🚫", banishBtnX + banishBtnW / 2, banishBtnY + 25);
          ctx.font = "bold 9px 'Courier New', monospace";
          ctx.fillStyle = banishMode ? "#f88" : (isBanishHovered ? "#fa8" : "#864");
          ctx.fillText(banishMode ? "CANCEL" : "BANISH", banishBtnX + banishBtnW / 2, banishBtnY + 42);
        } else {
          hoveredBanish = false;
        }
        
        ctx.textAlign = "left";
        
        // Banish mode indicator on cards
        if (banishMode) {
          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#f44";
          ctx.fillText("🚫 CLICK A CARD TO BANISH IT FOREVER (1 per game) 🚫", canvas.width / 2, cardY - 8);
          ctx.textAlign = "left";
        }
      }

      // MODULE CARD SELECTION (after boss waves) - Left panel
      if (phase === "playing" && moduleCardPhase && moduleCards.length > 0) {
        const MODULES = window.TOWER_MODULES || {};
        const isMyTurn = currentModulePicker === myId;
        
        // Left panel dimensions
        const panelW = 220;
        const panelX = 15;
        const panelY = 80;
        const panelH = Math.min(canvas.height - 160, 60 + moduleCards.length * 95 + 50);
        
        // Panel background
        ctx.fillStyle = "rgba(10,10,30,0.95)";
        ctx.strokeStyle = isMyTurn ? "#ffd700" : "#666";
        ctx.lineWidth = isMyTurn ? 3 : 2;
        ctx.shadowColor = isMyTurn ? "#ffd700" : "#444";
        ctx.shadowBlur = isMyTurn ? 20 : 10;
        ctx.beginPath();
        ctx.roundRect(panelX, panelY, panelW, panelH, 12);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
        
        // Title
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffd700";
        ctx.fillText("🏆 BOSS REWARD", panelX + panelW / 2, panelY + 25);
        
        // Current picker info
        ctx.font = "bold 11px 'Courier New', monospace";
        if (isMyTurn) {
          ctx.fillStyle = "#0f0";
          ctx.fillText(`YOUR TURN! (${Math.ceil(modulePickTimeLeft)}s)`, panelX + panelW / 2, panelY + 45);
        } else {
          const picker = modulePickOrder.find(p => p.id === currentModulePicker);
          const pickerName = picker?.name || "...";
          const pickPos = picker?.pickPosition ? ` (#${picker.pickPosition})` : "";
          ctx.fillStyle = "#aaa";
          ctx.fillText(`${pickerName}${pickPos}'s turn`, panelX + panelW / 2, panelY + 45);
          ctx.font = "10px 'Courier New', monospace";
          ctx.fillText(`(${Math.ceil(modulePickTimeLeft)}s)`, panelX + panelW / 2, panelY + 58);
        }
        
        // Module Cards - vertical list
        const modCardW = panelW - 20;
        const modCardH = 80;
        const modGap = 10;
        const modStartY = panelY + 65;
        
        hoveredModuleCard = -1;
        
        for (let i = 0; i < moduleCards.length; i++) {
          const card = moduleCards[i];
          const mod = MODULES[card.id] || card;
          const cardX = panelX + 10;
          const cardY = modStartY + i * (modCardH + modGap);
          
          // Skip if card would be off screen
          if (cardY + modCardH > panelY + panelH - 10) continue;
          
          const isHovered = isMyTurn && mouseX >= cardX && mouseX <= cardX + modCardW && mouseY >= cardY && mouseY <= cardY + modCardH;
          if (isHovered) hoveredModuleCard = i;
          
          // Card background
          ctx.save();
          ctx.shadowColor = mod.color || "#fff";
          ctx.shadowBlur = isHovered ? 15 : 8;
          
          ctx.fillStyle = isHovered ? hexToRgba(mod.color, 0.3) : "rgba(20,20,40,0.9)";
          ctx.strokeStyle = mod.color || "#fff";
          ctx.lineWidth = isHovered ? 2 : 1;
          
          ctx.beginPath();
          ctx.roundRect(cardX, cardY, modCardW, modCardH, 8);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          
          // Icon (left side)
          ctx.font = "32px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(mod.icon || "?", cardX + 30, cardY + 50);
          
          // Name (right of icon)
          ctx.font = "bold 11px 'Courier New', monospace";
          ctx.textAlign = "left";
          ctx.fillStyle = mod.color || "#fff";
          ctx.fillText(mod.name || card.id, cardX + 60, cardY + 22);
          
          // Description (wrapped, smaller)
          ctx.font = "9px 'Courier New', monospace";
          ctx.fillStyle = "#aaa";
          const desc = mod.desc || "";
          const maxLineW = modCardW - 70;
          const words = desc.split(" ");
          let line = "";
          let lineY = cardY + 38;
          for (const word of words) {
            const testLine = line + (line ? " " : "") + word;
            if (ctx.measureText(testLine).width > maxLineW) {
              ctx.fillText(line, cardX + 60, lineY);
              line = word;
              lineY += 12;
              if (lineY > cardY + modCardH - 10) break;
            } else {
              line = testLine;
            }
          }
          if (line && lineY <= cardY + modCardH - 10) ctx.fillText(line, cardX + 60, lineY);
          
          // Click hint
          if (isHovered) {
            ctx.font = "bold 9px 'Courier New', monospace";
            ctx.fillStyle = "#0f0";
            ctx.textAlign = "right";
            ctx.fillText("CLICK ►", cardX + modCardW - 8, cardY + modCardH - 8);
          }
        }
        
        // Cards remaining indicator
        ctx.font = "9px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#666";
        ctx.fillText(`${moduleCards.length} card${moduleCards.length !== 1 ? 's' : ''} remaining`, panelX + panelW / 2, panelY + panelH - 12);
        
        ctx.textAlign = "left";
      }

      // Pause overlay (when game is paused)
      if (phase === "playing" && (gamePaused || pauseCountdown > 0)) {
        // Semi-transparent overlay
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Pause message
        ctx.textAlign = "center";
        
        if (pauseCountdown > 0) {
          // Countdown to resume
          ctx.font = "bold 72px 'Courier New', monospace";
          ctx.fillStyle = "#ff6600";
          ctx.shadowColor = "#ff6600";
          ctx.shadowBlur = 20;
          ctx.fillText(Math.ceil(pauseCountdown), canvas.width / 2, canvas.height / 2 - 20);
          ctx.shadowBlur = 0;
          
          ctx.font = "bold 24px 'Courier New', monospace";
          ctx.fillStyle = "#fff";
          ctx.fillText("RESUMING...", canvas.width / 2, canvas.height / 2 + 40);
        } else {
          // Paused state
          ctx.font = "bold 48px 'Courier New', monospace";
          ctx.fillStyle = "#0088ff";
          ctx.shadowColor = "#0088ff";
          ctx.shadowBlur = 20;
          ctx.fillText("⏸ PAUSED", canvas.width / 2, canvas.height / 2 - 20);
          ctx.shadowBlur = 0;
          
          ctx.font = "16px 'Courier New', monospace";
          ctx.fillStyle = "#aaa";
          ctx.fillText(`Paused by ${pausedBy || 'a player'}`, canvas.width / 2, canvas.height / 2 + 25);
          
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.fillStyle = "#ff6600";
          ctx.fillText("Click RESUME or press SPACE to continue", canvas.width / 2, canvas.height / 2 + 55);
        }
        
        ctx.textAlign = "left";
      }

      // Attack hit feedback (show below cards if cards are visible)
      const feedbackBaseY = (phase === "playing" && upgradeOptions.length > 0 && !upgradePicked) ? 250 : 60;
      if (attackHitFeedback && Date.now() - attackHitFeedback.time < 2000) {
        const fadeAlpha = 1 - (Date.now() - attackHitFeedback.time) / 2000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#0f0";
        ctx.fillText(`+${attackHitFeedback.gold}g HIT ${attackHitFeedback.target}!`, canvas.width / 2, feedbackBaseY);
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Interest feedback
      if (interestFeedback && Date.now() - interestFeedback.time < 2000) {
        const fadeAlpha = 1 - (Date.now() - interestFeedback.time) / 2000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffd700";
        ctx.fillText(`+${interestFeedback.amount}g INTEREST (10%)`, canvas.width / 2, feedbackBaseY + 20);
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Refund feedback
      if (refundFeedback && Date.now() - refundFeedback.time < 2500) {
        const fadeAlpha = 1 - (Date.now() - refundFeedback.time) / 2500;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#0ff";
        ctx.fillText(`+${refundFeedback.gold}g REFUND - ${refundFeedback.reason}`, canvas.width / 2, feedbackBaseY + 40);
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Boss killer feedback
      if (bossKillerFeedback && Date.now() - bossKillerFeedback.time < 3000) {
        const fadeAlpha = 1 - (Date.now() - bossKillerFeedback.time) / 3000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 20px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = bossKillerFeedback.isMe ? "#ffd700" : "#ff4444";
        ctx.shadowBlur = 20;
        ctx.fillStyle = bossKillerFeedback.isMe ? "#ffd700" : "#ff8888";
        const posText = bossKillerFeedback.position === 1 ? "1st" : bossKillerFeedback.position === 2 ? "2nd" : bossKillerFeedback.position === 3 ? "3rd" : `${bossKillerFeedback.position}th`;
        const text = bossKillerFeedback.isMe ? `🏆 YOU KILLED THE BOSS ${posText}! 🏆` : `💀 ${bossKillerFeedback.name} KILLED BOSS (${posText})`;
        ctx.fillText(text, canvas.width / 2, 50);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Module acquired feedback  
      if (moduleFeedback && Date.now() - moduleFeedback.time < 2500) {
        const MODULES = window.TOWER_MODULES || {};
        const mod = MODULES[moduleFeedback.moduleId];
        if (mod) {
          const fadeAlpha = 1 - (Date.now() - moduleFeedback.time) / 2500;
          ctx.save();
          ctx.globalAlpha = fadeAlpha;
          ctx.font = "bold 18px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.shadowColor = mod.color;
          ctx.shadowBlur = 15;
          ctx.fillStyle = mod.color;
          ctx.fillText(`${mod.icon} GOT: ${mod.name.toUpperCase()} ${mod.icon}`, canvas.width / 2, feedbackBaseY + 60);
          ctx.shadowBlur = 0;
          ctx.restore();
          ctx.textAlign = "left";
        }
      }

      // Banish feedback
      if (banishFeedback && Date.now() - banishFeedback.time < 2500) {
        const fadeAlpha = 1 - (Date.now() - banishFeedback.time) / 2500;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f84";
        ctx.shadowColor = "#f44";
        ctx.shadowBlur = 12;
        ctx.fillText(`🚫 BANISHED: ${banishFeedback.name.toUpperCase()} FOREVER! 🚫`, canvas.width / 2, feedbackBaseY + 80);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Banish error feedback
      if (banishError && Date.now() - banishError.time < 2000) {
        const fadeAlpha = 1 - (Date.now() - banishError.time) / 2000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f44";
        ctx.fillText(`⚠️ ${banishError.reason}`, canvas.width / 2, feedbackBaseY + 100);
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Spite earned feedback (for dead players)
      if (spiteFeedback && Date.now() - spiteFeedback.time < 2000) {
        const fadeAlpha = 1 - (Date.now() - spiteFeedback.time) / 2000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f44";
        ctx.shadowColor = "#f44";
        ctx.shadowBlur = 10;
        ctx.fillText(`+1 💢 SPITE (${spiteFeedback.spite} total)`, canvas.width / 2, feedbackBaseY);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Death mod used feedback
      if (deathModFeedback && Date.now() - deathModFeedback.time < 3000) {
        const fadeAlpha = 1 - (Date.now() - deathModFeedback.time) / 3000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 22px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f44";
        ctx.shadowColor = "#f00";
        ctx.shadowBlur = 20;
        ctx.fillText(`${deathModFeedback.modIcon} ${deathModFeedback.playerName} used ${deathModFeedback.modName}!`, canvas.width / 2, 80);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Gold stolen feedback
      if (goldStolenFeedback && Date.now() - goldStolenFeedback.time < 2500) {
        const fadeAlpha = 1 - (Date.now() - goldStolenFeedback.time) / 2500;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 18px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f88";
        ctx.shadowColor = "#f44";
        ctx.shadowBlur = 10;
        ctx.fillText(`💸 -${goldStolenFeedback.amount}g STOLEN by ${goldStolenFeedback.by}!`, canvas.width / 2, feedbackBaseY + 80);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Spite damage feedback
      if (spiteDamageFeedback && Date.now() - spiteDamageFeedback.time < 2500) {
        const fadeAlpha = 1 - (Date.now() - spiteDamageFeedback.time) / 2500;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 18px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#f44";
        ctx.shadowColor = "#f00";
        ctx.shadowBlur = 15;
        ctx.fillText(`💔 -${spiteDamageFeedback.amount} HP from ${spiteDamageFeedback.by}!`, canvas.width / 2, feedbackBaseY + 100);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Speed Demon active indicator
      if (activeSpeedDemon) {
        const remaining = Math.max(0, Math.ceil((activeSpeedDemon.endTime - Date.now()) / 1000));
        if (remaining > 0) {
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#ff8800";
          ctx.shadowColor = "#ff4400";
          ctx.shadowBlur = 10;
          ctx.fillText(`💨 SPEED DEMON ACTIVE: ${remaining}s 💨`, canvas.width / 2, 110);
          ctx.shadowBlur = 0;
          ctx.textAlign = "left";
        } else {
          activeSpeedDemon = null;
        }
      }

      // Module error feedback
      if (moduleErrorFeedback && Date.now() - moduleErrorFeedback.time < 2000) {
        const fadeAlpha = 1 - (Date.now() - moduleErrorFeedback.time) / 2000;
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ff4444";
        ctx.fillText(`⚠ ${moduleErrorFeedback.error}`, canvas.width / 2, feedbackBaseY + 80);
        ctx.restore();
        ctx.textAlign = "left";
      }

      // Game over
      if (phase === "gameover" && gameOverData) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        if (gameOverData.solo) {
          // Solo mode game over
          const player = gameOverData.scores[0];
          drawNeonText("GAME OVER", canvas.width / 2, 80, "#f44", 36, "center");
          drawNeonText(`Wave ${gameOverData.wave}`, canvas.width / 2, 130, "#0ff", 24, "center");
          
          ctx.font = "bold 18px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          // Replace Score with Damage
          ctx.fillText(`Damage: ${Math.round(player?.damage || 0)}`, canvas.width / 2, 180);
          ctx.fillText(`Kills: ${player?.kills || 0}`, canvas.width / 2, 210);
        } else {
          // PvP mode game over
          const winner = gameOverData.scores.find(s => s.isWinner);
          if (winner) {
            const winnerColor = PLAYER_COLORS[winner.slot]?.main || "#fff";
            drawNeonText("🏆 WINNER 🏆", canvas.width / 2, 80, "#ffd700", 28, "center");
            drawNeonText(winner.name.toUpperCase(), canvas.width / 2, 120, winnerColor, 36, "center");
          } else {
            drawNeonText("GAME OVER", canvas.width / 2, 100, "#f44", 36, "center");
          }

          drawNeonText(`Wave ${gameOverData.wave}`, canvas.width / 2, 160, "#0ff", 18, "center");
          
          // Final standings
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.textAlign = "center";
          gameOverData.scores.forEach((s, i) => {
            const color = PLAYER_COLORS[s.slot]?.main || "#fff";
            const y = 200 + i * 30;
            ctx.fillStyle = s.isWinner ? "#ffd700" : color;
            // Display Damage instead of pts
            ctx.fillText(`${i + 1}. ${s.name} - ${Math.round(s.damage)} dmg (${s.kills} kills)`, canvas.width / 2, y);
          });
        }

        // Return to Menu button
        const btnW = 200;
        const btnH = 50;
        const btnX = canvas.width / 2 - btnW / 2;
        const btnY = canvas.height - 120;
        const isHovered = mouseX >= btnX && mouseX <= btnX + btnW && mouseY >= btnY && mouseY <= btnY + btnH;
        
        ctx.fillStyle = isHovered ? "rgba(0,255,136,0.3)" : "rgba(0,255,136,0.1)";
        ctx.strokeStyle = isHovered ? "#0f8" : "rgba(0,255,136,0.5)";
        ctx.lineWidth = isHovered ? 3 : 2;
        ctx.shadowColor = isHovered ? "#0f8" : "transparent";
        ctx.shadowBlur = isHovered ? 15 : 0;
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, btnW, btnH, 8);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
        
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = isHovered ? "#fff" : "#0f8";
        ctx.fillText("RETURN TO MENU", canvas.width / 2, btnY + btnH / 2);
        
        // Store button bounds for click handling
        gameOverData.menuBtnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
      }

      // ===== In-Game Chat UI =====
      if (phase === "playing" || phase === "upgrades") {
        const chatBtnSize = 40;
        const chatBtnX = 15;
        const chatBtnY = canvas.height - chatBtnSize - 15;
        
        // Draw chat toggle button
        ctx.fillStyle = chatOpen ? "rgba(0,255,255,0.3)" : "rgba(30,30,50,0.8)";
        ctx.strokeStyle = chatUnread > 0 && !chatOpen ? "#ff0" : "#0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(chatBtnX, chatBtnY, chatBtnSize, chatBtnSize, 8);
        ctx.fill();
        ctx.stroke();
        
        // Chat icon
        ctx.fillStyle = chatUnread > 0 && !chatOpen ? "#ff0" : "#fff";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("💬", chatBtnX + chatBtnSize/2, chatBtnY + chatBtnSize/2);
        
        // Unread badge
        if (chatUnread > 0 && !chatOpen) {
          ctx.fillStyle = "#f44";
          ctx.beginPath();
          ctx.arc(chatBtnX + chatBtnSize - 5, chatBtnY + 8, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.font = "bold 11px Arial";
          ctx.fillText(chatUnread > 9 ? "9+" : chatUnread, chatBtnX + chatBtnSize - 5, chatBtnY + 9);
          
          // Pulse animation for unread
          const pulse = Math.sin(time * 5) * 0.3 + 0.7;
          ctx.strokeStyle = `rgba(255,255,0,${pulse})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(chatBtnX - 2, chatBtnY - 2, chatBtnSize + 4, chatBtnSize + 4, 10);
          ctx.stroke();
        }
        
        // Store chat button bounds
        window.gameChatBtnBounds = { x: chatBtnX, y: chatBtnY, w: chatBtnSize, h: chatBtnSize };
        
        // Draw chat popup if open
        if (chatOpen) {
          const chatW = 340;
          const chatH = 320;
          const chatX = 15;
          const chatY = canvas.height - chatH - chatBtnSize - 25;
          
          // Chat window background
          ctx.fillStyle = "rgba(10,10,30,0.95)";
          ctx.strokeStyle = "#0ff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(chatX, chatY, chatW, chatH, 10);
          ctx.fill();
          ctx.stroke();
          
          // Chat header
          ctx.fillStyle = "rgba(0,255,255,0.15)";
          ctx.beginPath();
          ctx.roundRect(chatX, chatY, chatW, 30, [10, 10, 0, 0]);
          ctx.fill();
          
          ctx.fillStyle = "#0ff";
          ctx.font = "bold 12px Orbitron, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText("💬 CHAT", chatX + 12, chatY + 15);
          
          // Close button
          ctx.fillStyle = "#f44";
          ctx.font = "bold 16px Arial";
          ctx.textAlign = "center";
          ctx.fillText("✕", chatX + chatW - 18, chatY + 15);
          window.gameChatCloseBounds = { x: chatX + chatW - 30, y: chatY, w: 30, h: 30 };
          
          // Messages area
          const msgAreaY = chatY + 35;
          const msgAreaH = chatH - 75;
          ctx.save();
          ctx.beginPath();
          ctx.rect(chatX + 5, msgAreaY, chatW - 10, msgAreaH);
          ctx.clip();
          
          ctx.font = "13px Rajdhani, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          
          const lineHeight = 18;
          const maxLines = Math.floor(msgAreaH / lineHeight);
          const recentMessages = chatMessages.slice(-maxLines);
          
          for (let i = 0; i < recentMessages.length; i++) {
            const msg = recentMessages[i];
            const y = msgAreaY + i * lineHeight + 5;
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            ctx.fillStyle = "#666";
            ctx.fillText(time, chatX + 8, y);
            
            ctx.fillStyle = "#0ff";
            const nameText = msg.from + ":";
            ctx.fillText(nameText, chatX + 48, y);
            
            ctx.fillStyle = "#fff";
            const nameWidth = ctx.measureText(nameText).width;
            ctx.fillText(msg.text.slice(0, 30), chatX + 52 + nameWidth, y);
          }
          ctx.restore();
          
          // Input area hint
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.beginPath();
          ctx.roundRect(chatX + 5, chatY + chatH - 35, chatW - 10, 28, 5);
          ctx.fill();
          ctx.strokeStyle = "#444";
          ctx.lineWidth = 1;
          ctx.stroke();
          
          ctx.fillStyle = "#888";
          ctx.font = "12px Rajdhani, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(gameChatInputText || "Press T to type...", chatX + 12, chatY + chatH - 21);
          
          window.gameChatInputBounds = { x: chatX + 5, y: chatY + chatH - 35, w: chatW - 10, h: 28 };
          window.gameChatBounds = { x: chatX, y: chatY, w: chatW, h: chatH };
        }
      }

      // ===== MUSIC PERMISSION POPUP (only show during gameplay) =====
      if (showMusicPermissionPrompt && musicState.trackName && phase === "playing") {
        const popW = 300;
        const popH = 120;
        const popX = (canvas.width - popW) / 2;
        const popY = (canvas.height - popH) / 2;
        
        // Darken background
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Popup background
        ctx.fillStyle = "rgba(20,25,40,0.98)";
        ctx.strokeStyle = "#7ae0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(popX, popY, popW, popH, 12);
        ctx.fill();
        ctx.stroke();
        
        // Title
        ctx.font = "bold 16px 'Courier New', monospace";
        ctx.fillStyle = "#7ae0ff";
        ctx.textAlign = "center";
        ctx.fillText("🎵 Enable Music?", popX + popW / 2, popY + 30);
        
        // Description
        ctx.font = "12px 'Courier New', monospace";
        ctx.fillStyle = "#aaa";
        ctx.fillText("Click to enable synchronized music", popX + popW / 2, popY + 55);
        
        // Button
        const btnW = 120;
        const btnH = 32;
        const btnX = popX + (popW - btnW) / 2;
        const btnY = popY + popH - btnH - 15;
        
        const btnHover = mouseX >= btnX && mouseX <= btnX + btnW && 
                         mouseY >= btnY && mouseY <= btnY + btnH;
        
        ctx.fillStyle = btnHover ? "rgba(122,224,255,0.4)" : "rgba(60,100,140,0.6)";
        ctx.strokeStyle = btnHover ? "#7ae0ff" : "#557";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, btnW, btnH, 6);
        ctx.fill();
        ctx.stroke();
        
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.fillStyle = btnHover ? "#fff" : "#ccc";
        ctx.fillText("▶ ENABLE", btnX + btnW / 2, btnY + 21);
        
        // Store bounds for click detection
        window.musicPermissionBtnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
        
        ctx.textAlign = "left";
      }
    } catch (err) {
      console.error('Draw error:', err);
      // SAFETY: Restore context to prevent transform accumulation on error
      try { ctx.restore(); } catch (e) {}
    }
  }

  // Auto-connect
  connect();
  draw();

  nameInput.addEventListener("input", debounce(() => {
    const name = nameInput.value.trim();
    // Save to localStorage
    if (name) {
      localStorage.setItem("rogueAsteroidPlayerName", name);
    }
    if (connected && name) {
      send({ t: "setName", name });
    }
  }, 300));

  readyBtn.onclick = () => { send({ t: "ready" }); };
  
  // Connect button handler
  const connectBtn = document.getElementById("connectBtn");
  if (connectBtn) {
    connectBtn.onclick = () => { connect(); };
  }
  
  launchBtn.onclick = () => { 
    const me = lobbyPlayers.find(p => p.id === myId);
    if (!me?.ready) return;
    
    if (allReady) {
      send({ t: "start" });
    } else if (readyCount >= 1) {
      // Force start - kicks idle players
      send({ t: "forceStart" });
    }
  };
})();