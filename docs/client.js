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
    swarm: { name: "Swarm", cost: 15, desc: "3 fast weak", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 40, desc: "1 tanky", color: "#ff4444", icon: "🪨" },
    bomber: { name: "Bomber", cost: 60, desc: "Explodes!", color: "#ff00ff", icon: "💣" },
    splitter: { name: "Splitter", cost: 50, desc: "Splits x3", color: "#00ffff", icon: "💎" },
    ghost: { name: "Ghost", cost: 35, desc: "Phases", color: "#8800ff", icon: "👻" }
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
  let lastSnap = null;
  let upgradeOptions = [];
  let upgradePicked = false;
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
        break;

      case "upgradePhase":
        phase = "upgrades";
        break;

      case "picked":
        upgradePicked = true;
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
    launchBtn.style.display = isHost ? "block" : "none";
    launchBtn.disabled = !allReady;
    launchBtn.className = "btn launch" + (allReady ? "" : " disabled");
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
    if (phase === "upgrades" && hoveredUpgrade >= 0 && !upgradePicked) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) send({ t: "pickUpgrade", key: opt.key });
      return;
    }

    // Handle attack panel clicks (always visible, no popup)
    if (hoveredAttack && phase === "playing" && lastSnap && lastSnap.players.length > 1) {
      const myPlayer = lastSnap.players.find(p => p.id === myId);
      const atkDef = ATTACK_TYPES[hoveredAttack];
      if (myPlayer && atkDef && myPlayer.gold >= atkDef.cost) {
        send({ t: "buyAttack", attackType: hoveredAttack });
        recentAttackSent = { type: hoveredAttack, time: Date.now() };
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

      if (me && me.towers) {
        const segX0 = me.slot * world.segmentWidth;
        const cx = (segX0 + world.segmentWidth / 2) * sx + offsetX;
        const cy = 560 * sy + offsetY;
        const offsets = [-110, -50, 50, 110];

        for (let i = 0; i < 4; i++) {
          const tx = cx + offsets[i] * sx;
          const clickRadius = me.towers[i] ? 25 * sx : 20 * sx;
          if (Math.hypot(mouseX - tx, mouseY - (cy - 15 * sy)) < clickRadius) {
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
    const scale = Math.min(sw / ww, sh / wh);
    const renderW = ww * scale;
    const renderH = wh * scale;
    const offsetX = (sw - renderW) / 2;
    const offsetY = (sh - renderH) / 2;
    return { sx: scale, sy: scale, offsetX, offsetY, renderW, renderH };
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

      // Particles
      if (lastSnap.particles) {
        for (const p of lastSnap.particles) {
          ctx.fillStyle = hexToRgba(p.color, p.life / (p.maxLife || 0.5));
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

        // Ghost phasing effect
        const phaseAlpha = m.isPhased ? 0.3 : 0.7;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(m.rotation || 0);
        ctx.fillStyle = hexToRgba(baseColor, phaseAlpha);
        ctx.strokeStyle = baseColor;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 8;

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
        ctx.shadowBlur = 0;

        // HP bar
        if (m.hp < m.maxHp) {
          const bw = r * 2, bh = 3 * sy, bx = x - bw / 2, by = y - r - 8 * sy;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = (m.hp / m.maxHp) > 0.5 ? "#0f8" : "#f44";
          ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), bh);
        }

        // Attack type indicator
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
          ctx.fillText(d.amount.toString(), d.x * sx, d.y * sy);
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
        ctx.shadowColor = isDead ? "transparent" : color.main;
        ctx.shadowBlur = isDead ? 0 : 15;
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
        ctx.shadowBlur = 0;

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

              // Platform
              const platformW = 28 * sx;
              const platformH = 8 * sy;
              ctx.fillStyle = hexToRgba("#333", 0.9 * towerAlpha);
              ctx.strokeStyle = hexToRgba(tColor, 0.6 * towerAlpha);
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.roundRect(tx - platformW / 2, ty - platformH, platformW, platformH, 3);
              ctx.fill();
              ctx.stroke();

              ctx.shadowColor = isDead ? "transparent" : tColor;
              ctx.shadowBlur = isDead ? 0 : 10 + level * 2;

              if (typeInfo.name === "Gatling") {
                const bodyW = 18 * sx;
                const bodyH = 16 * sy;
                ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(tx - bodyW / 2, ty - platformH - bodyH, bodyW, bodyH, 4);
                ctx.fill();
                ctx.stroke();
                for (let b = -1; b <= 1; b++) {
                  ctx.fillStyle = hexToRgba(tColor, towerAlpha);
                  ctx.fillRect(tx + b * 4 * sx - 1.5 * sx, ty - platformH - bodyH - 12 * sy, 3 * sx, 14 * sy);
                }
              } else if (typeInfo.name === "Sniper") {
                const bodyW = 12 * sx;
                const bodyH = 20 * sy;
                ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(tx - bodyW / 2, ty - platformH - bodyH, bodyW, bodyH, 3);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = hexToRgba(tColor, towerAlpha);
                ctx.fillRect(tx - 2 * sx, ty - platformH - bodyH - 18 * sy, 4 * sx, 20 * sy);
                ctx.fillStyle = hexToRgba("#00ffaa", towerAlpha);
                ctx.beginPath();
                ctx.arc(tx + 6 * sx, ty - platformH - bodyH + 6 * sy, 3 * sx, 0, Math.PI * 2);
                ctx.fill();
              } else if (typeInfo.name === "Missile") {
                const bodyW = 22 * sx;
                const bodyH = 18 * sy;
                ctx.fillStyle = hexToRgba(tColor, 0.85 * towerAlpha);
                ctx.strokeStyle = hexToRgba(tColor, towerAlpha);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(tx - bodyW / 2, ty - platformH - bodyH, bodyW, bodyH, 4);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = "#222";
                for (let m = -1; m <= 1; m += 2) {
                  ctx.beginPath();
                  ctx.arc(tx + m * 5 * sx, ty - platformH - bodyH / 2, 4 * sx, 0, Math.PI * 2);
                  ctx.fill();
                }
                ctx.fillStyle = hexToRgba("#ff6600", towerAlpha);
                for (let m = -1; m <= 1; m += 2) {
                  ctx.beginPath();
                  ctx.arc(tx + m * 5 * sx, ty - platformH - bodyH - 3 * sy, 3 * sx, 0, Math.PI * 2);
                  ctx.fill();
                }
              }
              ctx.shadowBlur = 0;

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

      // Always-visible Attack Panel (PvP) - right side
      if (phase === "playing" && lastSnap.players.length > 1 && myPlayer && myPlayer.hp > 0) {
        hoveredAttack = null;
        const panelW = 140;
        const panelH = 260;
        const panelX = canvas.width - panelW - 15;
        const panelY = 60;
        const myGold = myPlayer?.gold || 0;

        // Panel background
        ctx.fillStyle = "rgba(10,10,25,0.9)";
        ctx.strokeStyle = "rgba(255,68,68,0.6)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(panelX, panelY, panelW, panelH, 10);
        ctx.fill();
        ctx.stroke();

        // Header
        ctx.font = "bold 11px 'Orbitron', monospace";
        ctx.fillStyle = "#f44";
        ctx.textAlign = "center";
        ctx.fillText("⚔️ ATTACKS", panelX + panelW / 2, panelY + 18);
        
        // Subtitle
        ctx.font = "8px 'Courier New', monospace";
        ctx.fillStyle = "#666";
        ctx.fillText("Random Target", panelX + panelW / 2, panelY + 32);

        // Divider
        ctx.strokeStyle = "rgba(255,68,68,0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(panelX + 10, panelY + 40);
        ctx.lineTo(panelX + panelW - 10, panelY + 40);
        ctx.stroke();

        // Attack buttons
        const attacks = Object.entries(ATTACK_TYPES);
        const btnH = 38;
        const btnGap = 4;
        const startY = panelY + 48;

        attacks.forEach(([key, atk], i) => {
          const btnY = startY + i * (btnH + btnGap);
          const btnX = panelX + 8;
          const btnW = panelW - 16;
          const canAfford = myGold >= atk.cost;
          const isHovered = mouseX >= btnX && mouseX <= btnX + btnW && mouseY >= btnY && mouseY <= btnY + btnH;

          if (isHovered && canAfford) hoveredAttack = key;

          // Button background
          ctx.fillStyle = isHovered && canAfford ? hexToRgba(atk.color, 0.35) : 
                          canAfford ? hexToRgba(atk.color, 0.15) : "rgba(30,30,30,0.5)";
          ctx.strokeStyle = isHovered && canAfford ? atk.color : 
                            canAfford ? hexToRgba(atk.color, 0.5) : "#333";
          ctx.lineWidth = isHovered && canAfford ? 2 : 1;
          ctx.beginPath();
          ctx.roundRect(btnX, btnY, btnW, btnH, 6);
          ctx.fill();
          ctx.stroke();

          // Icon
          ctx.font = "16px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(atk.icon, btnX + 6, btnY + 24);

          // Name
          ctx.font = "bold 10px 'Courier New', monospace";
          ctx.fillStyle = canAfford ? atk.color : "#555";
          ctx.fillText(atk.name.toUpperCase(), btnX + 28, btnY + 14);

          // Description
          ctx.font = "8px 'Courier New', monospace";
          ctx.fillStyle = canAfford ? "rgba(255,255,255,0.5)" : "#444";
          ctx.fillText(atk.desc, btnX + 28, btnY + 26);

          // Cost
          ctx.font = "bold 10px 'Courier New', monospace";
          ctx.textAlign = "right";
          ctx.fillStyle = canAfford ? "#fd0" : "#555";
          ctx.fillText(atk.cost + "g", btnX + btnW - 6, btnY + 24);
        });

        // Footer hint
        ctx.font = "7px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#555";
        ctx.fillText("Spawns next wave", panelX + panelW / 2, panelY + panelH - 8);
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
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!upgradePicked) {
          drawNeonText("CHOOSE UPGRADE", canvas.width / 2, 80, "#ff0", 24, "center");
          const cardW = 220;
          const cardH = 160;
          const gap = 30;
          const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * gap;
          const startX = canvas.width / 2 - totalW / 2;
          const cardY = canvas.height / 2 - cardH / 2;
          hoveredUpgrade = -1;
          for (let i = 0; i < upgradeOptions.length; i++) {
            const opt = upgradeOptions[i];
            const cardX = startX + i * (cardW + gap);
            const isHovered = mouseX >= cardX && mouseX <= cardX + cardW && mouseY >= cardY && mouseY <= cardY + cardH;
            if (isHovered) hoveredUpgrade = i;
            const rarityColor = opt.rarityColor || "#fff";
            ctx.fillStyle = isHovered ? "rgba(255,255,255,0.1)" : "rgba(20,20,40,0.9)";
            ctx.strokeStyle = isHovered ? rarityColor : hexToRgba(rarityColor, 0.3);
            ctx.lineWidth = isHovered ? 4 : 2;
            ctx.shadowColor = isHovered ? rarityColor : "transparent";
            ctx.shadowBlur = isHovered ? 20 : 0;
            ctx.beginPath();
            ctx.roundRect(cardX, cardY, cardW, cardH, 10);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.font = "bold 10px 'Courier New', monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = rarityColor;
            ctx.fillText(opt.rarityLabel, cardX + cardW / 2, cardY + 20);
            ctx.font = "32px sans-serif";
            ctx.fillStyle = "#fff";
            ctx.fillText(opt.icon, cardX + cardW / 2, cardY + 55);
            ctx.font = "bold 14px 'Courier New', monospace";
            ctx.fillStyle = rarityColor;
            ctx.fillText(opt.title, cardX + cardW / 2, cardY + 85);
            ctx.font = "11px 'Courier New', monospace";
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.fillText(opt.desc, cardX + cardW / 2, cardY + 110);
            ctx.font = "9px 'Courier New', monospace";
            ctx.fillStyle = "rgba(255,255,255,0.4)";
            ctx.fillText(opt.category.toUpperCase(), cardX + cardW / 2, cardY + 140);
          }
          ctx.textAlign = "left";
        } else {
          drawNeonText("UPGRADE SELECTED", canvas.width / 2, canvas.height / 2 - 20, "#0f8", 20, "center");
        }
      }

      // Game over
      if (phase === "gameover" && gameOverData) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
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

        drawNeonText("RETURNING TO LOBBY...", canvas.width / 2, canvas.height - 80, "#0ff", 14, "center");
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
  launchBtn.onclick = () => { if (allReady) send({ t: "start" }); };
})();
