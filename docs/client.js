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
    // 1) URL param wins (shareable link)
    const qs = new URLSearchParams(location.search);
    const q = qs.get("server");
    if (q) return normalizeWsUrl(q);

    // 2) HTML prefill wins (index.html value="")
    const fromHtml = (serverEl.value || "").trim();
    if (fromHtml) return normalizeWsUrl(fromHtml);

    // 3) localStorage (but never allow github.io)
    const stored = (localStorage.getItem("serverUrl") || "").trim();
    const storedNorm = stored ? normalizeWsUrl(stored) : null;
    if (storedNorm && !isGithubWs(storedNorm)) return storedNorm;

    // 4) hard default (your Render)
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

  let lastSnap = null;

  // Input
  let mouseXWorld = 0;
  let shooting = false;
  let lastInputSend = 0;

  function connect(url) {
    const wsUrl = normalizeWsUrl(url);
    if (!wsUrl) {
      setStatus("No server URL.");
      return;
    }

    // Never store a github.io websocket (it will always fail)
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
      setStatus("Connection error (see console)");
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
        lastSnap = msg;
        phase = msg.phase;
        wave = msg.wave;
        world = msg.world;
        baseHp = msg.baseHp;
        return;
      }

      if (msg.t === "gameOver") {
        phase = "gameover";
        setStatus(`Game Over (reached wave ${msg.wave})`);
        upgradePanel.style.display = "none";
      }
    };
  }

  function renderLobby(players, hostId) {
    lobbyInfo.textContent = `Players: ${players.length}/4 — Host: ${hostId === myId ? "you" : "someone else"}`;
    playerList.innerHTML = "";

    for (const p of players) {
      const div = document.createElement("div");
      div.className = "card";
      const hostMark = p.id === hostId ? " ⭐" : "";
      const meMark = p.id === myId ? " (you)" : "";
      div.innerHTML = `<div><b>${p.name}</b>${hostMark}${meMark}</div><div class="sub">Slot ${p.slot + 1}</div>`;
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
      b.innerHTML = `<div class="t">${opt.title}</div><div class="d">${opt.desc}</div>`;
      b.onclick = () => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "pickUpgrade", key: opt.key }));
          upgradePanel.style.display = "none";
        }
      };
      upgradeOptionsEl.appendChild(b);
    }
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
    const maxW = Math.min(980, window.innerWidth - 24);
    const aspect = 900 / 600;
    const w = maxW;
    const h = Math.round(w / aspect);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  window.addEventListener("resize", fitCanvas);
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

  // Touch support for mobile
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
      // Convert world X to normalized X within player's segment
      const segX0 = mySlot * world.segmentWidth;
      const aimXNorm = Math.max(0, Math.min(1, (mouseXWorld - segX0) / world.segmentWidth));
      
      ws.send(JSON.stringify({
        t: "input",
        aimXNorm: aimXNorm,
        shooting: shooting
      }));
    }
  }

  // Send input at ~30fps
  setInterval(sendInput, 33);

  // --- Rendering ---
  function draw() {
    requestAnimationFrame(draw);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!lastSnap) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "16px system-ui";
      ctx.fillText("Waiting for server state…", 18, 28);
      return;
    }

    const sx = canvas.width / world.width;
    const sy = canvas.height / world.height;
    const wx = (x) => x * sx;
    const wy = (y) => y * sy;

    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "rgba(255,255,255,0.06)");
    g.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Segment separators
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    const segCount = Math.max(1, Math.round(world.width / world.segmentWidth));
    for (let i = 1; i < segCount; i++) {
      const x = wx(i * world.segmentWidth);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }

    // Ground line
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, wy(560));
    ctx.lineTo(canvas.width, wy(560));
    ctx.stroke();

    // HUD
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "14px system-ui";
    ctx.fillText(`Wave: ${wave}   Base HP: ${baseHp}`, 14, 22);

    // Missiles
    for (const m of lastSnap.missiles) {
      ctx.fillStyle = "rgba(255,120,120,0.95)";
      ctx.beginPath();
      ctx.arc(wx(m.x), wy(m.y), m.r * sx, 0, Math.PI * 2);
      ctx.fill();

      // HP bar background
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(wx(m.x - m.r), wy(m.y - m.r - 10), (m.r * 2) * sx, 6);

      // HP bar fill
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      const frac = Math.max(0, Math.min(1, m.hp / 6));
      ctx.fillRect(wx(m.x - m.r), wy(m.y - m.r - 10), (m.r * 2) * sx * frac, 6);
    }

    // Bullets
    ctx.fillStyle = "rgba(200,230,255,0.95)";
    for (const b of lastSnap.bullets) {
      ctx.beginPath();
      ctx.arc(wx(b.x), wy(b.y), b.r * sx, 0, Math.PI * 2);
      ctx.fill();
    }

    // Turrets
    for (const p of lastSnap.players) {
      if (p.slot < 0) continue;

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
        if (t.kind === "main") {
          ctx.fillStyle = "rgba(124,92,255,0.9)";
        } else if (t.kind === "mini") {
          ctx.fillStyle = "rgba(124,92,255,0.7)";
        } else {
          ctx.fillStyle = "rgba(60,60,80,0.5)";
        }

        // Turret base
        const baseW = t.kind === "main" ? 28 : 18;
        const baseH = t.kind === "main" ? 18 : 12;
        ctx.fillRect(wx(t.x) - baseW * sx / 2, wy(t.y) - baseH * sy, baseW * sx, baseH * sy);

        // Turret barrel (only for main and mini)
        if (t.kind !== "slot") {
          const barrelLen = t.kind === "main" ? 30 : 20;
          const barrelW = t.kind === "main" ? 6 : 4;
          const angle = t.kind === "main" ? (p.turretAngle || -Math.PI / 2) : -Math.PI / 2;

          ctx.save();
          ctx.translate(wx(t.x), wy(t.y) - baseH * sy / 2);
          ctx.rotate(angle + Math.PI / 2);
          ctx.fillStyle = t.kind === "main" ? "rgba(180,160,255,0.95)" : "rgba(140,120,200,0.85)";
          ctx.fillRect(-barrelW * sx / 2, 0, barrelW * sx, -barrelLen * sy);
          ctx.restore();
        }
      }

      // Player name label
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(p.name || `P${p.slot + 1}`, wx(cx), wy(560) + 16);
      ctx.textAlign = "left";
    }

    // Draw aim line for local player
    if (phase === "playing" && mySlot >= 0) {
      const segX0 = mySlot * world.segmentWidth;
      const cx = segX0 + world.segmentWidth / 2;
      
      ctx.strokeStyle = "rgba(124,92,255,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(wx(cx), wy(560 - 18));
      ctx.lineTo(wx(mouseXWorld), wy(120));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Start render loop
  draw();

  // Auto-connect on page load
  connect(initial);

})();
