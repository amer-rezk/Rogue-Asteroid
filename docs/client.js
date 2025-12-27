(() => {
  // ===== Configuration =====
  const DEFAULT_SERVER = "wss://rogue-asteroid.onrender.com/ws";

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
    swarm: { name: "Swarm", cost: 15, desc: "4 fast weak", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 45, desc: "Very tanky", color: "#ff4444", icon: "🪨" },
    bomber: { name: "Bomber", cost: 55, desc: "Explodes!", color: "#ff00ff", icon: "💣" },
    splitter: { name: "Splitter", cost: 50, desc: "Splits x4", color: "#00ffff", icon: "💎" },
    ghost: { name: "Ghost", cost: 40, desc: "Phases", color: "#8800ff", icon: "👻" }
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
  let leaderboard = [];
  let lastSnap = null;
  let upgradeOptions = [];
  let upgradePicked = false;
  let upgradeDeadline = 0;
  let waitingFor = [];
  let gameOverData = null;

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

  // Upgrade reroll
  let currentRerollCost = 10;
  let hoveredReroll = false;

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

    console.log("[CLIENT] Attempting to connect to:", DEFAULT_SERVER);

    if (ws) {
      console.log("[CLIENT] Closing existing WebSocket");
      try { ws.close(); } catch { }
    }

    try {
      ws = new WebSocket(DEFAULT_SERVER);
      console.log("[CLIENT] WebSocket created, readyState:", ws.readyState);
    } catch (err) {
      console.error("[CLIENT] WebSocket creation failed:", err);
      return;
    }

    ws.onopen = () => {
      console.log("[CLIENT] WebSocket OPEN, readyState:", ws.readyState);
      connected = true;
      if (statusText) {
        statusText.textContent = "ONLINE";
        statusText.className = "status-text connected";
      }
      if (statusLED) statusLED.className = "led green";

      lobbyEl.style.display = "block";

      const name = nameInput.value.trim() || `Player`;
      console.log("[CLIENT] Sending setName:", name);
      if (name) ws.send(JSON.stringify({ t: "setName", name }));
    };

    ws.onclose = (event) => {
      console.log("[CLIENT] WebSocket CLOSED, code:", event.code, "reason:", event.reason, "wasClean:", event.wasClean);
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

    ws.onerror = (err) => {
      console.error("[CLIENT] WebSocket ERROR:", err);
      if (statusText) statusText.textContent = "ERROR";
      if (statusLED) statusLED.className = "led red";
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t !== "state") {
        console.log("[CLIENT] Received message:", msg.t, msg);
      }
      handleMessage(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    } else {
      console.warn("[CLIENT] Cannot send, WebSocket not ready. readyState:", ws?.readyState);
    }
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case "welcome":
        myId = msg.id;
        mySlot = msg.slot;
        isHost = msg.isHost;
        world = msg.world;
        phase = "lobby";
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

      case "lobby":
        lobbyPlayers = msg.players;
        allReady = msg.allReady;
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
        showGame();
        break;

      case "wave":
        wave = msg.wave;
        upgradeOptions = [];
        upgradePicked = false;
        buildMenuOpen = null;
        incomingAttacks = [];
        screenShake = 10;
        break;

      case "upgrade":
        upgradeOptions = msg.options;
        upgradePicked = false;
        buildMenuOpen = null;
        if (msg.deadline) upgradeDeadline = msg.deadline;
        if (msg.rerollCost !== undefined) currentRerollCost = msg.rerollCost;
        break;

      case "upgradePhase":
        phase = "upgrades";
        if (msg.deadline) upgradeDeadline = msg.deadline;
        break;

      case "picked":
        upgradePicked = true;
        if (msg.auto) {
          // Show feedback that upgrade was auto-picked
        }
        break;

      case "upgradeWaiting":
        waitingFor = msg.waiting;
        break;

      case "state":
        lastSnap = msg;
        phase = msg.phase;
        wave = msg.wave;
        world = msg.world;
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
    // Any ready player can launch the game when all are ready
    launchBtn.style.display = me?.ready ? "block" : "none";
    launchBtn.disabled = !allReady;
    launchBtn.className = "btn launch" + (allReady ? "" : " disabled");
    
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

  function handleClick() {
    // Handle game over return to menu button
    if (phase === "gameover" && gameOverData && gameOverData.menuBtnBounds) {
      const btn = gameOverData.menuBtnBounds;
      if (mouseX >= btn.x && mouseX <= btn.x + btn.w && mouseY >= btn.y && mouseY <= btn.y + btn.h) {
        send({ t: "returnToLobby" });
        return;
      }
    }
    
    if (phase === "upgrades" && hoveredUpgrade >= 0 && !upgradePicked) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) send({ t: "pickUpgrade", key: opt.key });
      return;
    }

    // Handle reroll button click
    if (phase === "upgrades" && hoveredReroll && !upgradePicked) {
      const myPlayer = lastSnap?.players.find(p => p.id === myId);
      if (myPlayer && myPlayer.gold >= currentRerollCost) {
        send({ t: "rerollUpgrades" });
      }
      return;
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
      } else {
        buildMenuOpen = null;
        return;
      }
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
    if (phase !== "playing" || !lastSnap) return;
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

    switch (b.bulletType) {
      case "gatling":
        // Gatling: Small yellow tracer
        const gatlingTrail = 8 * sx;
        ctx.strokeStyle = `rgba(255,255,0,${0.6 * alpha})`;
        ctx.lineWidth = r * 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * gatlingTrail, y - Math.sin(angle) * gatlingTrail);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,100,${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
        break;

      case "sniper":
        // Sniper: Green laser beam
        const laserLen = 30 * sx;
        ctx.strokeStyle = `rgba(0,255,0,${0.3 * alpha})`;
        ctx.lineWidth = r * 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();
        ctx.strokeStyle = `rgba(150,255,150,${0.9 * alpha})`;
        ctx.lineWidth = r * 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * laserLen, y - Math.sin(angle) * laserLen);
        ctx.stroke();
        break;

      case "missile":
        // Missile: Red rocket with simple fire trail
        const missileLen = 10 * sx;
        const missileWidth = r * 1.2;

        // Simple fire trail (2 particles instead of 5 smoke)
        ctx.fillStyle = `rgba(255,100,0,${0.5 * alpha})`;
        ctx.beginPath();
        ctx.arc(x - Math.cos(angle) * missileLen, y - Math.sin(angle) * missileLen, r * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,200,0,${0.4 * alpha})`;
        ctx.beginPath();
        ctx.arc(x - Math.cos(angle) * missileLen * 1.5, y - Math.sin(angle) * missileLen * 1.5, r, 0, Math.PI * 2);
        ctx.fill();

        // Missile body - simple ellipse
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = `rgba(255,80,80,${alpha})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, missileLen, missileWidth, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,200,200,${alpha})`;
        ctx.beginPath();
        ctx.arc(missileLen * 0.6, 0, missileWidth * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;

      default:
        // Main turret: Player-colored energy bolt
        const trail = 10 * sx;
        const color = b.isCrit ? "#ffffff" : baseColor;

        // Simple trail
        ctx.strokeStyle = hexToRgba(color, 0.4 * alpha);
        ctx.lineWidth = r * 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * trail, y - Math.sin(angle) * trail);
        ctx.stroke();

        // Bullet body with glow effect (layered circles instead of shadow)
        ctx.fillStyle = hexToRgba(color, 0.3 * alpha);
        ctx.beginPath();
        ctx.arc(x, y, r * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        if (b.isCrit) {
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
    }
  }

  function draw() {
    requestAnimationFrame(draw);

    try {
      const dt = 1 / 60;
      time += dt;
      screenShake *= 0.92;

      ctx.fillStyle = "#050510";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const s of stars) {
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
        ctx.shadowColor = "#a000ff";
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, world.height * sy);
        ctx.stroke();
        ctx.shadowBlur = 0;
        
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
      ctx.shadowColor = "#0ff";
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(world.width * sx, groundY);
      ctx.stroke();
      ctx.shadowBlur = 0;

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

      // Particles - batch by type for performance
      if (lastSnap.particles) {
        // First pass: explosion rings (draw these prominently)
        for (const p of lastSnap.particles) {
          if (!p.isExplosionRing) continue;
          const alpha = p.life / (p.maxLife || 0.5);
          const radius = (p.size || 30) * sx * (1 + (1 - alpha) * 0.5);
          // Filled transparent circle
          ctx.fillStyle = `rgba(255,100,0,${alpha * 0.25})`;
          ctx.beginPath();
          ctx.arc(p.x * sx, p.y * sy, radius, 0, Math.PI * 2);
          ctx.fill();
          // Bright ring outline
          ctx.strokeStyle = `rgba(255,150,50,${alpha * 0.9})`;
          ctx.lineWidth = 3 * sx;
          ctx.stroke();
          // Inner bright ring
          ctx.strokeStyle = `rgba(255,220,100,${alpha * 0.7})`;
          ctx.lineWidth = 1.5 * sx;
          ctx.beginPath();
          ctx.arc(p.x * sx, p.y * sy, radius * 0.7, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Second pass: regular particles
        ctx.lineCap = "round";
        for (const p of lastSnap.particles) {
          if (p.isExplosionRing) continue;
          const alpha = p.life / (p.maxLife || 0.5);
          ctx.fillStyle = hexToRgba(p.color, alpha);
          ctx.beginPath();
          ctx.arc(p.x * sx, p.y * sy, (p.size || 2) * sx, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Asteroids/Missiles
      for (const m of lastSnap.missiles) {
        const x = m.x * sx;
        const y = m.y * sy;
        const r = m.r * sx;

        // Color based on attack type
        let baseColor = m.type === "large" ? "#ff4444" : m.type === "medium" ? "#ff8800" : "#ffcc00";
        if (m.attackType && ATTACK_TYPES[m.attackType]) {
          baseColor = ATTACK_TYPES[m.attackType].color;
        }

        // FTL entry effect - simplified
        if (m.inFTL) {
          ctx.strokeStyle = "rgba(180, 200, 255, 0.5)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, y - 50 * sy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.fillStyle = "#aaccff";
          ctx.beginPath();
          ctx.ellipse(x, y, r * 0.8, r * 1.8, 0, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }

        // Ghost phasing effect
        const phaseAlpha = m.isPhased ? 0.3 : 0.85;
        const fillColor = hexToRgba(baseColor, phaseAlpha);

        // Draw asteroid - simplified without save/restore for most cases
        if (m.vertices && m.vertices.length > 0) {
          ctx.fillStyle = fillColor;
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const rot = m.rotation || 0;
          for (let i = 0; i <= m.vertices.length; i++) {
            const v = m.vertices[i % m.vertices.length];
            const vAngle = v.angle + rot;
            const px = x + Math.cos(vAngle) * r * v.dist;
            const py = y + Math.sin(vAngle) * r * v.dist;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = fillColor;
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        // HP bar - only if damaged
        if (m.hp < m.maxHp) {
          const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
          ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
        }

        // Attack type indicator - only for attack asteroids
        if (m.attackType && ATTACK_TYPES[m.attackType]) {
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
      if (lastSnap.damageNumbers) {
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
        ctx.lineWidth = 2;
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
      }
      ctx.restore();

      // HUD
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, canvas.width, 50);
      drawNeonText(`WAVE ${wave}`, 20, 25, "#ff0", 18, "left");
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      if (myPlayer) {
        drawNeonText(`${myPlayer.gold} 🟡`, 120, 25, "#fd0", 18, "left");
        drawNeonText(`${myPlayer.kills} 💀`, 210, 25, "#f44", 14, "left");
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
        const panelW = 175;
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
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 10);
          ctx.fill();
          ctx.stroke();
          
          // Title
          if (title) {
            ctx.font = "bold 11px 'Orbitron', sans-serif";
            ctx.fillStyle = titleColor;
            ctx.textAlign = "center";
            ctx.fillText(title, x + w / 2, y + 16);
            
            // Separator line
            ctx.strokeStyle = hexToRgba(borderColor, 0.4);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 10, y + 26);
            ctx.lineTo(x + w - 10, y + 26);
            ctx.stroke();
          }
        }

        // Helper function to draw player damage row (reusable for both meters)
        function drawPlayerDamageRow(p, rowY, damage, maxDamage, totalDamage, isLeader, panelX, panelW) {
          const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
          const barWidth = maxDamage > 0 ? (damage / maxDamage) * (panelW - 48) : 0;
          const percent = totalDamage > 0 ? ((damage / totalDamage) * 100).toFixed(0) : "0";
          const isMe = p.id === myId;
          
          // Highlight row for current player
          if (isMe) {
            ctx.fillStyle = "rgba(122,224,255,0.08)";
            ctx.beginPath();
            ctx.roundRect(panelX + 4, rowY - 2, panelW - 8, 28, 4);
            ctx.fill();
          }
          
          // Player color indicator
          ctx.fillStyle = color.main;
          ctx.shadowColor = color.main;
          ctx.shadowBlur = isLeader ? 8 : 4;
          ctx.beginPath();
          ctx.roundRect(panelX + 8, rowY + 2, 4, 20, 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          
          // Rank / Crown
          ctx.font = "bold 10px sans-serif";
          ctx.textAlign = "left";
          if (isLeader && damage > 0) {
            ctx.fillStyle = "#ffd700";
            ctx.fillText("👑", panelX + 16, rowY + 16);
          }
          
          // Player name
          ctx.font = "bold 9px 'Courier New', monospace";
          ctx.fillStyle = isLeader ? "#ffd700" : "#e8f0ff";
          const displayName = p.name.length > 8 ? p.name.substring(0, 7) + "…" : p.name;
          ctx.fillText(displayName, panelX + (isLeader ? 30 : 18), rowY + 10);
          
          // Damage amount
          ctx.font = "bold 9px 'Courier New', monospace";
          ctx.textAlign = "right";
          ctx.fillStyle = "#91ff7a";
          ctx.fillText(Math.round(damage).toLocaleString(), panelX + panelW - 32, rowY + 10);
          
          // Percentage
          ctx.font = "bold 8px 'Courier New', monospace";
          ctx.fillStyle = isLeader ? "#ffd700" : "#7ae0ff";
          ctx.fillText(percent + "%", panelX + panelW - 8, rowY + 10);
          
          // Damage bar background
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.beginPath();
          ctx.roundRect(panelX + 18, rowY + 16, panelW - 48, 6, 3);
          ctx.fill();
          
          // Damage bar fill
          if (barWidth > 2) {
            const barGrad = ctx.createLinearGradient(panelX + 18, 0, panelX + 18 + barWidth, 0);
            barGrad.addColorStop(0, hexToRgba(color.main, 0.4));
            barGrad.addColorStop(0.5, hexToRgba(color.main, 0.7));
            barGrad.addColorStop(1, color.main);
            ctx.fillStyle = barGrad;
            ctx.beginPath();
            ctx.roundRect(panelX + 18, rowY + 16, barWidth, 6, 3);
            ctx.fill();
            
            // Glow for leader
            if (isLeader) {
              ctx.shadowColor = color.main;
              ctx.shadowBlur = 6;
              ctx.fill();
              ctx.shadowBlur = 0;
            }
            
            // End pip
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.beginPath();
            ctx.arc(panelX + 18 + barWidth - 1, rowY + 19, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          
          ctx.textAlign = "left";
        }

        // ===== ATTACK SPAWN PANEL =====
        if (isAlive) {
          const attackPanelH = 295; // Increased for quantity buttons
          drawSectionPanel(panelX, currentY, panelW, attackPanelH, "rgba(255,68,68,0.5)", "⚔️ SEND ATTACKS", "#ff6666");
          
          // Quantity mode buttons (1x, 10x, MAX)
          const qBtnW = (panelW - 24) / 3;
          const qBtnH = 22;
          const qBtnY = currentY + 32;
          hoveredQuantityBtn = null;
          
          const quantityModes = [1, 10, "max"];
          const quantityLabels = ["1x", "10x", "MAX"];
          
          quantityModes.forEach((mode, i) => {
            const qBtnX = panelX + 6 + i * (qBtnW + 3);
            const isSelected = attackQuantityMode === mode;
            const isHovered = mouseX >= qBtnX && mouseX <= qBtnX + qBtnW && mouseY >= qBtnY && mouseY <= qBtnY + qBtnH;
            
            if (isHovered) hoveredQuantityBtn = mode;
            
            // Button background
            ctx.fillStyle = isSelected ? "rgba(255,100,100,0.4)" : 
                            isHovered ? "rgba(255,100,100,0.25)" : "rgba(40,40,60,0.6)";
            ctx.strokeStyle = isSelected ? "#ff6666" : isHovered ? "#ff8888" : "#444";
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.beginPath();
            ctx.roundRect(qBtnX, qBtnY, qBtnW, qBtnH, 4);
            ctx.fill();
            ctx.stroke();
            
            // Label
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = isSelected ? "#fff" : "#999";
            ctx.fillText(quantityLabels[i], qBtnX + qBtnW / 2, qBtnY + 15);
          });

          // Attack buttons
          const attacks = Object.entries(ATTACK_TYPES);
          const btnH = 36;
          const btnGap = 3;
          const startY = currentY + 62;

          attacks.forEach(([key, atk], i) => {
            const btnY = startY + i * (btnH + btnGap);
            const btnX = panelX + 6;
            const btnW = panelW - 12;
            
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
            ctx.roundRect(btnX, btnY, btnW, btnH, 6);
            ctx.fill();
            ctx.stroke();

            // Icon
            ctx.font = "15px sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(atk.icon, btnX + 6, btnY + 23);

            // Name
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? atk.color : "#444";
            ctx.fillText(atk.name.toUpperCase(), btnX + 28, btnY + 13);

            // Description with count hint
            ctx.font = "8px 'Courier New', monospace";
            ctx.fillStyle = canAfford ? "rgba(255,255,255,0.5)" : "#333";
            let descText = atk.desc;
            if (attackQuantityMode === 10 && affordCount > 0) {
              descText = `×${Math.min(10, affordCount)}`;
            } else if (attackQuantityMode === "max" && affordCount > 0) {
              descText = `×${affordCount}`;
            }
            ctx.fillText(descText, btnX + 28, btnY + 24);

            // Cost (shows total for multi-buy)
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.textAlign = "right";
            ctx.fillStyle = canAfford ? "#ffd700" : "#444";
            const costText = attackQuantityMode === 1 ? `${atk.cost}g` : `${displayCost}g`;
            ctx.fillText(costText, btnX + btnW - 6, btnY + 20);
          });

          ctx.textAlign = "left";
          currentY += attackPanelH + 8;
        }

        // ===== TOTAL RUN DPS PANEL =====
        const playerCount = lastSnap.players.filter(p => p.slot >= 0).length;
        const totalDmgPanelH = 44 + playerCount * 30;
        drawSectionPanel(panelX, currentY, panelW, totalDmgPanelH, "rgba(145,255,122,0.4)", "📊 TOTAL DAMAGE", "#91ff7a");
        
        // Calculate totals for run
        const totalDamage = lastSnap.players.reduce((sum, p) => sum + (p.damageDealt || 0), 0);
        const maxDamage = Math.max(...lastSnap.players.map(p => p.damageDealt || 0), 1);
        
        // Total damage number (centered, big)
        ctx.font = "bold 14px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#91ff7a";
        ctx.shadowColor = "#91ff7a";
        ctx.shadowBlur = 10;
        ctx.fillText(Math.round(totalDamage).toLocaleString(), panelX + panelW / 2, currentY + 38);
        ctx.shadowBlur = 0;
        
        // Sort and draw players
        const sortedByTotal = [...lastSnap.players]
          .filter(p => p.slot >= 0)
          .sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0));
        
        sortedByTotal.forEach((p, i) => {
          const rowY = currentY + 48 + i * 30;
          drawPlayerDamageRow(p, rowY, p.damageDealt || 0, maxDamage, totalDamage, i === 0, panelX, panelW);
        });
        
        currentY += totalDmgPanelH + 8;

        // ===== CURRENT WAVE DPS PANEL =====
        const waveDmgPanelH = 44 + playerCount * 30;
        drawSectionPanel(panelX, currentY, panelW, waveDmgPanelH, "rgba(122,224,255,0.4)", "🌊 WAVE " + wave + " DAMAGE", "#7ae0ff");
        
        // Calculate totals for wave
        const totalWaveDamage = lastSnap.players.reduce((sum, p) => sum + (p.waveDamage || 0), 0);
        const maxWaveDamage = Math.max(...lastSnap.players.map(p => p.waveDamage || 0), 1);
        
        // Wave damage number (centered, big)
        ctx.font = "bold 14px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#7ae0ff";
        ctx.shadowColor = "#7ae0ff";
        ctx.shadowBlur = 10;
        ctx.fillText(Math.round(totalWaveDamage).toLocaleString(), panelX + panelW / 2, currentY + 38);
        ctx.shadowBlur = 0;
        
        // Sort and draw players by wave damage
        const sortedByWave = [...lastSnap.players]
          .filter(p => p.slot >= 0)
          .sort((a, b) => (b.waveDamage || 0) - (a.waveDamage || 0));
        
        sortedByWave.forEach((p, i) => {
          const rowY = currentY + 48 + i * 30;
          drawPlayerDamageRow(p, rowY, p.waveDamage || 0, maxWaveDamage, totalWaveDamage, i === 0, panelX, panelW);
        });
        
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
      const now = Date.now();
      incomingAttacks = incomingAttacks.filter(a => now - a.time < 3000);
      for (let i = 0; i < incomingAttacks.length; i++) {
        const a = incomingAttacks[i];
        const age = (now - a.time) / 3000;
        const alpha = 1 - age;
        const attackDef = ATTACK_TYPES[a.type];
        ctx.font = "bold 14px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(255,100,100,${alpha})`;
        ctx.fillText(`⚠️ ${attackDef?.icon || "?"} INCOMING FROM ${a.from.toUpperCase()}!`, canvas.width / 2, 70 + i * 20);
      }

      // Build menu
      if (buildMenuOpen) {
        hoveredBuildOption = null;
        const { x, y, hasTower, tower } = buildMenuOpen;
        const myGold = myPlayer?.gold || 0;

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
          const menuH = 140;
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

      // Upgrade phase
      if (phase === "upgrades" && upgradeOptions.length > 0) {
        // Darker overlay with subtle gradient
        const overlayGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        overlayGrad.addColorStop(0, "rgba(5,5,15,0.9)");
        overlayGrad.addColorStop(0.5, "rgba(10,10,25,0.85)");
        overlayGrad.addColorStop(1, "rgba(5,5,15,0.9)");
        ctx.fillStyle = overlayGrad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        if (!upgradePicked) {
          // Header with wave info
          ctx.font = "bold 14px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          ctx.fillText(`WAVE ${lastSnap?.wave || 1} COMPLETE`, canvas.width / 2, 50);
          
          // Main title
          ctx.font = "bold 28px 'Courier New', monospace";
          ctx.fillStyle = "#fff";
          ctx.fillText("SELECT UPGRADE", canvas.width / 2, 85);
          
          // Countdown timer - minimal style
          const timeLeft = Math.max(0, Math.ceil((upgradeDeadline - Date.now()) / 1000));
          const timerColor = timeLeft <= 3 ? "#ff4466" : timeLeft <= 5 ? "#ffaa00" : "#44ff88";
          ctx.font = "bold 16px 'Courier New', monospace";
          ctx.fillStyle = timerColor;
          const timerAlpha = timeLeft <= 3 ? (0.7 + Math.sin(Date.now() / 80) * 0.3) : 1;
          ctx.globalAlpha = timerAlpha;
          ctx.fillText(`${timeLeft}s`, canvas.width / 2, 115);
          ctx.globalAlpha = 1;
          
          // Cards - sleeker horizontal design
          const cardW = 180;
          const cardH = 220;
          const gap = 25;
          const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * gap;
          const startX = canvas.width / 2 - totalW / 2;
          const cardY = canvas.height / 2 - cardH / 2 + 20;
          
          hoveredUpgrade = -1;
          
          for (let i = 0; i < upgradeOptions.length; i++) {
            const opt = upgradeOptions[i];
            const cardX = startX + i * (cardW + gap);
            const isHovered = mouseX >= cardX && mouseX <= cardX + cardW && mouseY >= cardY && mouseY <= cardY + cardH;
            if (isHovered) hoveredUpgrade = i;
            
            const rarityColor = opt.rarityColor || "#fff";
            
            // Card background
            ctx.save();
            if (isHovered) {
              ctx.shadowColor = rarityColor;
              ctx.shadowBlur = 30;
            }
            
            // Main card body
            const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
            cardGrad.addColorStop(0, isHovered ? "rgba(40,40,60,0.95)" : "rgba(20,20,35,0.9)");
            cardGrad.addColorStop(1, isHovered ? "rgba(30,30,50,0.95)" : "rgba(15,15,25,0.9)");
            ctx.fillStyle = cardGrad;
            
            ctx.beginPath();
            ctx.roundRect(cardX, cardY, cardW, cardH, 8);
            ctx.fill();
            
            // Border with rarity color
            ctx.strokeStyle = isHovered ? rarityColor : hexToRgba(rarityColor, 0.4);
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.stroke();
            ctx.restore();
            
            // Rarity indicator bar at top
            ctx.fillStyle = rarityColor;
            ctx.beginPath();
            ctx.roundRect(cardX + 10, cardY + 8, cardW - 20, 3, 2);
            ctx.fill();
            
            // Rarity label
            ctx.font = "bold 9px 'Courier New', monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = hexToRgba(rarityColor, 0.8);
            ctx.fillText(opt.rarityLabel, cardX + cardW / 2, cardY + 28);
            
            // Icon - larger and centered
            ctx.font = "42px sans-serif";
            ctx.fillStyle = "#fff";
            ctx.fillText(opt.icon, cardX + cardW / 2, cardY + 85);
            
            // Title
            ctx.font = "bold 13px 'Courier New', monospace";
            ctx.fillStyle = "#fff";
            ctx.fillText(opt.title, cardX + cardW / 2, cardY + 120);
            
            // Description - wrapped if needed
            ctx.font = "11px 'Courier New', monospace";
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            const desc = opt.desc;
            if (desc.length > 22) {
              // Split into two lines
              const mid = desc.lastIndexOf(' ', 22);
              if (mid > 0) {
                ctx.fillText(desc.substring(0, mid), cardX + cardW / 2, cardY + 150);
                ctx.fillText(desc.substring(mid + 1), cardX + cardW / 2, cardY + 165);
              } else {
                ctx.fillText(desc, cardX + cardW / 2, cardY + 155);
              }
            } else {
              ctx.fillText(desc, cardX + cardW / 2, cardY + 155);
            }
            
            // Category tag at bottom
            ctx.fillStyle = "rgba(255,255,255,0.3)";
            ctx.font = "8px 'Courier New', monospace";
            ctx.fillText(opt.category.toUpperCase(), cardX + cardW / 2, cardY + cardH - 15);
            
            // Hover hint
            if (isHovered) {
              ctx.fillStyle = hexToRgba(rarityColor, 0.9);
              ctx.font = "bold 10px 'Courier New', monospace";
              ctx.fillText("CLICK TO SELECT", cardX + cardW / 2, cardY + cardH - 30);
            }
          }
          
          // Reroll button below cards
          const myPlayer = lastSnap?.players.find(p => p.id === myId);
          const myGold = myPlayer?.gold || 0;
          const canAffordReroll = myGold >= currentRerollCost;
          
          const rerollBtnW = 160;
          const rerollBtnH = 36;
          const rerollBtnX = canvas.width / 2 - rerollBtnW / 2;
          const rerollBtnY = cardY + cardH + 25;
          
          const isRerollHovered = mouseX >= rerollBtnX && mouseX <= rerollBtnX + rerollBtnW && 
                                  mouseY >= rerollBtnY && mouseY <= rerollBtnY + rerollBtnH;
          hoveredReroll = isRerollHovered;
          
          // Reroll button background
          ctx.fillStyle = isRerollHovered && canAffordReroll ? "rgba(100,180,255,0.35)" : 
                          canAffordReroll ? "rgba(60,120,200,0.2)" : "rgba(40,40,60,0.3)";
          ctx.strokeStyle = isRerollHovered && canAffordReroll ? "#7ae0ff" : 
                            canAffordReroll ? "rgba(122,224,255,0.5)" : "#333";
          ctx.lineWidth = isRerollHovered && canAffordReroll ? 2 : 1;
          ctx.beginPath();
          ctx.roundRect(rerollBtnX, rerollBtnY, rerollBtnW, rerollBtnH, 8);
          ctx.fill();
          ctx.stroke();
          
          // Reroll button text
          ctx.font = "bold 12px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = canAffordReroll ? "#7ae0ff" : "#555";
          ctx.fillText(`🎲 REROLL (${currentRerollCost}g)`, canvas.width / 2, rerollBtnY + 23);
          
          ctx.textAlign = "left";
        } else {
          // Selection confirmation
          ctx.font = "bold 24px 'Courier New', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#44ff88";
          ctx.fillText("✓ UPGRADE SELECTED", canvas.width / 2, canvas.height / 2 - 10);
          ctx.font = "14px 'Courier New', monospace";
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          ctx.fillText("Waiting for other players...", canvas.width / 2, canvas.height / 2 + 20);
          ctx.textAlign = "left";
        }
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
    } catch (err) {
      console.error('Draw error:', err);
    }
  }

  // Auto-connect
  connect();
  draw();

  nameInput.addEventListener("input", debounce(() => {
    if (connected) {
      const name = nameInput.value.trim();
      if (name) send({ t: "setName", name });
    }
  }, 300));

  readyBtn.onclick = () => { send({ t: "ready" }); };
  launchBtn.onclick = () => { 
    // Any ready player can start when all are ready
    const me = lobbyPlayers.find(p => p.id === myId);
    if (allReady && me?.ready) send({ t: "start" }); 
  };
})();
