(() => {
  // ===== Configuration =====
  // Hardcoded server URL as requested
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
  
  // HTML Update: Replace the server input with Status Light via JS injection
  // We do this to ensure your style updates apply without user modifying HTML manually
  const serverSection = document.querySelector('#menuScreen .section:first-of-type');
  if (serverSection) {
    serverSection.innerHTML = `
      <label>SERVER STATUS</label>
      <div class=\"server-status-row\">
        <div class=\"status-light-container\">
          <div id=\"statusLED\" class=\"led red\"></div>
          <div id=\"statusText\" class=\"status-text\">OFFLINE</div>
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
  let buildMenuOpen = null; // { slotIndex: 0-3, x, y }
  let hoveredBuildOption = -1;

  // Visual
  let stars = [];
  let screenShake = 0;
  let time = 0;

  // ===== Utilities =====
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
    // Auto status update
    if (statusText) statusText.textContent = "CONNECTING...";
    if (statusLED) statusLED.className = "led";

    if (ws) try { ws.close(); } catch {}

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
      if (statusText) {
        statusText.textContent = "OFFLINE - RETRYING...";
        statusText.className = "status-text";
      }
      if (statusLED) statusLED.className = "led red";
      
      lobbyEl.style.display = "none";
      
      if (!forcedDisconnect) {
        setTimeout(connect, 3000); // Retry loop
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
        // Override status
        if(statusText) statusText.textContent = msg.reason.toUpperCase();
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

    if (buildMenuOpen && hoveredBuildOption >= 0) {
      const type = hoveredBuildOption;
      send({ t: "buyTower", slotIndex: buildMenuOpen.slotIndex, type });
      buildMenuOpen = null;
      return;
    } else if (buildMenuOpen) {
      buildMenuOpen = null;
      return;
    }

    // Build Menu Opening (Check 4 slots)
    if (phase === "playing" && lastSnap) {
      const { sx, sy, offsetX, offsetY } = getScale();
      const me = lastSnap.players.find(p => p.id === myId);
      if (me && me.towers) {
        const segX0 = me.slot * world.segmentWidth;
        const cx = (segX0 + world.segmentWidth / 2) * sx + offsetX;
        const cy = 560 * sy + offsetY;
        
        // Match server offsets: -110, -50, +50, +110
        const offsets = [-110, -50, 50, 110];
        
        for (let i = 0; i < 4; i++) {
          if (!me.towers[i]) { // Empty slot
            const tx = cx + offsets[i] * sx;
            // Hitbox
            if (Math.hypot(mouseX - tx, mouseY - cy) < 20 * sx) {
              buildMenuOpen = { slotIndex: i, x: tx, y: cy };
              return;
            }
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
    ctx.shadowColor = color; ctx.shadowBlur = 15; ctx.fillStyle = color; ctx.fillText(text, x, y);
    ctx.shadowBlur = 0; ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.6; ctx.fillText(text, x, y);
    ctx.restore();
  }

  function draw() {
    requestAnimationFrame(draw);
    const dt = 1/60; time += dt; screenShake *= 0.92;

    ctx.fillStyle = "#050510"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      s.y += s.speed; if (s.y > 1) s.y = 0;
      const twinkle = Math.sin(time * 3 + s.twinkle) * 0.3 + 0.7;
      ctx.fillStyle = `rgba(255,255,255,${twinkle * 0.5})`;
      ctx.beginPath(); ctx.arc(s.x * canvas.width, s.y * canvas.height, s.size, 0, Math.PI * 2); ctx.fill();
    }

    if (phase === "menu" || phase === "lobby") {
      drawNeonText("ROGUE ASTEROID", canvas.width/2, 60, "#0ff", 28, "center");
      return;
    }

    if (!lastSnap) return;

    const { sx, sy, offsetX, offsetY } = getScale();
    ctx.save();
    if (screenShake > 0.5) ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
    ctx.translate(offsetX, offsetY);

    // Grid & Ground
    ctx.strokeStyle = "rgba(0,255,255,0.03)"; ctx.lineWidth = 1;
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

    // Entities
    for (const p of lastSnap.players) if (p.upgrades?.slowfield) { ctx.fillStyle = hexToRgba(PLAYER_COLORS[p.slot]?.main||"#fff", 0.04); ctx.fillRect(p.slot*world.segmentWidth*sx, 0, world.segmentWidth*sx, 560*sy); }
    for (const p of lastSnap.players) if (p.upgrades?.shieldActive > 0) { const cx = (p.slot*world.segmentWidth + world.segmentWidth/2)*sx; ctx.strokeStyle = hexToRgba(PLAYER_COLORS[p.slot]?.main||"#fff", 0.5); ctx.lineWidth = 3; ctx.shadowColor = PLAYER_COLORS[p.slot]?.main; ctx.shadowBlur = 15; ctx.beginPath(); ctx.arc(cx, groundY, world.segmentWidth*sx*0.45, Math.PI, 0); ctx.stroke(); ctx.shadowBlur=0; }
    
    if (lastSnap.particles) for (const p of lastSnap.particles) { ctx.fillStyle = hexToRgba(p.color, p.life/(p.maxLife||0.5)); ctx.beginPath(); ctx.arc(p.x*sx, p.y*sy, (p.size||2)*sx, 0, Math.PI*2); ctx.fill(); }

    for (const m of lastSnap.missiles) {
      const x = m.x*sx; const y = m.y*sy; const r = m.r*sx;
      const baseColor = m.type === "large" ? "#ff4444" : m.type === "medium" ? "#ff8800" : "#ffcc00";
      ctx.save(); ctx.translate(x, y); ctx.rotate(m.rotation || 0);
      ctx.fillStyle = hexToRgba(baseColor, 0.7); ctx.strokeStyle = baseColor; ctx.lineWidth = 1.5; ctx.shadowColor = baseColor; ctx.shadowBlur = 8;
      if (m.vertices && m.vertices.length > 0) { ctx.beginPath(); for (let i = 0; i <= m.vertices.length; i++) { const v = m.vertices[i % m.vertices.length]; const px = Math.cos(v.angle) * r * v.dist; const py = Math.sin(v.angle) * r * v.dist; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); ctx.stroke(); } else { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.restore(); ctx.shadowBlur = 0;
      if (m.hp < m.maxHp) { const bw = r*2, bh=3*sy, bx=x-bw/2, by=y-r-8*sy; ctx.fillStyle="rgba(0,0,0,0.6)"; ctx.fillRect(bx, by, bw, bh); ctx.fillStyle= (m.hp/m.maxHp)>0.5?"#0f8":"#f44"; ctx.fillRect(bx, by, bw*(m.hp/m.maxHp), bh); }
    }

    for (const b of lastSnap.bullets) {
      const x = b.x*sx; const y = b.y*sy; const r = b.r*sx; const color = PLAYER_COLORS[b.slot]?.main || "#0ff";
      const angle = Math.atan2(b.vy, b.vx); const trail = 12*sx;
      ctx.strokeStyle = hexToRgba(color, 0.4); ctx.lineWidth = r*1.5; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x-Math.cos(angle)*trail, y-Math.sin(angle)*trail); ctx.stroke();
      ctx.fillStyle = b.isCrit ? "#fff" : color; ctx.shadowColor = b.isCrit ? "#ff0" : color; ctx.shadowBlur = b.isCrit ? 15 : 8; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
    }

    if (lastSnap.damageNumbers) for (const d of lastSnap.damageNumbers) { ctx.font = `bold ${d.isCrit?16:12}px 'Courier New', monospace`; ctx.textAlign = "center"; ctx.fillStyle = d.isCrit ? `rgba(255,255,0,${d.life})` : `rgba(255,255,255,${d.life})`; ctx.fillText(d.amount.toString(), d.x*sx, d.y*sy); }

    // Turrets & 4 Slots
    for (const p of lastSnap.players) {
      if (p.slot < 0) continue;
      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      const cx = (p.slot * world.segmentWidth + world.segmentWidth / 2) * sx;
      
      // Aim Guide
      if (p.id === myId && mouseDown && !buildMenuOpen) {
        const turretX = cx; const turretY = (560 - 14) * sy; 
        const worldMouseX = (mouseX - offsetX) / sx; const worldMouseY = (mouseY - offsetY) / sy;
        const dx = worldMouseX - (p.slot * world.segmentWidth + world.segmentWidth / 2);
        const dy = worldMouseY - 560;
        let angle = Math.atan2(dy, dx);
        const maxAngle = (80 * Math.PI) / 180;
        const clampedAngle = -Math.PI/2 + Math.max(-maxAngle, Math.min(maxAngle, angle - (-Math.PI/2)));
        const endX = (p.slot * world.segmentWidth + world.segmentWidth / 2) + Math.cos(clampedAngle) * 500;
        const endY = 560 + Math.sin(clampedAngle) * 500;
        ctx.save(); ctx.strokeStyle = hexToRgba(color.main, 0.4); ctx.lineWidth = 2; ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.moveTo(turretX, turretY); ctx.lineTo(endX * sx, endY * sy); ctx.stroke(); ctx.restore();
      }

      // Draw Turrets
      // Main
      const baseW = 24 * sx; const baseH = 14 * sy;
      ctx.fillStyle = hexToRgba(color.main, 0.8); ctx.strokeStyle = color.main; ctx.lineWidth = 1.5; ctx.shadowColor = color.main; ctx.shadowBlur = 15;
      ctx.beginPath(); ctx.roundRect(cx - baseW/2, 560*sy - baseH, baseW, baseH, 3); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.translate(cx, 560*sy - baseH/2); ctx.rotate(p.turretAngle + Math.PI/2);
      ctx.fillStyle = color.main; ctx.fillRect(-2.5*sx, -22*sy, 5*sx, 22*sy); ctx.restore(); ctx.shadowBlur = 0;

      // 4 Mini Slots
      const offsets = [-110, -50, 50, 110];
      // Need safe access to towers array
      const towers = p.towers || [null, null, null, null];
      
      towers.forEach((t, i) => {
        const tx = cx + offsets[i] * sx;
        const ty = 560 * sy;
        
        if (t) {
          // Draw Tower
          const typeInfo = TOWER_TYPES[t.type];
          const tColor = typeInfo?.color || "#fff";
          const mbW = 16*sx; const mbH = 10*sy;
          ctx.fillStyle = hexToRgba(tColor, 0.8); ctx.strokeStyle = tColor; ctx.lineWidth = 1.5; ctx.shadowColor = tColor; ctx.shadowBlur = 8;
          ctx.beginPath(); ctx.roundRect(tx - mbW/2, ty - mbH, mbW, mbH, 3); ctx.fill(); ctx.stroke();
          ctx.save(); ctx.translate(tx, ty - mbH/2); 
          let bl = 14*sy; let bw = 3*sx; if(typeInfo.name==="Sniper"){bl=22*sy;bw=2*sx;} if(typeInfo.name==="Missile"){bl=10*sy;bw=6*sx;}
          ctx.fillStyle = tColor; ctx.fillRect(-bw/2, -bl, bw, bl); ctx.restore(); ctx.shadowBlur = 0;
        } else if (p.id === myId) {
          // Draw Ghost
          ctx.save();
          const pulse = (Math.sin(time*8)+1)/2;
          ctx.fillStyle = `rgba(0, 255, 136, ${0.1 + pulse*0.2})`;
          ctx.strokeStyle = `rgba(0, 255, 136, ${0.3 + pulse*0.3})`;
          ctx.beginPath(); ctx.arc(tx, ty-5*sy, 10*sx, 0, Math.PI*2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = `bold ${14*sx}px sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText("+", tx, ty-5*sy);
          ctx.restore();
        }
      });

      // Name
      ctx.font = "bold 11px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = color.main; 
      ctx.fillText(p.name, cx, groundY + 14);
    }
    ctx.restore();

    // === HUD ===
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0, 0, canvas.width, 50);
    drawNeonText(`WAVE ${wave}`, 20, 25, "#ff0", 18, "left");
    const myPlayer = lastSnap.players.find(p => p.id === myId);
    if (myPlayer) drawNeonText(`${myPlayer.gold} 🟡`, 120, 25, "#fd0", 18, "left");

    const hpBarW = 200; const hpBarH = 20; const hpBarX = canvas.width/2 - hpBarW/2; const hpBarY = 15;
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(hpBarX, hpBarY, hpBarW, hpBarH);
    ctx.fillStyle = (baseHp/maxBaseHp)>0.5?"#0f8":"#f44"; ctx.fillRect(hpBarX, hpBarY, hpBarW * (baseHp/maxBaseHp), hpBarH);
    ctx.strokeStyle = "#0ff"; ctx.strokeRect(hpBarX, hpBarY, hpBarW, hpBarH);
    ctx.font = "bold 12px 'Courier New', monospace"; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.fillText(`${baseHp} / ${maxBaseHp}`, canvas.width/2, hpBarY + 14);

    // === Build Menu ===
    if (buildMenuOpen) {
      hoveredBuildOption = -1;
      const { x, y } = buildMenuOpen;
      const menuW = 160; const menuH = 130; const mx = x - menuW/2; const my = y - menuH - 20;
      ctx.fillStyle = "rgba(10,10,30,0.95)"; ctx.strokeStyle = "#0f8"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(mx, my, menuW, menuH, 8); ctx.fill(); ctx.stroke();
      ctx.font = "bold 12px 'Courier New', monospace"; ctx.fillStyle = "#0f8"; ctx.textAlign = "center"; ctx.fillText("BUILD TOWER", mx + menuW/2, my + 20);
      
      const opts = [
        { id: 0, label: "GATLING", cost: 50, col: "#ff0" },
        { id: 1, label: "SNIPER",  cost: 120, col: "#0f0" },
        { id: 2, label: "MISSILE", cost: 250, col: "#f00" }
      ];
      for (let i=0; i<opts.length; i++) {
        const o = opts[i]; const by = my + 35 + i * 30; const bx = mx + 10;
        const isHovered = mouseX >= bx && mouseX <= bx+140 && mouseY >= by && mouseY <= by+24;
        if (isHovered) hoveredBuildOption = o.id;
        const canAfford = (myPlayer?.gold || 0) >= o.cost;
        ctx.fillStyle = isHovered ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.5)"; if (!canAfford) ctx.fillStyle = "rgba(50,0,0,0.5)";
        ctx.fillRect(bx, by, 140, 24);
        ctx.fillStyle = canAfford ? o.col : "#555"; ctx.textAlign = "left"; ctx.fillText(o.label, bx + 5, by + 16);
        ctx.textAlign = "right"; ctx.fillStyle = canAfford ? "#fd0" : "#555"; ctx.fillText(o.cost + " G", bx + 135, by + 16);
      }
    }
    
    // (Render Upgrades / Game Over UI - Same as previous, kept compact)
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
        }
        ctx.textAlign = "left";
      } else {
        drawNeonText("UPGRADE SELECTED", canvas.width/2, canvas.height/2 - 20, "#0f8", 20, "center");
      }
    }
    if (phase === "gameover" && gameOverData) {
      ctx.fillStyle = "rgba(0,0,0,0.85)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawNeonText("GAME OVER", canvas.width/2, 100, "#f44", 36, "center");
      drawNeonText("RETURNING TO LOBBY...", canvas.width/2, canvas.height - 80, "#0ff", 14, "center");
    }
  }

  // Auto-connect on load
  connect();
})();
