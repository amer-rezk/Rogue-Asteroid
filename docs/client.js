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
    swarm: { name: "Swarm", cost: 25, desc: "6 fast weak", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 35, desc: "Very tanky", color: "#ff4444", icon: "🪨" },
    bomber: { name: "Bomber", cost: 55, desc: "Explodes 2dmg", color: "#ff00ff", icon: "💣" },
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

  // ===== State =====
  let ws = null;
  let myId = null;
  let mySlot = 0;
  let isHost = false;
  let connected = false;

  let phase = "menu";
  let world = { width: 360, height: 600, segmentWidth: 360 };
  let wave = 0;

  // Performance settings
  let lowPerformanceMode = localStorage.getItem("rogueAsteroidLowPerf") === "true";
  let frameCount = 0;
  let lastFpsCheck = Date.now();
  let currentFps = 60;
  let fpsHistory = [];
  const FPS_CHECK_INTERVAL = 2000;
  const LOW_FPS_THRESHOLD = 35;

  let lobbyPlayers = [];
  let allReady = false;
  let readyCount = 0;
  let leaderboard = [];
  let lastSnap = null;
  let upgradeOptions = [];
  let upgradePicked = false;
  let upgradeQueueSize = 0;
  let upgradeWaveNum = 0;
  let attackHitFeedback = null;
  let interestFeedback = null;
  let refundFeedback = null;
  let gameOverData = null;

  // OPTIMIZED: Client-side particles and damage numbers
  let particles = [];
  let damageNumbers = [];
  let asteroidShapes = new Map(); // Cache asteroid vertices by ID

  // Chat system
  let chatMessages = [];
  let chatOpen = false;
  let chatUnread = 0;
  let chatInput = "";
  let chatInputFocused = false;
  let lastReadTimestamp = 0;
  let gameChatInputText = "";

  // Input
  let mouseX = 0;
  let mouseY = 0;
  let mouseDown = false;
  let hoveredUpgrade = -1;
  let forcedDisconnect = false;

  // Build Mode State
  let buildMenuOpen = null;
  let hoveredBuildOption = -1;

  // PvP Attack Panel
  let hoveredAttack = null;
  let incomingAttacks = [];
  let recentAttackSent = null;
  let attackQuantityMode = 1;
  let hoveredQuantityBtn = null;

  // Stats panel
  let statsPanelOpen = false;
  let hoveredStatsBtn = false;
  let showDamageNumbers = localStorage.getItem("rogueAsteroidDmgNumbers") !== "false";

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
    if (lowPerformanceMode) {
      ctx.shadowBlur = 0;
      return;
    }
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  }
  
  function clearShadow(ctx) {
    ctx.shadowBlur = 0;
  }
  
  function checkPerformance() {
    frameCount++;
    const now = Date.now();
    if (now - lastFpsCheck >= FPS_CHECK_INTERVAL) {
      currentFps = Math.round(frameCount * 1000 / (now - lastFpsCheck));
      fpsHistory.push(currentFps);
      if (fpsHistory.length > 5) fpsHistory.shift();
      
      const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
      if (avgFps < LOW_FPS_THRESHOLD && !lowPerformanceMode && fpsHistory.length >= 3) {
        lowPerformanceMode = true;
        localStorage.setItem("rogueAsteroidLowPerf", "true");
        console.log("Auto-enabled low performance mode (avg FPS: " + avgFps.toFixed(1) + ")");
      }
      
      frameCount = 0;
      lastFpsCheck = now;
    }
  }

  // OPTIMIZED: Client-side particle creation
  function createParticle(x, y, color, count = 8, speed = 90) {
    if (lowPerformanceMode && count > 4) count = Math.floor(count / 2);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const spd = speed * (0.6 + Math.random() * 0.6);
      particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        life: 0.3 + Math.random() * 0.2,
        maxLife: 0.5,
        color: color || "#f80",
        size: 2 + Math.random() * 2,
      });
    }
  }

  // OPTIMIZED: Client-side damage number creation
  function createDamageNumber(x, y, amount, isCrit) {
    damageNumbers.push({ x, y, amount, isCrit, life: 1.0, vy: -60 });
  }

  // OPTIMIZED: Process events from server
  function processEvents(events) {
    if (!events || !Array.isArray(events)) return;
    
    for (const ev of events) {
      switch (ev.t) {
        case "spawn":
          // Store asteroid shape for later rendering
          if (ev.vertices) {
            asteroidShapes.set(ev.id, {
              vertices: ev.vertices,
              color: ev.color || null
            });
          }
          break;
          
        case "dmg":
          // Create client-side damage number
          createDamageNumber(ev.x, ev.y, ev.amt, ev.crit);
          break;
          
        case "fx":
          // Create client-side visual effects
          switch (ev.type) {
            case "explode":
              createParticle(ev.x, ev.y, ev.color || "#fa0", 8, 100);
              break;
            case "hit":
              createParticle(ev.x, ev.y, ev.crit ? "#ff0" : "#0ff", 4, 60);
              break;
            case "shield":
              createParticle(ev.x, ev.y, "#0ff", 12, 120);
              break;
            case "ground_hit":
              createParticle(ev.x, ev.y, "#f44", 10, 80);
              screenShake = Math.max(screenShake, 5);
              break;
            case "bomb_hit":
              createParticle(ev.x, ev.y, "#ff00ff", 16, 140);
              screenShake = Math.max(screenShake, 8);
              break;
            case "ftl_exit":
              createParticle(ev.x, ev.y, "#88f", 6, 50);
              break;
            case "warp":
              createParticle(ev.x, ev.y, ev.color || "#ff00ff", 8, 80);
              break;
            case "chain":
              // Chain lightning visual - draw line in next frame
              particles.push({
                x: ev.x1, y: ev.y1,
                vx: (ev.x2 - ev.x1) * 3, vy: (ev.y2 - ev.y1) * 3,
                life: 0.12, maxLife: 0.12, color: "#ff0", size: 2
              });
              break;
          }
          break;
      }
    }
  }

  // OPTIMIZED: Update client-side particles
  function updateParticles(dt) {
    particles = particles.filter(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.vx *= 0.95;
      p.vy *= 0.95;
      return p.life > 0;
    });
    
    damageNumbers = damageNumbers.filter(d => {
      d.y += d.vy * dt;
      d.life -= dt * 1.5;
      return d.life > 0;
    });
  }

  // OPTIMIZED: Parse compact state format
  function parseCompactState(msg) {
    // Convert compact arrays to full objects for rendering compatibility
    const missiles = (msg.m || []).map(m => ({
      id: m[0],
      x: m[1],
      y: m[2],
      r: m[3],
      hp: m[4],
      maxHp: m[5],
      rotation: m[6],
      targetSlot: m[7],
      isPhased: m[8] === 1,
      inFTL: m[9] === 1,
      // Get cached vertices
      vertices: asteroidShapes.get(m[0])?.vertices || null,
      attackType: null, // Will determine from color
      type: m[3] >= 15 ? "large" : m[3] >= 11 ? "medium" : "small"
    }));
    
    // Add attack type info from cached shapes
    for (const m of missiles) {
      const cached = asteroidShapes.get(m.id);
      if (cached?.color) {
        // Find attack type by color
        for (const [key, atk] of Object.entries(ATTACK_TYPES)) {
          if (atk.color === cached.color) {
            m.attackType = key;
            break;
          }
        }
      }
    }
    
    const bullets = (msg.b || []).map(b => ({
      x: b[0],
      y: b[1],
      slot: b[2],
      isCrit: b[3] === 1,
      bulletType: b[4] === 2 ? "missile" : b[4] === 1 ? "sniper" : "main",
      r: b[4] === 2 ? 5 : b[4] === 1 ? 4 : 2.5
    }));
    
    const players = (msg.p || []).map(p => ({
      id: p.id,
      slot: p.s,
      name: p.n,
      score: p.sc,
      gold: p.g,
      hp: p.hp,
      maxHp: p.mhp,
      turretAngle: p.ta,
      isManual: p.im === 1,
      towers: p.tw,
      kills: p.k,
      damageDealt: p.dd,
      waveDamage: p.wd,
      lastInterest: p.li,
      upgrades: {
        shieldActive: p.u?.sa ?? 0,
        slowfield: p.u?.sf === 1,
        damageAdd: p.u?.da ?? 0,
        bulletSpeedMult: p.u?.bsm ?? 1,
        fireRateMult: p.u?.frm ?? 1,
        multishot: p.u?.ms ?? 1,
        multishotDmgMult: p.u?.msdm ?? 1,
        critChance: p.u?.cc ?? 0,
        explosive: p.u?.ex ?? 0,
        lifespanAdd: p.u?.la ?? 0,
        ricochet: p.u?.ri ?? 0,
        pierce: p.u?.pi ?? 0,
        chain: p.u?.ch === 1,
        goldMult: p.u?.gm ?? 1,
      }
    }));
    
    return {
      t: "state",
      ts: msg.ts,
      phase: msg.phase,
      wave: msg.wave,
      missiles,
      bullets,
      players,
      // Particles and damageNumbers are now client-side
      particles: [],
      damageNumbers: []
    };
  }

  // Clean up old asteroid shapes
  function cleanupAsteroidShapes(currentIds) {
    const currentSet = new Set(currentIds);
    for (const id of asteroidShapes.keys()) {
      if (!currentSet.has(id)) {
        asteroidShapes.delete(id);
      }
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

  // ===== Networking =====
  function connect() {
    forcedDisconnect = false;
    if (statusText) statusText.textContent = "CONNECTING...";
    if (statusLED) statusLED.className = "led";

    if (ws) try { ws.close(); } catch { }

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
        if (msg.attackTypes) {
          for (const [key, val] of Object.entries(msg.attackTypes)) {
            if (ATTACK_TYPES[key]) {
              ATTACK_TYPES[key].cost = val.cost;
              ATTACK_TYPES[key].desc = val.desc || ATTACK_TYPES[key].desc;
            }
          }
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
          gameOverData = null;
          wave = 0;
          buildMenuOpen = null;
          hoveredAttack = null;
          // Clear client-side state
          particles = [];
          damageNumbers = [];
          asteroidShapes.clear();
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
        // Clear client-side state for new game
        particles = [];
        damageNumbers = [];
        asteroidShapes.clear();
        showGame();
        break;

      case "wave":
        wave = msg.wave;
        buildMenuOpen = null;
        incomingAttacks = [];
        screenShake = 10;
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
        attackHitFeedback = { gold: msg.gold, target: msg.target, time: Date.now() };
        break;

      case "interest":
        interestFeedback = { amount: msg.amount, time: Date.now() };
        break;

      case "attackRefund":
        refundFeedback = { gold: msg.gold, reason: msg.reason, time: Date.now() };
        break;

      case "state":
        // OPTIMIZED: Parse compact state format
        if (msg.m !== undefined) {
          // New compact format
          lastSnap = parseCompactState(msg);
          // Process events for client-side effects
          processEvents(msg.ev);
          // Cleanup old asteroid shapes
          if (lastSnap.missiles) {
            cleanupAsteroidShapes(lastSnap.missiles.map(m => m.id));
          }
        } else {
          // Old format (backwards compatibility)
          lastSnap = msg;
        }
        phase = lastSnap.phase;
        wave = lastSnap.wave;
        if (lastSnap.world) {
          world = lastSnap.world;
        }
        break;

      case "attackQueued":
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
    const me = lobbyPlayers.find(p => p.id === myId);
    readyBtn.textContent = me?.ready ? "✓ READY" : "READY UP";
    readyBtn.className = "btn" + (me?.ready ? " ready" : "");
    
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
  
  if (clearLeaderboardBtn) {
    clearLeaderboardBtn.addEventListener("click", () => {
      const password = prompt("Enter password to clear leaderboard:");
      if (password) {
        send({ t: "clearLeaderboard", password: password });
      }
    });
  }

  // ===== Chat System =====
  function updateChatUI() {
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
      if (lobbyChatInput) {
        sendChatMessage(lobbyChatInput.value);
        lobbyChatInput.value = "";
      }
    });
  }

  // ===== Canvas & Rendering =====
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // Mouse/touch input
  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    if (e.touches) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("mousemove", (e) => {
    const pos = getMousePos(e);
    mouseX = pos.x;
    mouseY = pos.y;
  });

  canvas.addEventListener("mousedown", (e) => {
    mouseDown = true;
    handleClick(e);
  });

  canvas.addEventListener("mouseup", () => {
    mouseDown = false;
  });

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const pos = getMousePos(e);
    mouseX = pos.x;
    mouseY = pos.y;
    mouseDown = true;
    handleClick(e);
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const pos = getMousePos(e);
    mouseX = pos.x;
    mouseY = pos.y;
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    mouseDown = false;
  });

  function handleClick(e) {
    // Handle upgrade card clicks
    if (upgradeOptions.length > 0 && !upgradePicked && hoveredUpgrade >= 0) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) {
        send({ t: "pickUpgrade", key: opt.key });
      }
      return;
    }

    // Handle reroll button
    if (hoveredReroll && upgradeOptions.length > 0) {
      send({ t: "rerollUpgrades" });
      return;
    }

    // Handle buy upgrade button
    if (hoveredBuyUpgrade && window.buyUpgradeBtnBounds) {
      send({ t: "buyUpgrade", cost: buyUpgradeCost });
      return;
    }

    // Handle attack panel clicks
    if (hoveredAttack) {
      send({ t: "buyAttack", attackType: hoveredAttack, quantity: attackQuantityMode });
      hoveredAttack = null;
      return;
    }

    // Handle quantity button clicks
    if (hoveredQuantityBtn !== null) {
      attackQuantityMode = hoveredQuantityBtn;
      return;
    }

    // Handle build menu
    if (buildMenuOpen && hoveredBuildOption >= 0) {
      const { slotIndex, hasTower, tower } = buildMenuOpen;
      if (hasTower && tower) {
        if (hoveredBuildOption === 0) {
          send({ t: "upgradeTower", slotIndex });
        } else if (hoveredBuildOption === 1) {
          send({ t: "sellTower", slotIndex });
        }
      } else {
        send({ t: "buyTower", slotIndex, type: hoveredBuildOption });
      }
      buildMenuOpen = null;
      return;
    }

    // Handle stats toggle
    if (hoveredStatsBtn) {
      statsPanelOpen = !statsPanelOpen;
      return;
    }

    // Handle damage number toggle
    if (window.dmgToggleBounds) {
      const b = window.dmgToggleBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        showDamageNumbers = !showDamageNumbers;
        localStorage.setItem("rogueAsteroidDmgNumbers", showDamageNumbers.toString());
        return;
      }
    }

    // Handle graphics toggle
    if (window.gfxToggleBounds) {
      const b = window.gfxToggleBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        lowPerformanceMode = !lowPerformanceMode;
        localStorage.setItem("rogueAsteroidLowPerf", lowPerformanceMode.toString());
        return;
      }
    }

    // Handle chat button
    if (window.gameChatBtnBounds) {
      const b = window.gameChatBtnBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        toggleGameChat();
        return;
      }
    }

    // Handle chat close
    if (chatOpen && window.gameChatCloseBounds) {
      const b = window.gameChatCloseBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        chatOpen = false;
        return;
      }
    }

    // Handle game over button
    if (phase === "gameover" && gameOverData?.menuBtnBounds) {
      const b = gameOverData.menuBtnBounds;
      if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
        send({ t: "returnToLobby" });
        return;
      }
    }

    // Check tower slot clicks
    if (phase === "playing" && lastSnap) {
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      if (myPlayer && myPlayer.hp > 0) {
        const sx = canvas.width / world.width;
        const sy = canvas.height / world.height;
        const cx = (myPlayer.slot * world.segmentWidth + world.segmentWidth / 2) * sx;
        const offsets = [-110, -50, 50, 110];
        
        for (let i = 0; i < 4; i++) {
          const tx = cx + offsets[i] * sx;
          const ty = 560 * sy;
          const dist = Math.hypot(mouseX - tx, mouseY - ty);
          if (dist < 25 * sx) {
            const tower = myPlayer.towers?.[i];
            buildMenuOpen = {
              x: tx, y: ty - 40 * sy,
              slotIndex: i,
              hasTower: !!tower,
              tower: tower
            };
            return;
          }
        }
      }
    }

    // Close menus on click elsewhere
    buildMenuOpen = null;
  }

  // Keyboard input
  document.addEventListener("keydown", (e) => {
    if (chatInputFocused) return;
    
    // T to open/focus chat
    if (e.key === "t" || e.key === "T") {
      if (phase === "playing" || phase === "upgrades") {
        if (!chatOpen) {
          toggleGameChat();
        }
        e.preventDefault();
      }
    }
    
    // Escape to close menus
    if (e.key === "Escape") {
      buildMenuOpen = null;
      chatOpen = false;
      statsPanelOpen = false;
    }
    
    // Enter to send chat
    if (e.key === "Enter" && chatOpen && gameChatInputText.trim()) {
      sendChatMessage(gameChatInputText);
      gameChatInputText = "";
    }
  });

  // In-game chat input
  document.addEventListener("keypress", (e) => {
    if (chatOpen && phase !== "lobby" && phase !== "menu") {
      if (e.key !== "Enter") {
        gameChatInputText += e.key;
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (chatOpen && e.key === "Backspace") {
      gameChatInputText = gameChatInputText.slice(0, -1);
      e.preventDefault();
    }
  });

  // Helper to draw neon text
  function drawNeonText(text, x, y, color, size, align = "left") {
    ctx.font = `bold ${size}px 'Orbitron', sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    if (!lowPerformanceMode) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 15;
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
  }

  // Draw bullet with style
  function drawBullet(b, sx, sy, color) {
    const x = b.x * sx;
    const y = b.y * sy;
    const r = (b.r || 2.5) * sx;
    
    if (lowPerformanceMode) {
      ctx.fillStyle = b.isCrit ? "#ff0" : color;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = b.isCrit ? "#ff0" : color;
      setShadow(ctx, b.isCrit ? "#ff0" : color, b.isCrit ? 12 : 6);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      clearShadow(ctx);
    }
  }

  // Draw section panel helper
  function drawSectionPanel(x, y, w, h, borderColor, title, titleColor) {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, "rgba(10,17,40,0.92)");
    grad.addColorStop(1, "rgba(15,25,50,0.92)");
    ctx.fillStyle = grad;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();
    
    ctx.font = "bold 11px 'Orbitron', sans-serif";
    ctx.fillStyle = titleColor;
    ctx.textAlign = "center";
    ctx.fillText(title, x + w / 2, y + 20);
  }

  // Draw player damage row
  function drawPlayerDamageRow(p, y, damage, maxDamage, totalDamage, isTop, panelX, panelW) {
    const color = PLAYER_COLORS[p.slot]?.main || "#fff";
    const pct = totalDamage > 0 ? (damage / totalDamage * 100) : 0;
    const barPct = maxDamage > 0 ? (damage / maxDamage) : 0;
    
    // Player color dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(panelX + 20, y + 15, 6, 0, Math.PI * 2);
    ctx.fill();
    
    // Name
    ctx.font = "bold 11px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = isTop ? "#ffd700" : "#fff";
    ctx.fillText(p.name.slice(0, 10), panelX + 32, y + 12);
    
    // Damage bar background
    const barX = panelX + 32;
    const barY = y + 18;
    const barW = panelW - 52;
    const barH = 10;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(barX, barY, barW, barH);
    
    // Damage bar fill
    ctx.fillStyle = hexToRgba(color, 0.7);
    ctx.fillRect(barX, barY, barW * barPct, barH);
    
    // Damage value
    ctx.font = "10px 'Courier New', monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#aaa";
    ctx.fillText(`${Math.round(damage)} (${pct.toFixed(1)}%)`, panelX + panelW - 10, y + 12);
  }

  // Main draw loop
  let lastTime = performance.now();
  
  function draw() {
    requestAnimationFrame(draw);
    
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    
    time += dt;
    checkPerformance();
    
    // OPTIMIZED: Update client-side particles
    updateParticles(dt);
    
    // Screen shake decay
    screenShake *= 0.9;
    if (screenShake < 0.1) screenShake = 0;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate scale and offset
    const sx = canvas.width / world.width;
    const sy = canvas.height / world.height;
    
    let offsetX = 0, offsetY = 0;
    if (screenShake > 0) {
      offsetX = (Math.random() - 0.5) * screenShake * 2;
      offsetY = (Math.random() - 0.5) * screenShake * 2;
    }

    ctx.save();
    ctx.translate(offsetX, offsetY);

    // Draw background
    ctx.fillStyle = "#050510";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Stars
    if (!lowPerformanceMode) {
      for (const star of stars) {
        const twinkle = Math.sin(time * 2 + star.twinkle) * 0.3 + 0.7;
        ctx.fillStyle = `rgba(255,255,255,${twinkle * 0.8})`;
        ctx.beginPath();
        ctx.arc(star.x * canvas.width, star.y * canvas.height, star.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Send input
    if (phase === "playing" && mouseDown && !buildMenuOpen) {
      const worldX = (mouseX - offsetX) / sx;
      const worldY = (mouseY - offsetY) / sy;
      send({ t: "input", x: worldX, y: worldY, shooting: true });
    } else if (phase === "playing") {
      send({ t: "input", x: 0, y: 0, shooting: false });
    }

    // Render game state
    if (lastSnap && (phase === "playing" || phase === "upgrades" || phase === "gameover")) {
      try {
        const myPlayer = lastSnap.players.find(p => p.id === myId);

        // Draw player segments
        for (const p of lastSnap.players) {
          if (p.slot < 0) continue;
          const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
          const segX = p.slot * world.segmentWidth * sx;
          const segW = world.segmentWidth * sx;

          // Segment background
          ctx.fillStyle = hexToRgba(color.dark, 0.15);
          ctx.fillRect(segX, 0, segW, canvas.height);

          // Segment border
          ctx.strokeStyle = hexToRgba(color.main, 0.3);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(segX + segW, 0);
          ctx.lineTo(segX + segW, canvas.height);
          ctx.stroke();

          // Ground line
          ctx.strokeStyle = color.main;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(segX, 560 * sy);
          ctx.lineTo(segX + segW, 560 * sy);
          ctx.stroke();

          // Player name and HP
          const cx = segX + segW / 2;
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = p.hp <= 0 ? "#666" : color.main;
          ctx.fillText(p.name, cx, 20);

          // HP bar
          const hpW = 80 * sx;
          const hpH = 8 * sy;
          const hpX = cx - hpW / 2;
          const hpY = 28;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(hpX, hpY, hpW, hpH);
          const hpPct = Math.max(0, p.hp / p.maxHp);
          ctx.fillStyle = hpPct > 0.5 ? "#0f8" : hpPct > 0.25 ? "#fa0" : "#f44";
          ctx.fillRect(hpX, hpY, hpW * hpPct, hpH);
          ctx.font = "bold 10px 'Courier New', monospace";
          ctx.fillStyle = "#fff";
          ctx.fillText(`${p.hp}/${p.maxHp}`, cx, hpY + hpH + 12);

          // Gold display for current player
          if (p.id === myId) {
            ctx.font = "bold 16px 'Courier New', monospace";
            ctx.fillStyle = "#ffd700";
            ctx.fillText(`💰 ${p.gold}`, cx, hpY + hpH + 30);
          }
        }

        // OPTIMIZED: Draw client-side particles
        for (const p of particles) {
          const alpha = p.life / p.maxLife;
          ctx.fillStyle = hexToRgba(p.color, alpha);
          if (lowPerformanceMode) {
            ctx.fillRect(p.x * sx - 1, p.y * sy - 1, 2, 2);
          } else {
            ctx.beginPath();
            ctx.arc(p.x * sx, p.y * sy, (p.size || 2) * sx, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Draw asteroids
        for (const m of lastSnap.missiles) {
          const x = m.x * sx;
          const y = m.y * sy;
          const r = m.r * sx;

          let baseColor = m.type === "large" ? "#ff4444" : m.type === "medium" ? "#ff8800" : "#ffcc00";
          if (m.attackType && ATTACK_TYPES[m.attackType]) {
            baseColor = ATTACK_TYPES[m.attackType].color;
          }

          // FTL effect
          if (m.inFTL) {
            if (lowPerformanceMode) {
              ctx.fillStyle = baseColor;
              ctx.fillRect(x - r, y - r * 3, r * 2, r * 4);
              ctx.fillStyle = "#fff";
              ctx.fillRect(x - r/2, y - r * 2, r, r * 3);
            } else {
              ctx.save();
              const streakLength = 80 * sy;
              for (let i = 0; i < 5; i++) {
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
              setShadow(ctx, "#aaccff", 25);
              ctx.translate(x, y);
              ctx.scale(1, 2.5);
              ctx.rotate(m.rotation || 0);
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
            }
            continue;
          }

          const phaseAlpha = m.isPhased ? 0.3 : 0.7;

          if (lowPerformanceMode) {
            ctx.fillStyle = hexToRgba(baseColor, phaseAlpha);
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
            if (m.hp < m.maxHp) {
              const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
              ctx.fillStyle = "rgba(0,0,0,0.6)";
              ctx.fillRect(bx, by, bw, bh);
              ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
              ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
            }
          } else {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(m.rotation || 0);
            ctx.fillStyle = hexToRgba(baseColor, phaseAlpha);
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = 1.5;
            setShadow(ctx, baseColor, 8);

            if (m.vertices && m.vertices.length > 0) {
              ctx.beginPath();
              for (let i = 0; i <= m.vertices.length; i++) {
                const v = m.vertices[i % m.vertices.length];
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
            ctx.restore();
            clearShadow(ctx);

            if (m.hp < m.maxHp) {
              const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
              ctx.fillStyle = "rgba(0,0,0,0.6)";
              ctx.fillRect(bx, by, bw, bh);
              ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
              ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
            }
          }

          // Attack type indicator
          if (!lowPerformanceMode && m.attackType && ATTACK_TYPES[m.attackType]) {
            ctx.font = `${10 * sx}px sans-serif`;
            ctx.textAlign = "center";
            ctx.fillStyle = "#fff";
            ctx.fillText(ATTACK_TYPES[m.attackType].icon, x, y + r + 12 * sy);
          }
        }

        // Draw bullets
        for (const b of lastSnap.bullets) {
          const baseColor = PLAYER_COLORS[b.slot]?.main || "#0ff";
          drawBullet(b, sx, sy, baseColor);
        }

        // OPTIMIZED: Draw client-side damage numbers
        if (showDamageNumbers) {
          for (const d of damageNumbers) {
            if (lowPerformanceMode && !d.isCrit && d.amount < 10) continue;
            ctx.font = `bold ${d.isCrit ? 16 : 12}px 'Courier New', monospace`;
            ctx.textAlign = "center";
            ctx.fillStyle = d.isCrit ? `rgba(255,255,0,${d.life})` : `rgba(255,255,255,${d.life})`;
            const rounded = Math.round(d.amount * 100) / 100;
            const displayText = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, '');
            ctx.fillText(displayText, d.x * sx, d.y * sy);
          }
        }

        // Draw turrets and towers (simplified for brevity - keeping core functionality)
        for (const p of lastSnap.players) {
          if (p.slot < 0) continue;
          const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
          const cx = (p.slot * world.segmentWidth + world.segmentWidth / 2) * sx;
          const isDead = p.hp <= 0;

          // Main turret
          const turretAlpha = isDead ? 0.3 : 0.8;
          const baseW = 24 * sx;
          const baseH = 14 * sy;
          ctx.fillStyle = hexToRgba(color.main, turretAlpha);
          ctx.strokeStyle = color.main;
          ctx.lineWidth = 1.5;
          if (!isDead && !lowPerformanceMode) setShadow(ctx, color.main, 15);
          ctx.beginPath();
          ctx.roundRect(cx - baseW / 2, 560 * sy - baseH, baseW, baseH, 3);
          ctx.fill();
          if (!lowPerformanceMode) ctx.stroke();
          ctx.save();
          ctx.translate(cx, 560 * sy - baseH / 2);
          ctx.rotate(p.turretAngle + Math.PI / 2);
          ctx.fillStyle = hexToRgba(color.main, turretAlpha);
          ctx.fillRect(-2.5 * sx, -22 * sy, 5 * sx, 22 * sy);
          ctx.restore();
          clearShadow(ctx);

          // Tower slots (simplified)
          const offsets = [-110, -50, 50, 110];
          const towers = p.towers || [null, null, null, null];
          towers.forEach((t, i) => {
            const tx = cx + offsets[i] * sx;
            const ty = 560 * sy;
            if (t) {
              const typeInfo = TOWER_TYPES[t.type];
              if (typeInfo) {
                const tColor = typeInfo.color || "#fff";
                ctx.fillStyle = hexToRgba(tColor, isDead ? 0.3 : 1);
                ctx.fillRect(tx - 10 * sx, ty - 25 * sy, 20 * sx, 25 * sy);
                if (t.level > 1) {
                  ctx.fillStyle = "#ffd700";
                  ctx.font = `bold ${8 * sx}px sans-serif`;
                  ctx.textAlign = "center";
                  ctx.fillText("★".repeat(Math.min(t.level - 1, 4)), tx, ty + 8 * sy);
                }
              }
            } else if (p.id === myId && !isDead) {
              ctx.strokeStyle = "rgba(0, 255, 136, 0.4)";
              ctx.lineWidth = 2;
              ctx.setLineDash([4, 4]);
              ctx.strokeRect(tx - 12 * sx, ty - 25 * sy, 24 * sx, 25 * sy);
              ctx.setLineDash([]);
            }
          });
        }

        // HUD elements
        ctx.font = "bold 16px 'Orbitron', sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = "#0ff";
        ctx.fillText(`WAVE ${wave}`, 15, 30);

        if (myPlayer) {
          ctx.fillStyle = "#ffd700";
          ctx.fillText(`SCORE: ${myPlayer.score}`, 15, 55);
        }

        // Upgrade cards (simplified display)
        if (upgradeOptions.length > 0 && !upgradePicked) {
          const cardW = 160;
          const cardH = 200;
          const gap = 20;
          const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * gap;
          const startX = (canvas.width - totalW) / 2;
          const startY = (canvas.height - cardH) / 2;

          hoveredUpgrade = -1;

          for (let i = 0; i < upgradeOptions.length; i++) {
            const opt = upgradeOptions[i];
            const x = startX + i * (cardW + gap);
            const y = startY;

            const isHovered = mouseX >= x && mouseX <= x + cardW && mouseY >= y && mouseY <= y + cardH;
            if (isHovered) hoveredUpgrade = i;

            // Card background
            ctx.fillStyle = isHovered ? "rgba(30,40,60,0.95)" : "rgba(20,25,40,0.9)";
            ctx.strokeStyle = opt.rarityColor || "#fff";
            ctx.lineWidth = isHovered ? 3 : 2;
            ctx.beginPath();
            ctx.roundRect(x, y, cardW, cardH, 10);
            ctx.fill();
            ctx.stroke();

            // Rarity label
            ctx.font = "bold 10px 'Orbitron', sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = opt.rarityColor || "#fff";
            ctx.fillText(opt.rarityLabel || "COMMON", x + cardW / 2, y + 20);

            // Icon
            ctx.font = "32px sans-serif";
            ctx.fillText(opt.icon || "?", x + cardW / 2, y + 60);

            // Title
            ctx.font = "bold 12px 'Courier New', monospace";
            ctx.fillStyle = "#fff";
            ctx.fillText(opt.title || "Upgrade", x + cardW / 2, y + 100);

            // Description
            ctx.font = "11px 'Courier New', monospace";
            ctx.fillStyle = "#aaa";
            const words = (opt.desc || "").split(" ");
            let line = "";
            let lineY = y + 125;
            for (const word of words) {
              const test = line + word + " ";
              if (ctx.measureText(test).width > cardW - 20) {
                ctx.fillText(line, x + cardW / 2, lineY);
                line = word + " ";
                lineY += 14;
              } else {
                line = test;
              }
            }
            ctx.fillText(line, x + cardW / 2, lineY);
          }

          // Reroll button
          const rerollY = startY + cardH + 20;
          const rerollW = 120;
          const rerollH = 35;
          const rerollX = canvas.width / 2 - rerollW / 2;

          hoveredReroll = mouseX >= rerollX && mouseX <= rerollX + rerollW && 
                          mouseY >= rerollY && mouseY <= rerollY + rerollH;

          ctx.fillStyle = hoveredReroll ? "rgba(255,170,0,0.4)" : "rgba(255,170,0,0.2)";
          ctx.strokeStyle = "#fa0";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(rerollX, rerollY, rerollW, rerollH, 6);
          ctx.fill();
          ctx.stroke();

          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fa0";
          ctx.fillText(`🎲 REROLL (${currentRerollCost}g)`, canvas.width / 2, rerollY + 22);
        }

        // Game over screen
        if (phase === "gameover" && gameOverData) {
          ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const winner = gameOverData.scores.find(s => s.isWinner);
          if (winner) {
            drawNeonText(`🏆 ${winner.name} WINS!`, canvas.width / 2, 100, "#ffd700", 36, "center");
          } else {
            drawNeonText("GAME OVER", canvas.width / 2, 100, "#f44", 36, "center");
          }

          drawNeonText(`Wave ${gameOverData.wave}`, canvas.width / 2, 160, "#0ff", 18, "center");

          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.textAlign = "center";
          gameOverData.scores.forEach((s, i) => {
            const color = PLAYER_COLORS[s.slot]?.main || "#fff";
            const y = 200 + i * 30;
            ctx.fillStyle = s.isWinner ? "#ffd700" : color;
            ctx.fillText(`${i + 1}. ${s.name} - ${s.score} pts (${s.kills} kills)`, canvas.width / 2, y);
          });

          // Return to menu button
          const btnW = 200;
          const btnH = 50;
          const btnX = canvas.width / 2 - btnW / 2;
          const btnY = canvas.height - 120;
          const isHovered = mouseX >= btnX && mouseX <= btnX + btnW && mouseY >= btnY && mouseY <= btnY + btnH;

          ctx.fillStyle = isHovered ? "rgba(0,255,136,0.3)" : "rgba(0,255,136,0.1)";
          ctx.strokeStyle = isHovered ? "#0f8" : "rgba(0,255,136,0.5)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnW, btnH, 8);
          ctx.fill();
          ctx.stroke();

          ctx.font = "bold 16px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = isHovered ? "#fff" : "#0f8";
          ctx.fillText("RETURN TO MENU", canvas.width / 2, btnY + btnH / 2);

          gameOverData.menuBtnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
        }

      } catch (err) {
        console.error('Draw error:', err);
      }
    }

    ctx.restore();
  }

  // Auto-connect
  connect();
  draw();

  nameInput.addEventListener("input", debounce(() => {
    const name = nameInput.value.trim();
    if (name) {
      localStorage.setItem("rogueAsteroidPlayerName", name);
    }
    if (connected && name) {
      send({ t: "setName", name });
    }
  }, 300));

  readyBtn.onclick = () => { send({ t: "ready" }); };
  launchBtn.onclick = () => { 
    const me = lobbyPlayers.find(p => p.id === myId);
    if (!me?.ready) return;
    
    if (allReady) {
      send({ t: "start" });
    } else if (readyCount >= 1) {
      send({ t: "forceStart" });
    }
  };

  // Performance toggle button
  const perfToggleBtn = document.getElementById("perfToggleBtn");
  function updatePerfButton() {
    if (perfToggleBtn) {
      perfToggleBtn.textContent = lowPerformanceMode ? "🎮 GRAPHICS: LOW" : "🎮 GRAPHICS: HIGH";
      perfToggleBtn.style.background = lowPerformanceMode ? "#553300" : "#003355";
    }
  }
  updatePerfButton();
  
  if (perfToggleBtn) {
    perfToggleBtn.onclick = () => {
      lowPerformanceMode = !lowPerformanceMode;
      localStorage.setItem("rogueAsteroidLowPerf", lowPerformanceMode.toString());
      updatePerfButton();
    };
  }
})();
