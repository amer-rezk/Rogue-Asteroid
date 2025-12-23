(() => {
  const HARD_DEFAULT_SERVER = "wss://rogue-asteroid.onrender.com/ws";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const statusEl = document.getElementById("status");
  const serverEl = document.getElementById("serverUrl");
  const connectBtn = document.getElementById("connectBtn");

  const nameEl = document.getElementById("name");
  const saveNameBtn = document.getElementById("saveName");
  const startBtn = document.getElementById("startBtn");

  const lobbyInfo = document.getElementById("lobbyInfo");
  const playerList = document.getElementById("playerList");

  const upgradePanel = document.getElementById("upgradePanel");
  const upgradeOptionsEl = document.getElementById("upgradeOptions");

  // Neon color palette
  const COLORS = {
    cyan: "#0ff",
    magenta: "#f0f",
    yellow: "#ff0",
    orange: "#f80",
    red: "#f55",
    purple: "#a0f",
    green: "#0f8",
    white: "#fff",
    darkBg: "#0a0a18",
  };

  // Player colors for different slots
  const PLAYER_COLORS = [
    { main: "#0ff", glow: "rgba(0,255,255,", name: "Cyan" },
    { main: "#f0f", glow: "rgba(255,0,255,", name: "Magenta" },
    { main: "#0f8", glow: "rgba(0,255,136,", name: "Green" },
    { main: "#fa0", glow: "rgba(255,170,0,", name: "Orange" },
  ];

  function setStatus(txt) {
    statusEl.textContent = txt;
  }

  // --- URL helpers ---
  function normalizeWsUrl(input) {
    let url = (input || "").trim();
    if (!url) return null;
    if (url.startsWith("http://")) url = "ws://" + url.slice(7);
    if (url.startsWith("https://")) url = "wss://" + url.slice(8);
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      url = proto + url;
    }
    url = url.replace(/\/+$/, "");
    if (!url.endsWith("/ws")) url += "/ws";
    return url;
  }

  function isGithubWs(url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith("github.io");
    } catch {
      return false;
    }
  }

  function chooseInitialServer() {
    const qs = new URLSearchParams(location.search);
    const q = qs.get("server");
    if (q) return normalizeWsUrl(q);
    const fromHtml = (serverEl.value || "").trim();
    if (fromHtml) return normalizeWsUrl(fromHtml);
    const stored = (localStorage.getItem("serverUrl") || "").trim();
    const storedNorm = stored ? normalizeWsUrl(stored) : null;
    if (storedNorm && !isGithubWs(storedNorm)) return storedNorm;
    return normalizeWsUrl(HARD_DEFAULT_SERVER);
  }

  // --- Multiplayer state ---
  let ws = null;
  let myId = null;
  let mySlot = 0;
  let isHost = false;

  let phase = "lobby";
  let world = { width: 360, height: 600, segmentWidth: 360 };
  let wave = 0;
  let baseHp = 0;
  let maxBaseHp = 0;

  let lastSnap = null;

  // Input
  let mouseXWorld = 0;
  let shooting = false;

  // Visual effects
  let screenShake = 0;
  let stars = [];

  // Initialize stars
  function initStars() {
    stars = [];
    for (let i = 0; i < 100; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        size: Math.random() * 1.5 + 0.5,
        speed: Math.random() * 0.02 + 0.01,
        twinkle: Math.random() * Math.PI * 2,
      });
    }
  }
  initStars();

  function connect(url) {
    const wsUrl = normalizeWsUrl(url);
    if (!wsUrl) {
      setStatus("No server URL.");
      return;
    }

    if (!isGithubWs(wsUrl)) localStorage.setItem("serverUrl", wsUrl);
    serverEl.value = wsUrl;

    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    setStatus("Connecting…");
    console.log("Connecting to WS:", wsUrl);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus("Connected");
      const nm = (localStorage.getItem("playerName") || "").trim();
      if (nm) ws.send(JSON.stringify({ t: "hello", name: nm }));
    };

    ws.onclose = (e) => {
      setStatus(`Disconnected (code ${e.code})`);
      myId = null;
      isHost = false;
      startBtn.style.display = "none";
    };

    ws.onerror = () => {
      setStatus("Connection error");
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === "reject") {
        setStatus(`Rejected: ${msg.reason}`);
        return;
      }

      if (msg.t === "welcome") {
        myId = msg.id;
        mySlot = msg.slot;
        isHost = !!msg.isHost;
        phase = msg.phase;
        world = msg.world;
        startBtn.style.display = isHost ? "inline-block" : "none";
        setStatus(isHost ? "Connected (Host)" : "Connected");
        return;
      }

      if (msg.t === "lobby") {
        phase = "lobby";
        renderLobby(msg.players, msg.hostId);
        return;
      }

      if (msg.t === "started") {
        phase = "playing";
        world = msg.world;
        wave = msg.wave;
        upgradePanel.style.display = "none";
        return;
      }

      if (msg.t === "wave") {
        wave = msg.wave;
        upgradePanel.style.display = "none";
        screenShake = 10;
        return;
      }

      if (msg.t === "upgrade") {
        phase = "upgrades";
        showUpgrades(msg.options);
        return;
      }

      if (msg.t === "picked") {
        upgradePanel.style.display = "none";
        return;
      }

      if (msg.t === "state") {
        // Check for damage
        if (lastSnap && msg.baseHp < lastSnap.baseHp) {
          screenShake = 15;
        }
        lastSnap = msg;
        phase = msg.phase;
        wave = msg.wave;
        world = msg.world;
        baseHp = msg.baseHp;
        maxBaseHp = msg.maxBaseHp;
        return;
      }

      if (msg.t === "gameOver") {
        phase = "gameover";
        setStatus(`Game Over — Wave ${msg.wave}`);
        upgradePanel.style.display = "none";
        showGameOver(msg);
      }
    };
  }

  function renderLobby(players, hostId) {
    lobbyInfo.textContent = `Players: ${players.length}/4`;
    playerList.innerHTML = "";

    for (const p of players) {
      const div = document.createElement("div");
      div.className = "card";
      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      const hostMark = p.id === hostId ? " 👑" : "";
      const meMark = p.id === myId ? " (you)" : "";
      div.innerHTML = `
        <div style="color:${color.main}"><b>${p.name}</b>${hostMark}${meMark}</div>
        <div class="sub">Slot ${p.slot + 1} • ${color.name}</div>
      `;
      playerList.appendChild(div);
    }

    startBtn.style.display = (myId && myId === hostId) ? "inline-block" : "none";
  }

  function showUpgrades(options) {
    upgradePanel.style.display = "block";
    upgradeOptionsEl.innerHTML = "";

    for (const opt of options) {
      const b = document.createElement("button");
      b.className = "upg";
      const catColor = opt.category === "offensive" ? COLORS.red :
                       opt.category === "turret" ? COLORS.cyan :
                       opt.category === "defensive" ? COLORS.green : COLORS.purple;
      b.innerHTML = `
        <div class="icon">${opt.icon || "⬆"}</div>
        <div class="t">${opt.title}</div>
        <div class="d">${opt.desc}</div>
        <div class="cat" style="color:${catColor}">${opt.category}</div>
      `;
      b.onclick = () => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "pickUpgrade", key: opt.key }));
          upgradePanel.style.display = "none";
        }
      };
      upgradeOptionsEl.appendChild(b);
    }
  }

  function showGameOver(msg) {
    upgradePanel.style.display = "block";
    upgradeOptionsEl.innerHTML = `
      <div style="text-align:center; padding: 20px;">
        <h2 style="color: ${COLORS.red}; margin: 0 0 10px 0;">GAME OVER</h2>
        <p style="color: ${COLORS.white}; margin: 0 0 20px 0;">Reached Wave ${msg.wave}</p>
        <div style="text-align:left;">
          ${msg.scores ? msg.scores.map((s, i) => `
            <div style="color: ${PLAYER_COLORS[i]?.main || '#fff'}; margin: 5px 0;">
              ${i + 1}. ${s.name}: ${s.score} pts
            </div>
          `).join('') : ''}
        </div>
        <p style="color: ${COLORS.cyan}; margin-top: 20px;">Returning to lobby...</p>
      </div>
    `;
  }

  // --- UI events ---
  const initial = chooseInitialServer();
  serverEl.value = initial;

  connectBtn.onclick = () => connect(serverEl.value);

  saveNameBtn.onclick = () => {
    const nm = (nameEl.value || "").trim().slice(0, 16);
    localStorage.setItem("playerName", nm);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "hello", name: nm }));
  };

  startBtn.onclick = () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "start" }));
  };

  nameEl.value = localStorage.getItem("playerName") || "";

  // --- Canvas sizing ---
  function fitCanvas() {
    const maxW = Math.min(1200, window.innerWidth - 24);
    const aspect = 900 / 600;
    const w = maxW;
    const h = Math.round(w / aspect);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  window.addEventListener("resize", () => {
    fitCanvas();
    initStars();
  });
  fitCanvas();

  // --- Input handling ---
  function canvasToWorldX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    return nx * world.width;
  }

  canvas.addEventListener("mousemove", (e) => {
    mouseXWorld = canvasToWorldX(e.clientX);
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) shooting = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) shooting = false;
  });

  // Touch support
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    shooting = true;
    if (e.touches.length > 0) {
      mouseXWorld = canvasToWorldX(e.touches[0].clientX);
    }
  });
  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length > 0) {
      mouseXWorld = canvasToWorldX(e.touches[0].clientX);
    }
  });
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    shooting = false;
  });

  // --- Input sending loop ---
  function sendInput() {
    if (ws && ws.readyState === 1 && phase === "playing" && mySlot >= 0) {
      const segX0 = mySlot * world.segmentWidth;
      const aimXNorm = Math.max(0, Math.min(1, (mouseXWorld - segX0) / world.segmentWidth));
      ws.send(JSON.stringify({
        t: "input",
        aimXNorm: aimXNorm,
        shooting: shooting
      }));
    }
  }
  setInterval(sendInput, 33);

  // --- Neon rendering helpers ---
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16) || parseInt(hex.slice(1, 2).repeat(2), 16);
    const g = parseInt(hex.slice(3, 5), 16) || parseInt(hex.slice(2, 3).repeat(2), 16);
    const b = parseInt(hex.slice(5, 7), 16) || parseInt(hex.slice(3, 4).repeat(2), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawNeonLine(x1, y1, x2, y2, color, width = 2) {
    // Outer glow
    ctx.strokeStyle = hexToRgba(color, 0.3);
    ctx.lineWidth = width + 6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    
    // Inner glow
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.lineWidth = width + 2;
    ctx.stroke();
    
    // Core
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawNeonCircle(x, y, r, color, filled = true) {
    // Outer glow
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.2);
    ctx.fill();
    
    // Inner glow
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.4);
    ctx.fill();
    
    // Core
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = filled ? color : "transparent";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (filled) ctx.fill();
    ctx.stroke();
  }

  function drawNeonRect(x, y, w, h, color, filled = true) {
    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    
    ctx.fillStyle = filled ? hexToRgba(color, 0.8) : "transparent";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    if (filled) ctx.fill();
    ctx.stroke();
    
    ctx.shadowBlur = 0;
  }

  // --- Rendering ---
  let lastTime = performance.now();

  function draw() {
    requestAnimationFrame(draw);

    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Update screen shake
    screenShake *= 0.9;

    // Apply screen shake
    ctx.save();
    if (screenShake > 0.5) {
      ctx.translate(
        (Math.random() - 0.5) * screenShake,
        (Math.random() - 0.5) * screenShake
      );
    }

    // Clear with dark background
    ctx.fillStyle = COLORS.darkBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw animated stars
    const time = now / 1000;
    for (const star of stars) {
      star.y += star.speed * dt * 10;
      if (star.y > 1) star.y = 0;
      
      const twinkle = Math.sin(time * 2 + star.twinkle) * 0.3 + 0.7;
      ctx.fillStyle = `rgba(255,255,255,${twinkle * 0.6})`;
      ctx.beginPath();
      ctx.arc(
        star.x * canvas.width,
        star.y * canvas.height,
        star.size,
        0, Math.PI * 2
      );
      ctx.fill();
    }

    if (!lastSnap) {
      ctx.fillStyle = hexToRgba(COLORS.cyan, 0.8);
      ctx.font = "bold 18px 'Courier New', monospace";
      ctx.fillText("AWAITING CONNECTION...", 20, 35);
      ctx.restore();
      return;
    }

    const sx = canvas.width / world.width;
    const sy = canvas.height / world.height;
    const wx = (x) => x * sx;
    const wy = (y) => y * sy;

    // Grid lines (subtle)
    ctx.strokeStyle = hexToRgba(COLORS.cyan, 0.05);
    ctx.lineWidth = 1;
    for (let i = 0; i < world.width; i += 40) {
      ctx.beginPath();
      ctx.moveTo(wx(i), 0);
      ctx.lineTo(wx(i), canvas.height);
      ctx.stroke();
    }
    for (let i = 0; i < world.height; i += 40) {
      ctx.beginPath();
      ctx.moveTo(0, wy(i));
      ctx.lineTo(canvas.width, wy(i));
      ctx.stroke();
    }

    // Segment separators with neon glow
    const segCount = Math.max(1, Math.round(world.width / world.segmentWidth));
    for (let i = 1; i < segCount; i++) {
      const x = wx(i * world.segmentWidth);
      drawNeonLine(x, 0, x, canvas.height, COLORS.purple, 1);
    }

    // Ground line with intense glow
    const groundY = wy(560);
    drawNeonLine(0, groundY, canvas.width, groundY, COLORS.cyan, 3);

    // Draw slow field zones
    for (const p of lastSnap.players) {
      if (p.upgrades?.slowfield) {
        const segX0 = p.slot * world.segmentWidth;
        const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
        ctx.fillStyle = hexToRgba(color.main, 0.05);
        ctx.fillRect(wx(segX0), 0, wx(world.segmentWidth), groundY);
        
        // Animated waves
        ctx.strokeStyle = hexToRgba(color.main, 0.15);
        ctx.lineWidth = 1;
        for (let y = 0; y < groundY; y += 30) {
          ctx.beginPath();
          for (let x = wx(segX0); x < wx(segX0 + world.segmentWidth); x += 5) {
            const offset = Math.sin(time * 2 + x * 0.02 + y * 0.01) * 5;
            if (x === wx(segX0)) ctx.moveTo(x, y + offset);
            else ctx.lineTo(x, y + offset);
          }
          ctx.stroke();
        }
      }
    }

    // Draw shield indicators
    for (const p of lastSnap.players) {
      if (p.upgrades?.shieldActive > 0) {
        const segX0 = p.slot * world.segmentWidth;
        const cx = wx(segX0 + world.segmentWidth / 2);
        const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
        
        // Shield arc at bottom
        ctx.strokeStyle = hexToRgba(color.main, 0.6);
        ctx.lineWidth = 4;
        ctx.shadowColor = color.main;
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(cx, groundY, wx(world.segmentWidth / 2) - 10, Math.PI, 0);
        ctx.stroke();
        ctx.shadowBlur = 0;
        
        // Shield count
        ctx.fillStyle = color.main;
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.fillText(`🛡️ ${p.upgrades.shieldActive}`, cx, groundY + 25);
        ctx.textAlign = "left";
      }
    }

    // HUD - Top bar
    const hudHeight = 40;
    ctx.fillStyle = hexToRgba("#000", 0.6);
    ctx.fillRect(0, 0, canvas.width, hudHeight);
    
    // Wave indicator
    ctx.fillStyle = COLORS.yellow;
    ctx.font = "bold 16px 'Courier New', monospace";
    ctx.fillText(`WAVE ${wave}`, 15, 26);

    // Base HP bar
    const hpBarW = 200;
    const hpBarH = 16;
    const hpBarX = canvas.width / 2 - hpBarW / 2;
    const hpBarY = 12;
    const hpFrac = baseHp / maxBaseHp;
    const hpColor = hpFrac > 0.5 ? COLORS.green : hpFrac > 0.25 ? COLORS.orange : COLORS.red;
    
    ctx.fillStyle = hexToRgba("#000", 0.5);
    ctx.fillRect(hpBarX - 2, hpBarY - 2, hpBarW + 4, hpBarH + 4);
    
    ctx.fillStyle = hexToRgba(hpColor, 0.3);
    ctx.fillRect(hpBarX, hpBarY, hpBarW, hpBarH);
    
    ctx.fillStyle = hpColor;
    ctx.shadowColor = hpColor;
    ctx.shadowBlur = 10;
    ctx.fillRect(hpBarX, hpBarY, hpBarW * hpFrac, hpBarH);
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = COLORS.white;
    ctx.font = "bold 11px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText(`BASE: ${baseHp}/${maxBaseHp}`, canvas.width / 2, hpBarY + 12);
    ctx.textAlign = "left";

    // Scores
    ctx.font = "12px 'Courier New', monospace";
    let scoreX = canvas.width - 15;
    for (let i = lastSnap.players.length - 1; i >= 0; i--) {
      const p = lastSnap.players[i];
      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      ctx.fillStyle = color.main;
      ctx.textAlign = "right";
      ctx.fillText(`${p.name}: ${p.score}`, scoreX, 26);
      scoreX -= ctx.measureText(`${p.name}: ${p.score}`).width + 20;
    }
    ctx.textAlign = "left";

    // Particles (behind everything else)
    if (lastSnap.particles) {
      for (const p of lastSnap.particles) {
        const alpha = Math.min(1, p.life * 2);
        const size = 3 + (1 - p.life) * 5;
        ctx.fillStyle = hexToRgba(p.color, alpha);
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(wx(p.x), wy(p.y), size * sx, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Missiles (asteroids)
    for (const m of lastSnap.missiles) {
      const x = wx(m.x);
      const y = wy(m.y);
      const r = m.r * sx;
      
      // Outer glow based on type
      const asteroidColor = m.type === "large" ? COLORS.red :
                           m.type === "medium" ? COLORS.orange : COLORS.yellow;
      
      ctx.shadowColor = asteroidColor;
      ctx.shadowBlur = 15;
      
      // Draw rotating asteroid shape
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(m.rotation || 0);
      
      // Irregular asteroid shape
      ctx.fillStyle = hexToRgba(asteroidColor, 0.8);
      ctx.strokeStyle = asteroidColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const points = 8;
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const variance = 0.7 + Math.sin(i * 3.7) * 0.3;
        const px = Math.cos(angle) * r * variance;
        const py = Math.sin(angle) * r * variance;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      
      ctx.restore();
      ctx.shadowBlur = 0;

      // HP bar
      if (m.hp < m.maxHp) {
        const barW = r * 2;
        const barH = 4;
        const barY = y - r - 10;
        
        ctx.fillStyle = hexToRgba("#000", 0.6);
        ctx.fillRect(x - barW / 2 - 1, barY - 1, barW + 2, barH + 2);
        
        ctx.fillStyle = hexToRgba(COLORS.red, 0.5);
        ctx.fillRect(x - barW / 2, barY, barW, barH);
        
        const hpFrac = m.hp / m.maxHp;
        ctx.fillStyle = COLORS.green;
        ctx.fillRect(x - barW / 2, barY, barW * hpFrac, barH);
      }
    }

    // Bullets
    for (const b of lastSnap.bullets) {
      const x = wx(b.x);
      const y = wy(b.y);
      const r = b.r * sx;
      const color = b.color || COLORS.cyan;
      
      // Trail
      ctx.strokeStyle = hexToRgba(color, 0.4);
      ctx.lineWidth = r * 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - (b.vx || 0) * 0.02 * sx, y - (b.vy || 0) * 0.02 * sy);
      ctx.stroke();
      
      // Bullet core
      drawNeonCircle(x, y, r, color);
      
      // Crit indicator
      if (b.isCrit) {
        ctx.fillStyle = COLORS.yellow;
        ctx.font = "bold 10px sans-serif";
        ctx.fillText("!", x - 3, y - r - 5);
      }
    }

    // Turrets
    for (const p of lastSnap.players) {
      if (p.slot < 0) continue;

      const color = PLAYER_COLORS[p.slot] || PLAYER_COLORS[0];
      const segX0 = p.slot * world.segmentWidth;
      const cx = segX0 + world.segmentWidth / 2;
      const offset = world.segmentWidth * 0.22;

      const positions = [
        { x: cx - offset * 2, y: 560, kind: "slot" },
        { x: cx - offset, y: 560, kind: p.upgrades?.miniLeft ? "mini" : "slot" },
        { x: cx, y: 560, kind: "main" },
        { x: cx + offset, y: 560, kind: p.upgrades?.miniRight ? "mini" : "slot" },
        { x: cx + offset * 2, y: 560, kind: "slot" },
      ];

      for (const t of positions) {
        const tx = wx(t.x);
        const ty = wy(t.y);
        
        if (t.kind === "slot") {
          // Empty slot indicator
          ctx.strokeStyle = hexToRgba(color.main, 0.2);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.arc(tx, ty - 8, 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }

        const isMain = t.kind === "main";
        const baseW = isMain ? 36 : 24;
        const baseH = isMain ? 20 : 14;
        const barrelLen = isMain ? 35 : 22;
        const barrelW = isMain ? 8 : 5;

        // Turret base with glow
        ctx.shadowColor = color.main;
        ctx.shadowBlur = isMain ? 20 : 10;
        
        drawNeonRect(
          tx - baseW / 2,
          ty - baseH,
          baseW,
          baseH,
          color.main
        );

        // Barrel
        const angle = isMain ? (p.turretAngle || -Math.PI / 2) : -Math.PI / 2;
        
        ctx.save();
        ctx.translate(tx, ty - baseH / 2);
        ctx.rotate(angle + Math.PI / 2);
        
        // Barrel glow
        ctx.fillStyle = hexToRgba(color.main, 0.9);
        ctx.strokeStyle = COLORS.white;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-barrelW / 2, -barrelLen, barrelW, barrelLen, 2);
        ctx.fill();
        ctx.stroke();
        
        // Barrel tip glow when shooting
        if (isMain && p.isManual) {
          ctx.fillStyle = hexToRgba(COLORS.white, 0.8);
          ctx.beginPath();
          ctx.arc(0, -barrelLen, barrelW / 2 + 2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        ctx.restore();
        ctx.shadowBlur = 0;
      }

      // Player name
      ctx.fillStyle = color.main;
      ctx.font = "bold 13px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.shadowColor = color.main;
      ctx.shadowBlur = 5;
      ctx.fillText(p.name || `P${p.slot + 1}`, wx(cx), groundY + 22);
      
      // Mode indicator
      ctx.font = "10px 'Courier New', monospace";
      ctx.fillStyle = p.isManual ? COLORS.yellow : COLORS.green;
      ctx.fillText(p.isManual ? "MANUAL" : "AUTO", wx(cx), groundY + 35);
      
      ctx.shadowBlur = 0;
      ctx.textAlign = "left";
    }

    // Draw aim line for local player when manual shooting
    if (phase === "playing" && mySlot >= 0 && shooting) {
      const segX0 = mySlot * world.segmentWidth;
      const turretCx = segX0 + world.segmentWidth / 2;
      const color = PLAYER_COLORS[mySlot] || PLAYER_COLORS[0];
      
      ctx.strokeStyle = hexToRgba(color.main, 0.4);
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(wx(turretCx), groundY - 20);
      ctx.lineTo(wx(mouseXWorld), 50);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Crosshair at aim point
      const aimX = wx(mouseXWorld);
      const aimY = 50;
      ctx.strokeStyle = color.main;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(aimX - 10, aimY);
      ctx.lineTo(aimX + 10, aimY);
      ctx.moveTo(aimX, aimY - 10);
      ctx.lineTo(aimX, aimY + 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(aimX, aimY, 15, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Instructions overlay in lobby/upgrade phase
    if (phase === "lobby" || phase === "upgrades") {
      ctx.fillStyle = hexToRgba("#000", 0.7);
      ctx.fillRect(0, canvas.height - 60, canvas.width, 60);
      
      ctx.fillStyle = COLORS.cyan;
      ctx.font = "14px 'Courier New', monospace";
      ctx.textAlign = "center";
      
      if (phase === "lobby") {
        ctx.fillText("🎮 AUTO-FIRE: Turrets automatically target asteroids", canvas.width / 2, canvas.height - 38);
        ctx.fillText("🖱️ CLICK & HOLD: Manual aim override | 🎯 160° firing arc", canvas.width / 2, canvas.height - 18);
      } else {
        ctx.fillText("⬆️ SELECT AN UPGRADE ABOVE ⬆️", canvas.width / 2, canvas.height - 28);
      }
      ctx.textAlign = "left";
    }

    ctx.restore();
  }

  // Start render loop
  draw();

  // Auto-connect on page load
  connect(initial);

})();
