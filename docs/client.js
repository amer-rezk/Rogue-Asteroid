(() => {
  // ===== Configuration =====
  const DEFAULT_SERVER = "wss://rogue-asteroid.onrender.com/ws";
  
  // Player colors
  const PLAYER_COLORS = [
    { main: "#00ffff", dark: "#006666", name: "CYAN" },
    { main: "#ff00ff", dark: "#660066", name: "MAGENTA" },
    { main: "#00ff88", dark: "#006633", name: "GREEN" },
    { main: "#ffaa00", dark: "#664400", name: "ORANGE" },
  ];

  // Tower Config (must match server)
  const TOWER_TYPES = {
    0: { name: "Gatling", cost: 50, color: "#ffff00", desc: "Fast Fire" },
    1: { name: "Sniper",  cost: 120, color: "#00ff00", desc: "Long Range" },
    2: { name: "Missile", cost: 250, color: "#ff0000", desc: "Splash Dmg" }
  };

  // ===== DOM Elements =====
  const menuScreen = document.getElementById("menuScreen");
  const gameScreen = document.getElementById("gameScreen");
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const serverInput = document.getElementById("serverUrl");
  const connectBtn = document.getElementById("connectBtn");
  const statusEl = document.getElementById("status");
  const nameInput = document.getElementById("nameInput");
  const lobbyEl = document.getElementById("lobby");
  const playersEl = document.getElementById("players");
  const readyBtn = document.getElementById("readyBtn");
  const launchBtn = document.getElementById("launchBtn");

  // ===== State =====
  let ws = null;
  let myId = null;
  let mySlot = 0;
  let isHost = false;
  let connected = false;

  let phase = "menu"; // menu | lobby | playing | upgrades | gameover
  let world = { width: 360, height: 600, segmentWidth: 360 };
  let wave = 0;
  let baseHp = 0;
  let maxBaseHp = 0;

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
  let buildMenuOpen = null; // { slot: 'left'|'right', x, y }
  let hoveredBuildOption = -1;

  // Visual
  let stars = [];
  let screenShake = 0;
  let time = 0;

  // ===== Utilities =====
  function normalizeWsUrl(input) {
    let url = (input || "").trim();
    if (!url) return null;
    if (url.startsWith("http://")) url = "ws://" + url.slice(7);
    if (url.startsWith("https://")) url = "wss://" + url.slice(8);
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      url = (location.protocol === "https:" ? "wss://" : "ws://") + url;
    }
    url = url.replace(/\/+$/, "");
    if (!url.endsWith("/ws")) url += "/ws";
    return url;
  }

  function hexToRgba(hex, alpha) {
    let c = hex.replace("#", "");
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    const r = parseInt(c.slice(0,2), 16);
    const g = parseInt(c.slice(2,4), 16);
    const b = parseInt(c.slice(4,6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
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
    const url = normalizeWsUrl(serverInput.value || DEFAULT_SERVER);
    if (!url) return;

    serverInput.value = url;
    statusEl.textContent = "CONNECTING...";
    statusEl.className = "status";

    if (ws) try { ws.close(); } catch {}

    ws = new WebSocket(url);

    ws.onopen = () => {
      connected = true;
      statusEl.textContent = "CONNECTED";
      statusEl.className = "status connected";
      lobbyEl.style.display = "block";
      
      const name = nameInput.value.trim() || `Player`;
      if (name) ws.send(JSON.stringify({ t: "setName", name }));
    };

    ws.onclose = () => {
      connected = false;
      statusEl.textContent = "DISCONNECTED";
      statusEl.className = "status";
      lobbyEl.style.display = "none";
      
      if (!forcedDisconnect) {
        statusEl.textContent = "RECONNECTING IN 3s...";
        setTimeout(connect, 3000);
      } else if (phase !== "menu") {
        showMenu();
      }
    };

    ws.onerror = () => {
      statusEl.textContent = "CONNECTION FAILED";
      statusEl.className = "status";
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
        statusEl.textContent = msg.reason;
        forcedDisconnect = true;
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
        showGame();
        break;

      case "wave":
        wave = msg.wave;
        upgradeOptions = [];
        upgradePicked = false;
        buildMenuOpen = null;
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
        baseHp = msg.baseHp;
        maxBaseHp = msg.maxBaseHp;
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
  canvas.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      mouseDown = true;
      handleClick();
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) mouseDown = false;
  });

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    mouseDown = true;
    if (e.touches[0]) {
      mouseX = e.touches[0].clientX;
      mouseY = e.touches[0].clientY;
    }
    handleClick();
  });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches[0]) {
      mouseX = e.touches[0].clientX;
      mouseY = e.touches[0].clientY;
    }
  });

  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    mouseDown = false;
  });

  function handleClick() {
    // 1. Upgrade Phase Clicks
    if (phase === "upgrades" && hoveredUpgrade >= 0 && !upgradePicked) {
      const opt = upgradeOptions[hoveredUpgrade];
      if (opt) send({ t: "pickUpgrade", key: opt.key });
      return;
    }

    // 2. Build Menu Clicks (If open)
    if (buildMenuOpen && hoveredBuildOption >= 0) {
      const type = hoveredBuildOption;
      send({ t: "buyTower", slot: buildMenuOpen.slot, type });
      buildMenuOpen = null; // Close after click
      return;
    } else if (buildMenuOpen) {
      // Clicked outside menu
      buildMenuOpen = null;
      return;
    }

    // 3. Open Build Menu Clicks
    if (phase === "playing" && lastSnap) {
      const { sx, sy, offsetX, offsetY } = getScale();
      const me = lastSnap.players.find(p => p.id === myId);
      if (me) {
        const cx = (me.slot * world.segmentWidth + world.segmentWidth / 2) * sx + offsetX;
        const cy = 560 * sy + offsetY;
        const offset = (world.segmentWidth * 0.20) * sx;

        // Check Left Slot
        if (!me.towers?.left) {
          const lx = cx - offset;
          if (Math.hypot(mouseX - lx, mouseY - cy) < 20 * sx) {
            buildMenuOpen = { slot: "left", x: lx, y: cy };
            return;
          }
        }
        // Check Right Slot
        if (!me.towers?.right) {
          const rx = cx + offset;
          if (Math.hypot(mouseX - rx, mouseY - cy) < 20 * sx) {
            buildMenuOpen = { slot: "right", x: rx, y: cy };
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

    send({
      t: "input",
      x: worldX,
      y: worldY,
      shooting: mouseDown && !buildMenuOpen // Don't shoot if menu open
    });
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

  function draw() {
    requestAnimationFrame(draw);

    const dt = 1/60;
    time += dt;
    screenShake *= 0.92;

    ctx.fillStyle = "#050510";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Stars
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
      drawNeonText("ROGUE ASTEROID", canvas.width/2, 60, "#0ff", 28, "center");
      return;
    }

    if (!lastSnap) return;

    const { sx, sy, offsetX, offsetY } = getScale();

    ctx.save();
    if (screenShake > 0.5) {
      ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
    }
    ctx.translate(offsetX, offsetY);

    // Grid & Ground
    ctx.strokeStyle = "rgba(0,255,255,0.03)";
    ctx.lineWidth = 1;
    for (let x = 0; x < world.width; x += 30) { ctx.beginPath(); ctx.moveTo(x * sx, 0); ctx.lineTo(x * sx, world.height * sy); ctx.stroke(); }
    for (let y = 0; y < world.height; y += 30) { ctx.beginPath(); ctx.moveTo(0, y * sy); ctx.lineTo(world.width * sx, y * sy); ctx.stroke(); }
    
    const segCount = Math.round(world.width / world.segmentWidth);
    for (let i = 1; i < segCount; i++) {
      const x = i * world.segmentWidth * sx;
      ctx.strokeStyle = "rgba(160,0,255,0.3)"; ctx.lineWidth = 2; ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.height * sy); ctx.stroke(); ctx.setLineDash([]);
    }

    const groundY = 560 * sy;
    ctx.strokeStyle = "#0ff"; ctx.lineWidth = 3; ctx.shadowColor = "#0ff"; ctx.shadowBlur = 20;
    ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(world.width * sx, groundY); ctx.stroke(); ctx.shadowBlur = 0;

    // Game Objects
    for (const p of lastSnap.players) { if (p.upgrades?.slowfield) { const segX0 = p.slot * world.segmentWidth; const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0]; ctx.fillStyle = hexToRgba(color.main, 0.04); ctx.fillRect(segX0 * sx, 0, world.segmentWidth * sx, 560 * sy); } }
    for (const p of lastSnap.players) { if (p.upgrades?.shieldActive > 0) { const segX0 = p.slot * world.segmentWidth; const cx = (segX0 + world.segmentWidth / 2) * sx; const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0]; ctx.strokeStyle = hexToRgba(color.main, 0.5); ctx.lineWidth = 3; ctx.shadowColor = color.main; ctx.shadowBlur = 15; ctx.beginPath(); ctx.arc(cx, groundY, world.segmentWidth * sx * 0.45, Math.PI, 0); ctx.stroke(); ctx.shadowBlur = 0; } }
    
    if (lastSnap.particles) for (const p of lastSnap.particles) { const alpha = p.life / (p.maxLife || 0.5); ctx.fillStyle = hexToRgba(p.color, alpha); ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, (p.size || 2) * sx, 0, Math.PI * 2); ctx.fill(); }

    for (const m of lastSnap.missiles) {
      const x = m.x * sx; const y = m.y * sy; const r = m.r * sx;
      const baseColor = m.type === "large" ? "#ff4444" : m.type === "medium" ? "#ff8800" : "#ffcc00";
      ctx.save(); ctx.translate(x, y); ctx.rotate(m.rotation || 0);
      ctx.fillStyle = hexToRgba(baseColor, 0.7); ctx.strokeStyle = baseColor; ctx.lineWidth = 1.5; ctx.shadowColor = baseColor; ctx.shadowBlur = 8;
      if (m.vertices && m.vertices.length > 0) { ctx.beginPath(); for (let i = 0; i <= m.vertices.length; i++) { const v = m.vertices[i % m.vertices.length]; const px = Math.cos(v.angle) * r * v.dist; const py = Math.sin(v.angle) * r * v.dist; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); ctx.stroke(); } else { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.restore(); ctx.shadowBlur = 0;
      if (m.hp < m.maxHp) { const barW = r * 2; const barH = 3 * sy; const barX = x - barW/2; const barY = y - r - 8 * sy; ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(barX, barY, barW, barH); const frac = m.hp / m.maxHp; ctx.fillStyle = frac > 0.5 ? "#0f8" : frac > 0.25 ? "#f80" : "#f44"; ctx.fillRect(barX, barY, barW * frac, barH); }
    }

    for (const b of lastSnap.bullets) {
      const x = b.x * sx; const y = b.y * sy; const r = b.r * sx; const color = PLAYER_COLORS[b.slot]?.main || "#0ff";
      const angle = Math.atan2(b.vy, b.vx); const trailLen = 12 * sx;
      ctx.strokeStyle = hexToRgba(color, 0.4); ctx.lineWidth = r * 1.5; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(angle) * trailLen, y - Math.sin(angle) * trailLen); ctx.stroke();
      ctx.fillStyle = b.isCrit ? "#fff" : color; ctx.shadowColor = b.isCrit ? "#ff0" : color; ctx.shadowBlur = b.isCrit ? 15 : 8; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }

    if (lastSnap.damageNumbers) for (const d of lastSnap.damageNumbers) { const alpha = d.life; ctx.font = `bold ${d.isCrit ? 16 : 12}px 'Courier New', monospace`; ctx.textAlign = "center"; ctx.fillStyle = d.isCrit ? `rgba(255,255,0,${alpha})` : `rgba(255,255,255,${alpha})`; ctx.fillText(d.amount.toString(), d.x * sx, d.y * sy); }

    // Turrets & Build Slots
    for (const p of lastSnap.players) {
      if (p.slot < 0) continue;
      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      const segX0 = p.slot * world.segmentWidth;
      const cx = segX0 + world.segmentWidth / 2;
      const offset = world.segmentWidth * 0.20;

      // Draw Main Turret Aim
      if (p.id === myId && mouseDown && !buildMenuOpen) {
        // ... (Aim guide same as before)
        const turretX = cx * sx;
        const turretY = (560 - 14) * sy; 
        const worldMouseX = (mouseX - offsetX) / sx;
        const worldMouseY = (mouseY - offsetY) / sy;
        const dx = worldMouseX - cx;
        const dy = worldMouseY - 560;
        let angle = Math.atan2(dy, dx);
        const maxAngle = (80 * Math.PI) / 180;
        const fromVertical = angle - (-Math.PI / 2);
        const clampedFromVertical = Math.max(-maxAngle, Math.min(maxAngle, fromVertical));
        const clampedAngle = -Math.PI / 2 + clampedFromVertical;
        const lineLen = 500;
        const endX = cx + Math.cos(clampedAngle) * lineLen;
        const endY = 560 + Math.sin(clampedAngle) * lineLen;
        ctx.save();
        ctx.strokeStyle = hexToRgba(color.main, 0.4); ctx.lineWidth = 2; ctx.setLineDash([8, 8]); ctx.shadowColor = color.main; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.moveTo(turretX, turretY); ctx.lineTo(endX * sx, endY * sy); ctx.stroke(); ctx.setLineDash([]);
        const crossX = endX * sx; const crossY = Math.max(30, endY * sy);
        ctx.strokeStyle = color.main; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(crossX - 8, crossY); ctx.lineTo(crossX + 8, crossY); ctx.moveTo(crossX, crossY - 8); ctx.lineTo(crossX, crossY + 8); ctx.stroke(); ctx.beginPath(); ctx.arc(crossX, crossY, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.restore(); ctx.shadowBlur = 0;
      }

      // Draw Towers
      const turrets = [
        { x: cx, y: 560, kind: "main", angle: p.turretAngle },
        { x: cx - offset, y: 560, kind: "mini", data: p.towers?.left, side: "left" },
        { x: cx + offset, y: 560, kind: "mini", data: p.towers?.right, side: "right" },
      ];

      for (const t of turrets) {
        const tx = t.x * sx;
        const ty = t.y * sy;

        if (t.kind === "main") {
            const baseW = 24 * sx; const baseH = 14 * sy;
            ctx.fillStyle = hexToRgba(color.main, 0.8); ctx.strokeStyle = color.main; ctx.lineWidth = 1.5; ctx.shadowColor = color.main; ctx.shadowBlur = 15;
            ctx.beginPath(); ctx.roundRect(tx - baseW/2, ty - baseH, baseW, baseH, 3); ctx.fill(); ctx.stroke();
            const barrelLen = 22 * sy; const barrelW = 5 * sx; const angle = t.angle || -Math.PI/2;
            ctx.save(); ctx.translate(tx, ty - baseH/2); ctx.rotate(angle + Math.PI/2);
            ctx.fillStyle = color.main; ctx.beginPath(); ctx.roundRect(-barrelW/2, -barrelLen, barrelW, barrelLen, 2); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, -barrelLen, barrelW * 0.6, 0, Math.PI * 2); ctx.fill();
            ctx.restore(); ctx.shadowBlur = 0;
        } else if (t.data) {
            // Draw Purchased Tower
            const typeInfo = TOWER_TYPES[t.data.type];
            const tColor = typeInfo?.color || "#fff";
            const baseW = 16 * sx; const baseH = 10 * sy;
            ctx.fillStyle = hexToRgba(tColor, 0.8); ctx.strokeStyle = tColor; ctx.lineWidth = 1.5; ctx.shadowColor = tColor; ctx.shadowBlur = 8;
            ctx.beginPath(); ctx.roundRect(tx - baseW/2, ty - baseH, baseW, baseH, 3); ctx.fill(); ctx.stroke();
            
            // Tower visual variation
            let barrelLen = 14 * sy; let barrelW = 3 * sx;
            if (typeInfo.name === "Sniper") { barrelLen = 22 * sy; barrelW = 2 * sx; }
            if (typeInfo.name === "Missile") { barrelLen = 10 * sy; barrelW = 6 * sx; }

            ctx.save(); ctx.translate(tx, ty - baseH/2); ctx.rotate(-Math.PI/2 + Math.PI/2); // Fixed up
            ctx.fillStyle = tColor; ctx.beginPath(); ctx.roundRect(-barrelW/2, -barrelLen, barrelW, barrelLen, 2); ctx.fill();
            ctx.restore(); ctx.shadowBlur = 0;
        } else if (p.id === myId) {
            // Draw Build Slot (Ghost)
            ctx.save();
            ctx.globalAlpha = 0.3 + Math.sin(time * 5) * 0.1;
            ctx.fillStyle = "#0f8";
            ctx.beginPath(); ctx.arc(tx, ty - 5*sy, 8*sx, 0, Math.PI*2); ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#000"; ctx.font = `bold ${12*sx}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("+", tx, ty - 5*sy);
            ctx.restore();
        }
      }

      const nameCx = cx * sx;
      ctx.font = "bold 11px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = color.main; ctx.shadowColor = color.main; ctx.shadowBlur = 5;
      ctx.fillText(p.name, nameCx, groundY + 14);
      ctx.font = "9px 'Courier New', monospace"; ctx.fillStyle = p.isManual ? "#ff0" : "#0f8"; ctx.fillText(p.isManual ? "MANUAL" : "AUTO", nameCx, groundY + 26); ctx.shadowBlur = 0;
    }

    ctx.restore();

    // === HUD ===
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0, 0, canvas.width, 50);
    drawNeonText(`WAVE ${wave}`, 20, 25, "#ff0", 18, "left");

    // Gold Display
    const myPlayer = lastSnap.players.find(p => p.id === myId);
    if (myPlayer) {
      drawNeonText(`${myPlayer.gold} 🟡`, 120, 25, "#fd0", 18, "left");
    }

    const hpBarW = 200; const hpBarH = 20; const hpBarX = canvas.width/2 - hpBarW/2; const hpBarY = 15; const hpFrac = baseHp / maxBaseHp; const hpColor = hpFrac > 0.5 ? "#0f8" : hpFrac > 0.25 ? "#f80" : "#f44";
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(hpBarX, hpBarY, hpBarW, hpBarH); ctx.fillStyle = hpColor; ctx.shadowColor = hpColor; ctx.shadowBlur = 10; ctx.fillRect(hpBarX, hpBarY, hpBarW * hpFrac, hpBarH); ctx.shadowBlur = 0; ctx.strokeStyle = "#0ff"; ctx.lineWidth = 2; ctx.strokeRect(hpBarX, hpBarY, hpBarW, hpBarH);
    ctx.font = "bold 12px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.fillText(`${baseHp} / ${maxBaseHp}`, canvas.width/2, hpBarY + 14);

    ctx.textAlign = "right"; ctx.font = "12px 'Courier New', monospace"; let scoreX = canvas.width - 20;
    for (let i = lastSnap.players.length - 1; i >= 0; i--) { const p = lastSnap.players[i]; const color = PLAYER_COLORS[p.slot]?.main || "#fff"; ctx.fillStyle = color; const text = `${p.name}: ${p.score}`; ctx.fillText(text, scoreX, 30); scoreX -= ctx.measureText(text).width + 20; } ctx.textAlign = "left";

    // === Build Menu (Overlay) ===
    if (buildMenuOpen) {
      hoveredBuildOption = -1;
      const { x, y } = buildMenuOpen; // These are screen coords
      
      const menuW = 160;
      const menuH = 130;
      const mx = x - menuW/2;
      const my = y - menuH - 20;

      ctx.fillStyle = "rgba(10,10,30,0.95)";
      ctx.strokeStyle = "#0f8";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(mx, my, menuW, menuH, 8); ctx.fill(); ctx.stroke();

      ctx.font = "bold 12px 'Courier New', monospace";
      ctx.fillStyle = "#0f8"; ctx.textAlign = "center";
      ctx.fillText("BUILD TOWER", mx + menuW/2, my + 20);

      // Options
      const opts = [
        { id: 0, label: "GATLING", cost: 50, col: "#ff0" },
        { id: 1, label: "SNIPER",  cost: 120, col: "#0f0" },
        { id: 2, label: "MISSILE", cost: 250, col: "#f00" }
      ];

      for (let i=0; i<opts.length; i++) {
        const o = opts[i];
        const by = my + 35 + i * 30;
        const bw = 140; const bh = 24;
        const bx = mx + 10;

        const isHovered = mouseX >= bx && mouseX <= bx+bw && mouseY >= by && mouseY <= by+bh;
        if (isHovered) hoveredBuildOption = o.id;

        const canAfford = (myPlayer?.gold || 0) >= o.cost;

        ctx.fillStyle = isHovered ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.5)";
        if (!canAfford) ctx.fillStyle = "rgba(50,0,0,0.5)";
        
        ctx.fillRect(bx, by, bw, bh);
        
        ctx.fillStyle = canAfford ? o.col : "#555";
        ctx.textAlign = "left";
        ctx.fillText(o.label, bx + 5, by + 16);
        ctx.textAlign = "right";
        ctx.fillStyle = canAfford ? "#fd0" : "#555";
        ctx.fillText(o.cost + " G", bx + bw - 5, by + 16);
      }
    }

    // === Upgrade UI ===
    // (Existing upgrade UI code...)
    if (phase === "upgrades" && upgradeOptions.length > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!upgradePicked) {
        drawNeonText("CHOOSE UPGRADE", canvas.width/2, 80, "#ff0", 24, "center");
        const cardW = 220; const cardH = 160; const gap = 30; const totalW = upgradeOptions.length * cardW + (upgradeOptions.length - 1) * gap; const startX = canvas.width/2 - totalW/2; const cardY = canvas.height/2 - cardH/2;
        hoveredUpgrade = -1;
        for (let i = 0; i < upgradeOptions.length; i++) {
          const opt = upgradeOptions[i]; const cardX = startX + i * (cardW + gap);
          const isHovered = mouseX >= cardX && mouseX <= cardX + cardW && mouseY >= cardY && mouseY <= cardY + cardH;
          if (isHovered) hoveredUpgrade = i;
          const rarityColor = opt.rarityColor || "#fff";
          ctx.fillStyle = isHovered ? "rgba(255,255,255,0.1)" : "rgba(20,20,40,0.9)"; ctx.strokeStyle = isHovered ? rarityColor : hexToRgba(rarityColor, 0.3); ctx.lineWidth = isHovered ? 4 : 2; ctx.shadowColor = isHovered ? rarityColor : "transparent"; ctx.shadowBlur = isHovered ? 20 : 0;
          ctx.beginPath(); ctx.roundRect(cardX, cardY, cardW, cardH, 10); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
          ctx.font = "bold 10px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = rarityColor; ctx.fillText(opt.rarityLabel, cardX + cardW/2, cardY + 20);
          ctx.font = "32px sans-serif"; ctx.fillStyle = "#fff"; ctx.fillText(opt.icon, cardX + cardW/2, cardY + 55);
          ctx.font = "bold 14px 'Courier New', monospace"; ctx.fillStyle = rarityColor; ctx.fillText(opt.title, cardX + cardW/2, cardY + 85);
          ctx.font = "11px 'Courier New', monospace"; ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillText(opt.desc, cardX + cardW/2, cardY + 110);
          ctx.font = "9px 'Courier New', monospace"; ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fillText(opt.category.toUpperCase(), cardX + cardW/2, cardY + 140);
        }
        ctx.textAlign = "left";
      } else {
        drawNeonText("UPGRADE SELECTED", canvas.width/2, canvas.height/2 - 20, "#0f8", 20, "center");
        if (waitingFor.length > 0) { ctx.font = "14px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.fillText(`Waiting for: ${waitingFor.join(", ")}`, canvas.width/2, canvas.height/2 + 20); }
      }
    }

    if (phase === "gameover" && gameOverData) {
      ctx.fillStyle = "rgba(0,0,0,0.85)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawNeonText("GAME OVER", canvas.width/2, 100, "#f44", 36, "center");
      drawNeonText(`REACHED WAVE ${gameOverData.wave}`, canvas.width/2, 150, "#ff0", 18, "center");
      if (gameOverData.scores) { const startY = 220; for (let i = 0; i < gameOverData.scores.length; i++) { const s = gameOverData.scores[i]; const color = PLAYER_COLORS[s.slot]?.main || "#fff"; const y = startY + i * 40; ctx.font = "bold 18px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.fillText(`${i + 1}. ${s.name}: ${s.score}`, canvas.width/2, y); } ctx.shadowBlur = 0; }
      drawNeonText("RETURNING TO LOBBY...", canvas.width/2, canvas.height - 80, "#0ff", 14, "center");
    }
  }

  // ===== Event Handlers =====
  connectBtn.onclick = connect;
  nameInput.onkeydown = (e) => { if (e.key === "Enter" && connected) { const name = nameInput.value.trim(); if (name) send({ t: "setName", name }); } };
  nameInput.onblur = () => { if (connected) { const name = nameInput.value.trim(); if (name) send({ t: "setName", name }); } };
  readyBtn.onclick = () => { send({ t: "ready" }); };
  launchBtn.onclick = () => { if (allReady) send({ t: "start" }); };

  serverInput.value = DEFAULT_SERVER;
  draw();
})();
