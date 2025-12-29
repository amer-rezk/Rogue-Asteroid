(() => {
  // ===== Configuration =====
  // Updated to new Netlify address
  const DEFAULT_SERVER = "wss://mute-lungfish-no-name-orgs-aef98851.koyeb.app/ws";

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
    1: { name: "Sniper", cost: 120, color: "#00ff00", desc: "Long Range", upgradeCost: 80, icon: "🎯" },
    2: { name: "Missile", cost: 250, color: "#ff0000", desc: "Splash Dmg", upgradeCost: 150, icon: "🚀" }
  };
  const MAX_TOWER_LEVEL = 5;

  // PvP Attack Types
  const ATTACK_TYPES = {
    swarm: { name: "Swarm", cost: 25, desc: "3 fast weak", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 35, desc: "Very tanky", color: "#ff4444", icon: "🪨" },
    carrier: { name: "Carrier", cost: 60, desc: "Spawns minions!", color: "#ff00ff", icon: "👑" },
    splitter: { name: "Splitter", cost: 50, desc: "Splits x15", color: "#00ffff", icon: "💎" },
    ghost: { name: "Ghost", cost: 40, desc: "2 phasing", color: "#8800ff", icon: "👻" }
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
  let gameOverData = null;
  
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
  
  // Buy additional upgrade
  let buyUpgradeCost = 30;
  let hoveredBuyUpgrade = false;

  // Visual
  let stars = [];
  let screenShake = 0;
  let time = 0;

  // CLIENT-SIDE RENDERING (offloaded from server)
  let clientParticles = [];      // Particles generated from events
  let clientDamageNumbers = [];  // Damage numbers generated from events
  let clientLightning = [];      // Lightning effects from tesla coil
  let asteroidCache = new Map(); // Cache: id -> {vertices, rotSpeed, rotation, color}
  let lastUpdateTime = Date.now();
  
  // SMOOTH INTERPOLATION for fluid movement
  let lastServerTime = Date.now();
  let missileStates = new Map();  // id -> {x, y, targetX, targetY, vx, vy}
  let bulletStates = new Map();   // id -> {x, y, targetX, targetY, vx, vy}
  const INTERP_SPEED = 0.25;      // Increased for smoother catch-up to server position

  // ===== Utilities =====
  function hexToRgba(hex, alpha) {
    let c = hex.replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Performance helpers
  function setShadow(ctx, color, blur) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  }
  
  function clearShadow(ctx) {
    ctx.shadowBlur = 0;
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
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
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

  function createClientDamageNumber(x, y, amount, isCrit) {
    clientDamageNumbers.push({
      x, y,
      amount: Math.round(amount * 10) / 10,
      isCrit,
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
    
    // Screen shake for lightning
    screenShake = Math.max(screenShake, 4);
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
    // Update particles
    clientParticles = clientParticles.filter(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.vx *= Math.pow(0.95, dt * 60); // Frame-rate independent damping
      p.vy *= Math.pow(0.95, dt * 60);
      return p.life > 0;
    });
    
    // Update damage numbers
    clientDamageNumbers = clientDamageNumbers.filter(d => {
      d.y += d.vy * dt;
      d.life -= dt * 1.5;
      return d.life > 0;
    });
    
    // Update lightning effects
    clientLightning = clientLightning.filter(l => {
      l.life -= dt;
      return l.life > 0;
    });
    
    // Update cached asteroid rotations
    for (const [id, data] of asteroidCache) {
      data.rotation += data.rotSpeed * dt;
    }
    
    // SMOOTH INTERPOLATION: Frame-rate independent smoothing toward server positions
    if (lastSnap) {
      // Calculate frame-rate independent interpolation factor
      // At 60fps (dt=0.0167), factor ≈ 0.25. At 30fps (dt=0.033), factor ≈ 0.44
      const interpFactor = 1 - Math.pow(1 - INTERP_SPEED, dt * 60);
      
      // Interpolate missiles toward their target positions
      for (const [id, state] of missileStates) {
        // Move toward target with velocity-based prediction
        state.x += state.vx * dt;
        state.y += state.vy * dt;
        
        // Smoothly correct toward server target (frame-rate independent)
        state.x += (state.targetX - state.x) * interpFactor;
        state.y += (state.targetY - state.y) * interpFactor;
        
        // Also advance target by velocity (server is also moving it)
        state.targetX += state.vx * dt;
        state.targetY += state.vy * dt;
      }
      
      // Interpolate bullets toward their target positions
      for (const [id, state] of bulletStates) {
        state.x += state.vx * dt;
        state.y += state.vy * dt;
        state.x += (state.targetX - state.x) * interpFactor;
        state.y += (state.targetY - state.y) * interpFactor;
        state.targetX += state.vx * dt;
        state.targetY += state.vy * dt;
      }
      
      // Apply interpolated positions to lastSnap for rendering
      if (lastSnap.missiles) {
        for (const m of lastSnap.missiles) {
          const state = missileStates.get(m.id);
          if (state) {
            m.x = state.x;
            m.y = state.y;
          }
        }
      }
      if (lastSnap.bullets) {
        for (const b of lastSnap.bullets) {
          const state = bulletStates.get(b.id);
          if (state) {
            b.x = state.x;
            b.y = state.y;
          }
        }
      }
    }
  }

  function processServerEvents(events) {
    if (!events || !Array.isArray(events)) return;
    
    for (const ev of events) {
      switch (ev.t) {
        case "spawn":
          // Cache asteroid visual data and initial velocity
          asteroidCache.set(ev.id, {
            vertices: ev.vertices,
            rotSpeed: ev.rotSpeed,
            rotation: Math.random() * Math.PI * 2,
            color: ev.color || "#fa0",
            isBoss: ev.isBoss || false,
            isBossAd: ev.isBossAd || false,
            bossAdVariant: ev.bossAdVariant || null
          });
          // Initialize interpolation state with spawn position
          missileStates.set(ev.id, {
            x: ev.x,
            y: ev.y,
            targetX: ev.x,
            targetY: ev.y,
            vx: ev.vx || 0,
            vy: ev.vy || 30
          });
          break;
          
        case "explosion":
          createClientParticle(ev.x, ev.y, ev.color, ev.radius > 30 ? 12 : 8, ev.radius / 25);
          break;
          
        case "damage":
          createClientDamageNumber(ev.x, ev.y, ev.amount, ev.isCrit);
          break;
          
        case "lightning":
          // Tesla coil lightning effect
          createLightningEffect(ev.points, ev.isCrit, ev.slot);
          break;
      }
    }
  }

  function cleanupAsteroidCache(currentMissileIds) {
    // Remove cached data for asteroids that no longer exist
    const currentIds = new Set(currentMissileIds);
    for (const id of asteroidCache.keys()) {
      if (!currentIds.has(id)) {
        asteroidCache.delete(id);
      }
    }
  }

  // ===== Networking =====
  function connect() {
    forcedDisconnect = false;
    if (statusText) statusText.textContent = "CONNECTING...";
    if (statusLED) statusLED.className = "led";

    if (ws) try { ws.close(); } catch { }

    // Use serverUrl input value if available, otherwise use default
    const serverUrlInput = document.getElementById("serverUrl");
    const serverAddress = serverUrlInput?.value?.trim() || DEFAULT_SERVER;
    ws = new WebSocket(serverAddress);

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
    };

    ws.onclose = () => {
      connected = false;
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
          showMenu();
        }
        phase = "lobby";
        lobbyEl.style.display = "block";
        updateLobbyUI();
        break;

      case "started":
        phase = "playing";
        world = msg.world;
        wave = msg.wave;
        upgradeOptions = [];
        upgradePicked = false;
        buildMenuOpen = null;
        incomingAttacks = [];
        // If this is a spectator watching from lobby, mark as spectator
        if (msg.isSpectator) {
          isSpectator = true;
        }
        // Clear client-side visual caches
        clientParticles = [];
        clientDamageNumbers = [];
        clientLightning = [];
        asteroidCache.clear();
        // Clear prediction states
        missileStates.clear();
        bulletStates.clear();
        lastServerTime = Date.now();
        showGame();
        break;

      case "wave":
        wave = msg.wave;
        // Don't clear upgradeOptions - continuous wave system keeps cards visible
        buildMenuOpen = null;
        incomingAttacks = [];
        screenShake = 10;
        // Clear particles between waves for cleaner visuals
        clientParticles = [];
        // Clear prediction states for new wave
        missileStates.clear();
        bulletStates.clear();
        break;

      case "upgrade":
        upgradeOptions = msg.options;
        upgradePicked = false;
        buildMenuOpen = null;
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
        break;

      case "picked":
        upgradePicked = true;
        break;

      case "attackHit":
        // Show gold earned from attack hitting opponent
        attackHitFeedback = { gold: msg.gold, target: msg.target, time: Date.now() };
        break;

      case "interest":
        // Show interest earned at wave end
        interestFeedback = { amount: msg.amount, time: Date.now() };
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
        break;

      case "moduleCardPicked":
        // A player picked a card
        moduleCards = moduleCards.filter((c, i) => i !== msg.cardIndex);
        if (msg.playerId === myId) {
          // We picked - show confirmation
          moduleFeedback = { moduleId: msg.moduleId, time: Date.now() };
        }
        break;

      case "moduleCardPhaseEnd":
        // Module selection done
        moduleCardPhase = false;
        moduleCards = [];
        break;

      case "bossKilled":
        // Show boss killer announcement
        bossKillerFeedback = { name: msg.killerName, isMe: msg.killerId === myId, time: Date.now() };
        break;

      case "moduleSlotted":
        // Module was slotted into tower
        break;

      case "moduleError":
        // Show error (module locked, etc)
        moduleErrorFeedback = { error: msg.error, time: Date.now() };
        break;

      case "state":
        // Process server events first (spawns, explosions, damage)
        if (msg.events) {
          processServerEvents(msg.events);
        }
        
        // Calculate time delta for velocity estimation
        const now = Date.now();
        lastServerTime = now;
        
        // Update missile states - store server position as target
        if (msg.missiles) {
          for (const m of msg.missiles) {
            const prev = missileStates.get(m.id);
            if (prev) {
              // Existing missile: update target, keep current interpolated position
              prev.targetX = m.x;
              prev.targetY = m.y;
              prev.vx = m.vx || 0;
              prev.vy = m.vy || 30;
            } else {
              // New missile: start at server position
              missileStates.set(m.id, {
                x: m.x,
                y: m.y,
                targetX: m.x,
                targetY: m.y,
                vx: m.vx || 0,
                vy: m.vy || 30
              });
            }
          }
          // Remove missiles that no longer exist
          const currentIds = new Set(msg.missiles.map(m => m.id));
          for (const id of missileStates.keys()) {
            if (!currentIds.has(id)) missileStates.delete(id);
          }
        }
        
        // Update bullet states - store server position as target  
        if (msg.bullets) {
          for (const b of msg.bullets) {
            const prev = bulletStates.get(b.id);
            if (prev) {
              prev.targetX = b.x;
              prev.targetY = b.y;
              prev.vx = b.vx;
              prev.vy = b.vy;
            } else {
              bulletStates.set(b.id, {
                x: b.x,
                y: b.y,
                targetX: b.x,
                targetY: b.y,
                vx: b.vx,
                vy: b.vy
              });
            }
          }
          const currentIds = new Set(msg.bullets.map(b => b.id));
          for (const id of bulletStates.keys()) {
            if (!currentIds.has(id)) bulletStates.delete(id);
          }
        }
        
        // Augment missiles with cached vertices/rotation
        if (msg.missiles) {
          for (const m of msg.missiles) {
            const cached = asteroidCache.get(m.id);
            if (cached) {
              m.vertices = cached.vertices;
              m.rotation = cached.rotation;
            }
          }
          // Clean up cache for destroyed asteroids
          cleanupAsteroidCache(msg.missiles.map(m => m.id));
        }
        
        // Bullets now come with vx/vy directly from server (homing changes direction)
        
        // Use client-side particles/damage numbers if server didn't send them
        if (!msg.particles || msg.particles.length === 0) {
          msg.particles = clientParticles;
        }
        if (!msg.damageNumbers || msg.damageNumbers.length === 0) {
          msg.damageNumbers = clientDamageNumbers;
        }
        
        lastSnap = msg;
        phase = msg.phase;
        wave = msg.wave;
        world = msg.world;
        if (msg.spectatorCount !== undefined) {
          spectatorCount = msg.spectatorCount;
        }
        // Update module card phase state from server
        if (msg.moduleCardPhase !== undefined) {
          moduleCardPhase = msg.moduleCardPhase;
        }
        if (msg.modulePickTimer !== undefined) {
          modulePickTimeLeft = msg.modulePickTimer;
        }
        if (msg.currentModulePicker !== undefined) {
          currentModulePicker = msg.currentModulePicker;
        }
        break;

      case "attackQueued":
        // Visual feedback that attack was queued
        screenShake = 3;
        recentAttackSent = { type: msg.attackType, target: msg.targetName, time: Date.now() };
        break;

      case "incomingAttack":
        incomingAttacks.push({ type: msg.attackType, from: msg.from, time: Date.now() });
        screenShake = 5;
        break;

      case "gameOver":
        phase = "gameover";
        gameOverData = msg;
        buildMenuOpen = null;
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
      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const div = document.createElement("div");
        const rankClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
        div.className = "leaderboard-entry " + rankClass;
        div.innerHTML = `
          <div class="leaderboard-rank">#${i + 1}</div>
          <div class="leaderboard-name">${entry.name}</div>
          <div class="leaderboard-score">${Math.round(entry.score)}</div>
          <div class="leaderboard-wave">W${entry.wave}</div>
        `;
        leaderboardList.appendChild(div);
      }
    } else {
      leaderboardList.innerHTML = '<div class="leaderboard-empty">No scores yet - be the first!</div>';
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
  canvas.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; });
  canvas.addEventListener("mousedown", (e) => { if (e.button === 0) { mouseDown = true; handleClick(); } });
  window.addEventListener("mouseup", (e) => { if (e.button === 0) mouseDown = false; });
  canvas.addEventListener("touchstart", (e) => { e.preventDefault(); mouseDown = true; if (e.touches[0]) { mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; } handleClick(); });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); if (e.touches[0]) { mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; } });
  canvas.addEventListener("touchend", (e) => { e.preventDefault(); mouseDown = false; });

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
    // Handle in-game chat button click
    if ((phase === "playing" || phase === "upgrades") && window.gameChatBtnBounds) {
      const btn = window.gameChatBtnBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        toggleGameChat();
        return;
      }
    }
    
    // Handle chat close button
    if (chatOpen && window.gameChatCloseBounds) {
      const btn = window.gameChatCloseBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        chatOpen = false;
        return;
      }
    }
    
    // Handle game over return to menu button
    if (phase === "gameover" && gameOverData && gameOverData.menuBtnBounds) {
      const btn = gameOverData.menuBtnBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        send({ t: "returnToLobby" });
        return;
      }
    }
    
    if (phase === "playing" && hoveredUpgrade >= 0 && !upgradePicked && upgradeOptions.length > 0) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) send({ t: "pickUpgrade", key: opt.key });
      return;
    }

    // Handle module card selection
    if (phase === "playing" && moduleCardPhase && hoveredModuleCard >= 0 && currentModulePicker === myId) {
      send({ t: "pickModuleCard", cardIndex: hoveredModuleCard });
      return;
    }

    // Handle reroll button click
    if (phase === "playing" && hoveredReroll && !upgradePicked && upgradeOptions.length > 0) {
      const myPlayer = lastSnap?.players.find(p => p.id === myId);
      if (myPlayer && myPlayer.gold >= currentRerollCost) {
        send({ t: "rerollUpgrades" });
      }
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
      return;
    }

    // Handle stats panel button click
    if (phase === "playing" && hoveredStatsBtn) {
      statsPanelOpen = !statsPanelOpen;
      return;
    }

    // Handle damage numbers toggle click
    if (phase === "playing" && statsPanelOpen && window.dmgToggleBounds) {
      const b = window.dmgToggleBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        showDamageNumbers = !showDamageNumbers;
        localStorage.setItem("rogueAsteroidDmgNumbers", showDamageNumbers.toString());
        return;
      }
    }

    // Handle quantity mode button clicks
    if (hoveredQuantityBtn && phase === "playing") {
      attackQuantityMode = hoveredQuantityBtn;
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
      return;
    }

    // Handle build/upgrade menu clicks
    if (buildMenuOpen) {
      // Check if clicking on a module slot
      if (hoveredModuleSlot) {
        if (hoveredModuleSlot.hasModule && !hoveredModuleSlot.locked) {
          // Unslot the module
          send({ t: "unslotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex });
          return;
        } else if (!hoveredModuleSlot.hasModule && selectedInventoryModule) {
          // Slot module from inventory
          send({ t: "slotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex, inventoryIndex: selectedInventoryModule.index });
          selectedInventoryModule = null;
          return;
        }
        return;
      }
      
      if (hoveredBuildOption === "upgrade") {
        send({ t: "upgradeTower", slotIndex: buildMenuOpen.slotIndex });
        buildMenuOpen = null;
        return;
      } else if (hoveredBuildOption === "sell") {
        send({ t: "sellTower", slotIndex: buildMenuOpen.slotIndex });
        buildMenuOpen = null;
        return;
      } else if (typeof hoveredBuildOption === "number" && hoveredBuildOption >= 0) {
        send({ t: "buyTower", slotIndex: buildMenuOpen.slotIndex, type: hoveredBuildOption });
        buildMenuOpen = null;
        return;
      } else if (hoveredModuleSlot) {
        // Handle module slot click
        const myPlayer = lastSnap?.players.find(p => p.id === myId);
        const inv = myPlayer?.inventory || [];
        
        if (hoveredModuleSlot.hasModule) {
          // Try to unslot the module
          if (!hoveredModuleSlot.locked) {
            send({ t: "unslotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex });
          }
        } else if (selectedInventoryModule && inv.length > 0) {
          // Slot the selected inventory module
          send({ t: "slotModule", towerIndex: hoveredModuleSlot.towerIndex, moduleSlot: hoveredModuleSlot.slotIndex, inventoryIndex: selectedInventoryModule.index });
          selectedInventoryModule = null;
        }
        return;
      } else {
        buildMenuOpen = null;
        return;
      }
    }

    // Handle inventory item click (select for slotting)
    if (phase === "playing" && selectedInventoryModule) {
      // If clicking outside tower menu, deselect
      selectedInventoryModule = null;
    }
    
    // Handle inventory card click (to select for slotting)
    if (phase === "playing" && selectedInventoryModule && !buildMenuOpen) {
      // Clicked somewhere else, deselect
      selectedInventoryModule = null;
    }

    if (phase === "playing" && lastSnap) {
      const { sx, sy, offsetX, offsetY } = getScale();
      const me = lastSnap.players.find(p => p.id === myId);

      if (me && me.towers) {
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
  function sendInput() {
    if (phase !== "playing" || !lastSnap || isSpectator) return;
    const scale = getScale();
    const worldX = (mouseX - scale.offsetX) / scale.sx;
    const worldY = (mouseY - scale.offsetY) / scale.sy;
    send({ t: "input", x: worldX, y: worldY, shooting: mouseDown && !buildMenuOpen });
  }
  setInterval(sendInput, 33);

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

  // ===== Unique Projectile Rendering =====
  function drawBullet(b, sx, sy, baseColor) {
    const x = b.x * sx;
    const y = b.y * sy;
    const r = b.r * sx;
    const angle = Math.atan2(b.vy, b.vx);

    const fadeStart = 0.5;
    const alpha = b.lifespan < fadeStart ? Math.max(0.2, b.lifespan / fadeStart) : 1.0;

    ctx.save();

    switch (b.bulletType) {
      case "gatling":
        // Gatling: Small rapid yellow tracers with short trail
        const gatlingTrail = 10 * sx;
        ctx.strokeStyle = hexToRgba("#ffff00", 0.5 * alpha);
        ctx.lineWidth = r * 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * gatlingTrail, y - Math.sin(angle) * gatlingTrail);
        ctx.stroke();

        // Bullet core
        ctx.fillStyle = hexToRgba("#ffff00", alpha);
        ctx.shadowColor = "#ffff00";
        ctx.shadowBlur = 6 * alpha;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
        break;

      case "sniper":
        // Sniper: Long green laser beam with afterglow
        const laserLen = 35 * sx;
        const laserWidth = r * 0.6;

        // Outer glow
        ctx.strokeStyle = hexToRgba("#00ff00", 0.2 * alpha);
        ctx.lineWidth = laserWidth * 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();

        // Inner beam
        ctx.strokeStyle = hexToRgba("#00ff00", 0.8 * alpha);
        ctx.lineWidth = laserWidth * 2;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();

        // Core line
        ctx.strokeStyle = hexToRgba("#aaffaa", alpha);
        ctx.lineWidth = laserWidth;
        ctx.shadowColor = "#00ff00";
        ctx.shadowBlur = 10 * alpha;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();

        // Bright tip
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        break;

      case "missile":
        // Missile: Red rocket with fire/smoke trail
        const missileLen = 12 * sx;
        const missileWidth = r * 1.2;

        // Smoke trail
        for (let i = 0; i < 5; i++) {
          const smokeX = x - Math.cos(angle) * (8 + i * 6) * sx + (Math.random() - 0.5) * 4;
          const smokeY = y - Math.sin(angle) * (8 + i * 6) * sx + (Math.random() - 0.5) * 4;
          const smokeAlpha = (1 - i / 5) * 0.3 * alpha;
          ctx.fillStyle = hexToRgba("#666666", smokeAlpha);
          ctx.beginPath();
          ctx.arc(smokeX, smokeY, (3 + i) * sx, 0, Math.PI * 2);
          ctx.fill();
        }

        // Fire trail
        ctx.fillStyle = hexToRgba("#ff6600", 0.7 * alpha);
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(angle) * missileLen * 0.5, y - Math.sin(angle) * missileLen * 0.5);
        ctx.lineTo(x - Math.cos(angle) * missileLen * 1.5 + Math.cos(angle + 0.5) * 4 * sx, 
                   y - Math.sin(angle) * missileLen * 1.5 + Math.sin(angle + 0.5) * 4 * sx);
        ctx.lineTo(x - Math.cos(angle) * missileLen * 2, y - Math.sin(angle) * missileLen * 2);
        ctx.lineTo(x - Math.cos(angle) * missileLen * 1.5 + Math.cos(angle - 0.5) * 4 * sx,
                   y - Math.sin(angle) * missileLen * 1.5 + Math.sin(angle - 0.5) * 4 * sx);
        ctx.closePath();
        ctx.fill();

        // Missile body
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = hexToRgba("#ff4444", alpha);
        ctx.shadowColor = "#ff0000";
        ctx.shadowBlur = 8 * alpha;
        ctx.beginPath();
        ctx.ellipse(0, 0, missileLen, missileWidth, 0, 0, Math.PI * 2);
        ctx.fill();

        // Nose cone
        ctx.fillStyle = hexToRgba("#ffaaaa", alpha);
        ctx.beginPath();
        ctx.ellipse(missileLen * 0.7, 0, missileLen * 0.4, missileWidth * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;

      default:
        // Main turret: Player-colored energy bolt
        const trail = 12 * sx;
        const color = b.isCrit ? "#ffffff" : baseColor;
        const glowColor = b.isCrit ? "#ffff00" : baseColor;

        // Trail gradient
        const gradient = ctx.createLinearGradient(
          x, y,
          x - Math.cos(angle) * trail, y - Math.sin(angle) * trail
        );
        gradient.addColorStop(0, hexToRgba(color, 0.8 * alpha));
        gradient.addColorStop(1, hexToRgba(color, 0));

        ctx.strokeStyle = gradient;
        ctx.lineWidth = r * 1.8;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * trail, y - Math.sin(angle) * trail);
        ctx.stroke();

        // Bullet body
        ctx.fillStyle = hexToRgba(color, alpha);
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = (b.isCrit ? 15 : 10) * alpha;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        if (b.isCrit) {
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
    }

    ctx.restore();
  }

  // Track last frame time for smooth delta time calculation
  let lastFrameTime = performance.now();

  function draw() {
    requestAnimationFrame(draw);

    try {
      // Calculate actual delta time for smooth animations
      const now = performance.now();
      const dt = Math.min((now - lastFrameTime) / 1000, 0.05); // Cap at 50ms to prevent huge jumps
      lastFrameTime = now;
      
      time += dt;
      screenShake *= 0.92;
      
      // Update client-side visual effects (particles, damage numbers, asteroid rotations)
      updateClientEffects(dt);

      ctx.fillStyle = "#050510";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Stars
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.y += s.speed;
        if (s.y > 1) s.y = 0;
        const twinkle = Math.sin(time * 3 + s.twinkle) * 0.3 + 0.7;
        ctx.fillStyle = `rgba(255,255,255,${twinkle * 0.5})`;
        ctx.beginPath();
        ctx.arc(s.x * canvas.width, s.y * canvas.height, s.size, 0, Math.PI * 2);
        ctx.fill();
      }

      if (phase === "menu" || phase === "lobby") {
        drawNeonText("ROGUE ASTEROID", canvas.width / 2, 50, "#0ff", 28, "center");
        drawNeonText("PvP", canvas.width / 2, 85, "#f44", 18, "center");
        return;
      }

      if (!lastSnap) return;

      const { sx, sy, offsetX, offsetY } = getScale();
      ctx.save();
      if (screenShake > 0.5) ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
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
        if (p.upgrades?.slowfield) {
          ctx.fillStyle = hexToRgba(PLAYER_COLORS[p.slot]?.main || "#fff", 0.04);
          ctx.fillRect(p.slot * world.segmentWidth * sx, 0, world.segmentWidth * sx, 560 * sy);
        }
      }
      for (const p of lastSnap.players) {
        if (p.upgrades?.shieldActive > 0) {
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
          ctx.fillStyle = hexToRgba(p.color, p.life / (p.maxLife || 0.5));
          ctx.beginPath();
          ctx.arc(p.x * sx, p.y * sy, (p.size || 2) * sx, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Tesla Coil Lightning Effects
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
          
          // Outer glow
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
          
          // Bright core
          ctx.strokeStyle = hexToRgba("#fff", alpha);
          ctx.lineWidth = 2 * sx;
          ctx.shadowColor = "#fff";
          ctx.shadowBlur = 5;
          ctx.beginPath();
          ctx.moveTo(segment[0].x * sx, segment[0].y * sy);
          for (let i = 1; i < segment.length; i++) {
            ctx.lineTo(segment[i].x * sx, segment[i].y * sy);
          }
          ctx.stroke();
        }
        
        ctx.restore();
      }

      // Asteroids/Missiles
      for (const m of lastSnap.missiles) {
        const x = m.x * sx;
        const y = m.y * sy;
        const r = m.r * sx;

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
          ctx.save();
          
          // Draw streak lines (motion trails)
          const streakLength = 80 * sy;
          const numStreaks = 5;
          
          for (let i = 0; i < numStreaks; i++) {
            const offsetX = (Math.random() - 0.5) * r * 1.5;
            const alpha = 0.3 + Math.random() * 0.4;
            
            const grad = ctx.createLinearGradient(x + offsetX, y - streakLength, x + offsetX, y);
            grad.addColorStop(0, "rgba(150, 180, 255, 0)");
            grad.addColorStop(0.5, `rgba(180, 200, 255, ${alpha})`);
            grad.addColorStop(1, `rgba(255, 255, 255, ${alpha + 0.2})`);
            
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1 + Math.random() * 2;
            ctx.beginPath();
            ctx.moveTo(x + offsetX, y - streakLength);
            ctx.lineTo(x + offsetX, y);
            ctx.stroke();
          }
          
          // Main FTL glow around asteroid
          setShadow(ctx, "#aaccff", 25);
          
          // Draw elongated asteroid (stretched during FTL)
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
          
          ctx.restore();
          clearShadow(ctx);
          continue; // Skip normal rendering for FTL asteroids
        }

        // Ghost phasing effect
        const phaseAlpha = m.isPhased ? 0.3 : 0.7;

        // Check if this is a boss or boss ad that should use images
        const isBoss = m.isBoss || m.type === "boss";
        const isBossAd = m.isBossAd;
        const bossAdVariant = m.bossAdVariant;
        
        // Determine which image to use (if any) - check individual image directly
        let bossImage = null;
        if (isBoss && bossImages.boss && bossImages.boss.complete && bossImages.boss.naturalWidth > 0) {
          bossImage = bossImages.boss;
        } else if (isBossAd && bossAdVariant >= 1 && bossAdVariant <= 5) {
          const adImg = bossImages[`ad${bossAdVariant}`];
          if (adImg && adImg.complete && adImg.naturalWidth > 0) {
            bossImage = adImg;
          }
        }

        ctx.save();
        ctx.translate(x, y);
        
        if (bossImage) {
          // Render boss/boss-ad using image
          ctx.rotate(rotation);
          ctx.globalAlpha = phaseAlpha + 0.3; // Slightly more visible for bosses
          
          // Draw glow effect behind boss
          if (isBoss) {
            setShadow(ctx, "#ff0000", 20);
          } else if (isBossAd) {
            setShadow(ctx, "#ff6600", 12);
          }
          
          // Draw the image centered and scaled to fit the radius
          const imgSize = r * 2.2; // Slightly larger than hitbox
          ctx.drawImage(bossImage, -imgSize/2, -imgSize/2, imgSize, imgSize);
          clearShadow(ctx);
          ctx.globalAlpha = 1;
        } else {
          // Standard procedural asteroid rendering
          ctx.rotate(rotation);
          ctx.fillStyle = hexToRgba(baseColor, phaseAlpha);
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1.5;
          setShadow(ctx, baseColor, 8);

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

        // HP bar
        if (m.hp < m.maxHp) {
          const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
          ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
        }

        // Attack type indicator (skip for boss/boss-ads which use images)
        if (!isBoss && !isBossAd && m.attackType && ATTACK_TYPES[m.attackType]) {
          ctx.font = `${10 * sx}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(ATTACK_TYPES[m.attackType].icon, x, y + r + 12 * sy);
        }
      }

      // Bullets with unique visuals
      for (const b of lastSnap.bullets) {
        const baseColor = PLAYER_COLORS[b.slot]?.main || "#0ff";
        drawBullet(b, sx, sy, baseColor);
      }

      // Damage numbers
      if (showDamageNumbers && lastSnap.damageNumbers) {
        for (const d of lastSnap.damageNumbers) {
          ctx.font = `bold ${d.isCrit ? 16 : 12}px 'Courier New', monospace`;
          ctx.textAlign = "center";
          ctx.fillStyle = d.isCrit ? `rgba(255,255,0,${d.life})` : `rgba(255,255,255,${d.life})`;
          // Round to max 2 decimal places, remove trailing zeros
          const rounded = Math.round(d.amount * 100) / 100;
          const displayText = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, '');
          ctx.fillText(displayText, d.x * sx, d.y * sy);
        }
      }

      // Players and turrets
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

        // Main turret
        const turretAlpha = isDead ? 0.3 : 0.8;
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

        // Tower slots
        const offsets = [-110, -50, 50, 110];
        const towers = p.towers || [null, null, null, null];
        towers.forEach((t, i) => {
          const tx = cx + offsets[i] * sx;
          const ty = 560 * sy;
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
                } else if (typeInfo.name === "Sniper") {
                const bodyW = 10 * sx * scale;
                const bodyH = 14 * sy * scale;
                ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(-bodyW / 2, -bodyH, bodyW, bodyH, 2);
                ctx.fill();
                ctx.stroke();
                // Long barrel
                ctx.fillStyle = hexToRgba(tColor, towerAlpha);
                ctx.fillRect(-1.5 * sx * scale, -bodyH - 14 * sy * scale, 3 * sx * scale, 16 * sy * scale);
                // Scope
                ctx.fillStyle = hexToRgba("#00ffaa", towerAlpha);
                ctx.beginPath();
                ctx.arc(5 * sx * scale, -bodyH + 4 * sy * scale, 2 * sx * scale, 0, Math.PI * 2);
                ctx.fill();
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
        }
      }
      ctx.restore();

      // HUD
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, canvas.width, 50);
      drawNeonText(`WAVE ${wave}`, 20, 25, "#ff0", 18, "left");
      
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
        // Gold display with more spacing
        drawNeonText(`${myPlayer.gold} 🟡`, 140, 25, "#fd0", 18, "left");
        // Show last interest gained (if any)
        if (myPlayer.lastInterest > 0) {
          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.fillStyle = "#0f0";
          ctx.textAlign = "left";
          ctx.fillText(`+${myPlayer.lastInterest}`, 215, 25);
        }
        // Kills further right
        drawNeonText(`${myPlayer.kills} 💀`, 270, 25, "#f44", 14, "left");
      }

      // Scoreboard
      ctx.textAlign = "right";
      ctx.font = "12px 'Courier New', monospace";
      let scoreX = canvas.width - 20;
      for (let i = lastSnap.players.length - 1; i >= 0; i--) {
        const p = lastSnap.players[i];
        const color = PLAYER_COLORS[p.slot]?.main || "#fff";
        ctx.fillStyle = p.hp <= 0 ? "#666" : color;
        const text = `${p.name}: ${p.score}`;
        ctx.fillText(text, scoreX, 30);
        scoreX -= ctx.measureText(text).width + 20;
      }
      ctx.textAlign = "left";

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
        if (isAlive) {
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
        }

        // ===== TOTAL RUN DPS PANEL =====
        const playerCount = lastSnap.players.filter(p => p.slot >= 0).length;
        const totalDmgPanelH = 55 + playerCount * 38; // 25% bigger
        drawSectionPanel(panelX, currentY, panelW, totalDmgPanelH, "rgba(145,255,122,0.4)", "📊 TOTAL DAMAGE", "#91ff7a");
        
        // Calculate totals for run
        const totalDamage = lastSnap.players.reduce((sum, p) => sum + (p.damageDealt || 0), 0);
        const maxDamage = Math.max(...lastSnap.players.map(p => p.damageDealt || 0), 1);
        
        // Total damage number (centered, big)
        ctx.font = "bold 16px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#91ff7a";
        ctx.shadowColor = "#91ff7a";
        ctx.shadowBlur = 12;
        ctx.fillText(Math.round(totalDamage).toLocaleString(), panelX + panelW / 2, currentY + 45);
        ctx.shadowBlur = 0;
        
        // Sort and draw players
        const sortedByTotal = [...lastSnap.players]
          .filter(p => p.slot >= 0)
          .sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0));
        
        sortedByTotal.forEach((p, i) => {
          const rowY = currentY + 55 + i * 38; // 25% bigger row spacing
          drawPlayerDamageRow(p, rowY, p.damageDealt || 0, maxDamage, totalDamage, i === 0, panelX, panelW);
        });
        
        currentY += totalDmgPanelH + 10;

        // ===== CURRENT WAVE DPS PANEL =====
        const waveDmgPanelH = 55 + playerCount * 38; // 25% bigger
        drawSectionPanel(panelX, currentY, panelW, waveDmgPanelH, "rgba(122,224,255,0.4)", "🌊 WAVE " + wave + " DAMAGE", "#7ae0ff");
        
        // Calculate totals for wave
        const totalWaveDamage = lastSnap.players.reduce((sum, p) => sum + (p.waveDamage || 0), 0);
        const maxWaveDamage = Math.max(...lastSnap.players.map(p => p.waveDamage || 0), 1);
        
        // Wave damage number (centered, big)
        ctx.font = "bold 16px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#7ae0ff";
        ctx.shadowColor = "#7ae0ff";
        ctx.shadowBlur = 12;
        ctx.fillText(Math.round(totalWaveDamage).toLocaleString(), panelX + panelW / 2, currentY + 45);
        ctx.shadowBlur = 0;
        
        // Sort and draw players by wave damage
        const sortedByWave = [...lastSnap.players]
          .filter(p => p.slot >= 0)
          .sort((a, b) => (b.waveDamage || 0) - (a.waveDamage || 0));
        
        sortedByWave.forEach((p, i) => {
          const rowY = currentY + 55 + i * 38; // 25% bigger row spacing
          drawPlayerDamageRow(p, rowY, p.waveDamage || 0, maxWaveDamage, totalWaveDamage, i === 0, panelX, panelW);
        });
        
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
      if (phase === "playing" && myPlayer && myPlayer.inventory && myPlayer.inventory.length > 0) {
        const MODULES = window.TOWER_MODULES || {};
        const inv = myPlayer.inventory;
        
        const invPanelW = 180;
        const invPanelH = 40 + Math.ceil(inv.length / 4) * 45;
        const invPanelX = 15;
        const invPanelY = canvas.height - invPanelH - 60;
        
        // Panel background
        ctx.fillStyle = "rgba(10,10,30,0.9)";
        ctx.strokeStyle = "rgba(255,215,0,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(invPanelX, invPanelY, invPanelW, invPanelH, 8);
        ctx.fill();
        ctx.stroke();
        
        // Title
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffd700";
        ctx.fillText("🎴 INVENTORY", invPanelX + invPanelW / 2, invPanelY + 18);
        
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
          
          // Card background
          ctx.fillStyle = isHovered ? hexToRgba(mod.color, 0.5) : hexToRgba(mod.color, 0.25);
          ctx.strokeStyle = mod.color;
          ctx.lineWidth = isHovered ? 2 : 1;
          ctx.beginPath();
          ctx.roundRect(cardX, cardY, cardSize, cardSize, 5);
          ctx.fill();
          ctx.stroke();
          
          // Icon
          ctx.font = "20px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(mod.icon, cardX + cardSize / 2, cardY + cardSize / 2 + 6);
          
          // Store for click
          if (isHovered) {
            selectedInventoryModule = { index: i, moduleId };
            
            // Tooltip
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.fillStyle = mod.color;
            ctx.fillText(mod.name, cardX + cardSize / 2, cardY - 5);
          }
        }
        
        ctx.textAlign = "left";
        
        // Hint text
        ctx.font = "8px 'Courier New', monospace";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Click tower to equip", invPanelX + invPanelW / 2, invPanelY + invPanelH - 6);
        ctx.textAlign = "left";
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
          const panelH = 365; // Taller to fit two options
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
            { label: "Crit Chance", value: `${((u.critChance || 0) * 100).toFixed(0)}%`, color: "#ff66ff" },
            { label: "Multishot", value: `${u.multishot || 1}x`, color: "#66ffff" },
            { label: "Pierce", value: `${u.pierce || 0}`, color: "#ffff66" },
            { label: "Ricochet", value: `${u.ricochet || 0}`, color: "#ff9966" },
            { label: "Chain Chance", value: `${((u.chainChance || 0) * 100).toFixed(0)}%`, color: "#9966ff" },
            { label: "Explosive", value: `${u.explosive || 0}`, color: "#ff4444" },
            { label: "Gold Mult", value: `${((u.goldMult || 1) * 100).toFixed(0)}%`, color: "#ffd700" },
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

      // Incoming attack warnings
      const currentTime = Date.now();
      incomingAttacks = incomingAttacks.filter(a => currentTime - a.time < 3000);
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
        const { x, y, hasTower, tower } = buildMenuOpen;
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
            ctx.fillStyle = hexToRgba(rarityColor, 0.9);
            ctx.font = "bold 9px 'Courier New', monospace";
            ctx.fillText("CLICK", cardX + cardW / 2, cardY + cardH - 12);
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
        
        // Buy button background
        ctx.fillStyle = isBuyHovered && canAffordBuy ? "rgba(100,255,150,0.4)" : 
                        canAffordBuy ? "rgba(60,200,120,0.25)" : "rgba(40,40,60,0.4)";
        ctx.strokeStyle = isBuyHovered && canAffordBuy ? "#7affaa" : 
                          canAffordBuy ? "rgba(122,255,170,0.5)" : "#444";
        ctx.lineWidth = isBuyHovered && canAffordBuy ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(buyBtnX, buyBtnY, buyBtnW, buyBtnH, 6);
        ctx.fill();
        ctx.stroke();
        
        // Buy button text
        ctx.font = "18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = canAffordBuy ? "#7affaa" : "#555";
        ctx.fillText("➕", buyBtnX + buyBtnW / 2, buyBtnY + 25);
        ctx.font = "bold 10px 'Courier New', monospace";
        ctx.fillText(`${buyUpgradeCost}g`, buyBtnX + buyBtnW / 2, buyBtnY + 42);
        
        ctx.textAlign = "left";
      }

      // MODULE CARD SELECTION (after boss waves)
      if (phase === "playing" && moduleCardPhase && moduleCards.length > 0) {
        const MODULES = window.TOWER_MODULES || {};
        const isMyTurn = currentModulePicker === myId;
        
        // Darken background
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Title
        ctx.font = "bold 24px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffd700";
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 20;
        ctx.fillText("🏆 BOSS DEFEATED - CHOOSE YOUR REWARD 🏆", canvas.width / 2, 60);
        ctx.shadowBlur = 0;
        
        // Current picker info
        ctx.font = "bold 16px 'Courier New', monospace";
        if (isMyTurn) {
          ctx.fillStyle = "#0f0";
          ctx.fillText(`YOUR TURN! (${Math.ceil(modulePickTimeLeft)}s)`, canvas.width / 2, 90);
        } else {
          const pickerName = modulePickOrder.find(p => p.id === currentModulePicker)?.name || "...";
          ctx.fillStyle = "#aaa";
          ctx.fillText(`${pickerName}'s turn (${Math.ceil(modulePickTimeLeft)}s)`, canvas.width / 2, 90);
        }
        
        // Module Cards
        const modCardW = 160;
        const modCardH = 200;
        const modGap = 20;
        const totalModW = moduleCards.length * modCardW + (moduleCards.length - 1) * modGap;
        const modStartX = canvas.width / 2 - totalModW / 2;
        const modCardY = 120;
        
        hoveredModuleCard = -1;
        
        for (let i = 0; i < moduleCards.length; i++) {
          const card = moduleCards[i];
          const mod = MODULES[card.id] || card;
          const cardX = modStartX + i * (modCardW + modGap);
          const isHovered = isMyTurn && mouseX >= cardX && mouseX <= cardX + modCardW && mouseY >= modCardY && mouseY <= modCardY + modCardH;
          if (isHovered) hoveredModuleCard = i;
          
          // Card background
          ctx.save();
          ctx.shadowColor = mod.color || "#fff";
          ctx.shadowBlur = isHovered ? 30 : 15;
          
          const modGrad = ctx.createLinearGradient(cardX, modCardY, cardX, modCardY + modCardH);
          modGrad.addColorStop(0, isHovered ? "rgba(60,60,80,0.98)" : "rgba(20,20,35,0.95)");
          modGrad.addColorStop(1, isHovered ? "rgba(45,45,65,0.98)" : "rgba(15,15,28,0.95)");
          ctx.fillStyle = modGrad;
          
          ctx.beginPath();
          ctx.roundRect(cardX, modCardY, modCardW, modCardH, 10);
          ctx.fill();
          
          ctx.strokeStyle = mod.color || "#fff";
          ctx.lineWidth = isHovered ? 3 : 2;
          ctx.stroke();
          ctx.restore();
          
          // Icon
          ctx.font = "48px sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff";
          ctx.fillText(mod.icon || "?", cardX + modCardW / 2, modCardY + 60);
          
          // Name
          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.fillStyle = mod.color || "#fff";
          ctx.fillText(mod.name || card.id, cardX + modCardW / 2, modCardY + 90);
          
          // Description (wrapped)
          ctx.font = "10px 'Courier New', monospace";
          ctx.fillStyle = "#ccc";
          const desc = mod.desc || "";
          const words = desc.split(" ");
          let line = "";
          let lineY = modCardY + 110;
          for (const word of words) {
            const testLine = line + (line ? " " : "") + word;
            if (ctx.measureText(testLine).width > modCardW - 20) {
              ctx.fillText(line, cardX + modCardW / 2, lineY);
              line = word;
              lineY += 14;
            } else {
              line = testLine;
            }
          }
          if (line) ctx.fillText(line, cardX + modCardW / 2, lineY);
          
          // Click hint
          if (isHovered) {
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.fillStyle = "#0f0";
            ctx.fillText("CLICK TO SELECT", cardX + modCardW / 2, modCardY + modCardH - 10);
          }
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
        const text = bossKillerFeedback.isMe ? "🏆 YOU KILLED THE BOSS! 🏆" : `💀 ${bossKillerFeedback.name} KILLED THE BOSS!`;
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
          ctx.fillText(`Score: ${player?.score || 0}`, canvas.width / 2, 180);
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
            ctx.fillText(`${i + 1}. ${s.name} - ${s.score} pts (${s.kills} kills)`, canvas.width / 2, y);
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
    } catch (err) {
      console.error('Draw error:', err);
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