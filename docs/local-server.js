// local-server.js - Complete local game server for solo mode
// This is a direct port of server.js game logic for offline play

const LocalServer = {
  // ===== Constants (matching server.js exactly) =====
  TICK_RATE: 30,
  DT: 1/30,
  WORLD_H: 600,
  GROUND_Y: 560,
  SEGMENT_W: 360,
  BASE_HP: 8,
  BULLET_R: 2.5,
  BULLET_SPEED: 175,
  BULLET_COOLDOWN: 0.72,
  BULLET_DAMAGE: 1.25,
  BULLET_LIFESPAN: 6.0,
  ASTEROID_R_MIN: 8,
  ASTEROID_R_MAX: 16,
  WAVE_BASE_COUNT: 3,
  WAVE_COUNT_SCALE: 2,
  MAX_AIM_ANGLE: (80 * Math.PI) / 180,
  UPGRADE_TIMEOUT: 10,
  WAVE_CLEAR_DELAY: 1000,
  SPAWN_INTERVAL: 0.3,

  TOWER_TYPES: {
    0: { name: "Gatling", cost: 50, damage: 1, cooldown: 0.25, rangeMult: 0.8, color: "#ffff00", upgradeCost: 40, bulletType: "gatling" },
    1: { name: "Sniper", cost: 120, damage: 5, cooldown: 1.2, rangeMult: 1.5, color: "#00ff00", upgradeCost: 80, bulletType: "sniper" },
    2: { name: "Missile", cost: 250, damage: 8, cooldown: 2.0, rangeMult: 1.0, color: "#ff0000", explosive: 1, upgradeCost: 150, bulletType: "missile" }
  },
  MAX_TOWER_LEVEL: 5,

  ATTACK_TYPES: {
    swarm: { name: "Swarm", cost: 15, count: 4, baseHp: 1, hpScale: 1.2, size: "small", speed: 1.3, desc: "4 fast weak asteroids", color: "#ffcc00", icon: "🐝" },
    bruiser: { name: "Bruiser", cost: 45, count: 1, baseHp: 5, hpScale: 1.5, size: "large", speed: 0.6, desc: "Very tanky asteroid", color: "#ff4444", icon: "🪨" },
    bomber: { name: "Bomber", cost: 55, count: 1, baseHp: 3, hpScale: 1.0, size: "medium", speed: 1.0, explosive: true, explosionDamage: 2, desc: "Explodes dealing damage", color: "#ff00ff", icon: "💣" },
    splitter: { name: "Splitter", cost: 50, count: 1, baseHp: 4, hpScale: 1.3, size: "large", speed: 0.75, splits: 4, desc: "Splits into 4 on death", color: "#00ffff", icon: "💎" },
    ghost: { name: "Ghost", cost: 40, count: 2, baseHp: 2, hpScale: 1.2, size: "medium", speed: 1.1, phasing: true, desc: "Phases through hits", color: "#8800ff", icon: "👻" }
  },

  RARITY_CONFIG: {
    common: { weight: 75, color: "#ffffff", scale: 1.0, label: "COMMON" },
    rare: { weight: 17, color: "#00ffff", scale: 1.5, label: "RARE" },
    epic: { weight: 6, color: "#bf00ff", scale: 2.5, label: "EPIC" },
    legendary: { weight: 2, color: "#ffaa00", scale: 4.0, label: "LEGENDARY" },
  },

  UPGRADE_DEFS: [
    { id: "dmg", name: "Heavy Rounds", cat: "offense", icon: "💥", desc: "+{val} Damage", stat: "damageAdd", base: 0.5, type: "add" },
    { id: "spd", name: "Velocity", cat: "offense", icon: "💨", desc: "+{val}% Bullet Speed", stat: "bulletSpeedMult", base: 0.08, type: "mult" },
    { id: "fire", name: "Rapid Fire", cat: "offense", icon: "⚡", desc: "+{val}% Fire Rate", stat: "fireRateMult", base: 0.05, type: "mult" },
    { id: "multi", name: "Multishot", cat: "offense", icon: "⚔️", desc: "+{val} Bullets (-{penalty}% dmg)", stat: "multishot", base: 1, type: "multishot" },
    { id: "crit", name: "Crit Scope", cat: "offense", icon: "🎯", desc: "+{val}% Crit Chance", stat: "critChance", base: 0.05, type: "add_cap", cap: 1.0 },
    { id: "boom", name: "Explosive", cat: "offense", icon: "💣", desc: "Explosions size +{val}", stat: "explosive", base: 1, type: "add" },
    { id: "life", name: "Stabilizer", cat: "utility", icon: "⏱️", desc: "+{val}s Bullet Life", stat: "lifespanAdd", base: 0.75, type: "add" },
    { id: "rico", name: "Ricochet", cat: "utility", icon: "🎱", desc: "Bounces {val} times", stat: "ricochet", base: 1, type: "add" },
    { id: "pierce", name: "Railgun", cat: "utility", icon: "📌", desc: "Pierces {val} enemies", stat: "pierce", base: 1, type: "add" },
    { id: "chain", name: "Tesla Coil", cat: "utility", icon: "⚡", desc: "Chain Lightning", stat: "chain", base: 1, type: "bool" },
    { id: "shield", name: "Shield Gen", cat: "defense", icon: "🛡️", desc: "Block {val} Hits/Wave", stat: "shield", base: 1, type: "add" },
    { id: "slow", name: "Grav Field", cat: "defense", icon: "🌀", desc: "Slow Enemies", stat: "slowfield", base: 1, type: "bool" },
    { id: "income", name: "War Profiteer", cat: "economy", icon: "💰", desc: "+{val}% Gold Gain", stat: "goldMult", base: 0.12, type: "mult" },
  ],

  // ===== State =====
  phase: "lobby",
  wave: 0,
  player: null,
  missiles: [],
  bullets: [],
  particles: [],
  damageNumbers: [],
  spawnQueue: [],
  spawnTimer: 0,
  upgradeOptions: [],
  upgradePicked: false,
  upgradePhaseStart: 0,
  waveClearedTime: 0,
  rerollCount: 0,
  tickInterval: null,
  messageHandler: null,

  // ===== Utility Functions =====
  uid() {
    return Math.random().toString(36).substr(2, 9);
  },

  rand(a, b) {
    return a + Math.random() * (b - a);
  },

  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  },

  // ===== Initialization =====
  init(playerName, onMessage) {
    this.messageHandler = onMessage;
    this.phase = "playing";
    this.wave = 1;
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.damageNumbers = [];
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.waveClearedTime = 0;
    this.rerollCount = 0;
    this.upgradePicked = false;

    this.player = {
      id: "solo",
      slot: 0,
      name: playerName || "Player",
      gold: 30,
      hp: this.BASE_HP,
      maxHp: this.BASE_HP,
      score: 0,
      kills: 0,
      damageDealt: 0,
      waveDamage: 0,
      cooldown: 0,
      turretAngle: -Math.PI / 2,
      targetX: this.SEGMENT_W / 2,
      targetY: 0,
      manualShooting: false,
      towers: [null, null, null, null],
      upgrades: {},
    };

    this.spawnWave();

    // Send started message
    this.send({
      t: "started",
      world: { width: this.SEGMENT_W, height: this.WORLD_H, segmentWidth: this.SEGMENT_W },
      wave: this.wave,
      solo: true
    });

    // Start game loop
    this.tickInterval = setInterval(() => this.tick(), 1000 / this.TICK_RATE);
  },

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  },

  send(msg) {
    if (this.messageHandler) {
      this.messageHandler(msg);
    }
  },

  // ===== Message Handling =====
  handleMessage(msg) {
    const p = this.player;

    if (msg.t === "input") {
      p.targetX = msg.x;
      p.targetY = msg.y;
      p.manualShooting = msg.shooting;
    }

    if (msg.t === "pickUpgrade" && this.phase === "upgrades" && !this.upgradePicked) {
      const opt = this.upgradeOptions.find(o => o.key === msg.key);
      if (opt) {
        this.applyUpgrade(opt);
        this.upgradePicked = true;
        this.send({ t: "picked", key: msg.key });
        
        setTimeout(() => {
          this.wave++;
          this.phase = "playing";
          this.spawnWave();
          this.send({ t: "wave", wave: this.wave });
        }, 500);
      }
    }

    if (msg.t === "rerollUpgrades" && this.phase === "upgrades" && !this.upgradePicked) {
      const cost = this.getRerollCost();
      if (p.gold >= cost) {
        p.gold -= cost;
        this.rerollCount++;
        this.upgradeOptions = this.makeUpgradeOptions();
        this.send({
          t: "upgrade",
          options: this.upgradeOptions,
          deadline: this.upgradePhaseStart + this.UPGRADE_TIMEOUT * 1000,
          rerollCost: this.getRerollCost()
        });
      }
    }

    if (msg.t === "buyTower" && this.phase === "playing") {
      const { slotIndex, type } = msg;
      const towerDef = this.TOWER_TYPES[type];
      if (!towerDef || slotIndex < 0 || slotIndex > 3) return;
      if (p.towers[slotIndex]) return;
      if (p.gold >= towerDef.cost) {
        p.gold -= towerDef.cost;
        p.towers[slotIndex] = { type, level: 1, cd: 0, angle: -Math.PI/2 };
      }
    }

    if (msg.t === "upgradeTower" && this.phase === "playing") {
      const { slotIndex } = msg;
      const tower = p.towers[slotIndex];
      if (!tower || tower.level >= this.MAX_TOWER_LEVEL) return;
      const cost = this.TOWER_TYPES[tower.type].upgradeCost * tower.level;
      if (p.gold >= cost) {
        p.gold -= cost;
        tower.level++;
      }
    }

    if (msg.t === "sellTower" && this.phase === "playing") {
      const { slotIndex } = msg;
      const tower = p.towers[slotIndex];
      if (!tower) return;
      const baseCost = this.TOWER_TYPES[tower.type].cost;
      const upgCost = this.TOWER_TYPES[tower.type].upgradeCost;
      let totalSpent = baseCost;
      for (let l = 1; l < tower.level; l++) totalSpent += upgCost * l;
      p.gold += Math.floor(totalSpent * 0.5);
      p.towers[slotIndex] = null;
    }

    if (msg.t === "returnToLobby") {
      this.stop();
      this.phase = "lobby";
    }
  },

  // ===== Upgrade System =====
  getRerollCost() {
    return Math.floor(10 * Math.pow(1.5, this.rerollCount));
  },

  rollRarity() {
    const rand = Math.random() * 100;
    let accum = 0;
    if ((accum += this.RARITY_CONFIG.common.weight) >= rand) return "common";
    if ((accum += this.RARITY_CONFIG.rare.weight) >= rand) return "rare";
    if ((accum += this.RARITY_CONFIG.epic.weight) >= rand) return "epic";
    return "legendary";
  },

  makeUpgradeOptions() {
    const p = this.player;
    const opts = [];
    for (let i = 0; i < 3; i++) {
      const def = this.UPGRADE_DEFS[Math.floor(Math.random() * this.UPGRADE_DEFS.length)];
      if (opts.find(o => o.defId === def.id)) { i--; continue; }
      if (def.type === "bool" && p.upgrades[def.stat]) { i--; continue; }
      if (def.stat === "critChance" && (p.upgrades.critChance || 0) >= 1) { i--; continue; }

      const rarityKey = this.rollRarity();
      const rarity = this.RARITY_CONFIG[rarityKey];

      let val = def.base;
      let desc = def.desc;
      let effect = { stat: def.stat, type: def.type };

      if (def.type === "multishot") {
        val = rarityKey === "legendary" ? 3 : rarityKey === "epic" ? 2 : 1;
        const penalty = val === 1 ? 35 : val === 2 ? 60 : 85;
        desc = def.desc.replace("{val}", val).replace("{penalty}", penalty);
        effect.val = val;
        effect.penalty = penalty / 100;
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
      } else if (def.type === "bool") {
        effect.val = 1;
      }

      opts.push({
        key: this.uid(),
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
  },

  applyUpgrade(card) {
    const u = this.player.upgrades;
    const eff = card.effect;

    if (eff.type === "add" || eff.type === "add_cap") {
      u[eff.stat] = (u[eff.stat] || 0) + eff.val;
    } else if (eff.type === "mult") {
      u[eff.stat] = (u[eff.stat] || 1) * (1 + eff.val);
    } else if (eff.type === "bool") {
      u[eff.stat] = true;
    } else if (eff.type === "multishot") {
      u.multishot = (u.multishot || 1) + eff.val;
      const newPenalty = 1 - eff.penalty;
      u.multishotDmgMult = (u.multishotDmgMult || 1) * newPenalty;
    }
  },

  // ===== Wave Spawning =====
  spawnWave() {
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.damageNumbers = [];
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.waveClearedTime = 0;
    this.player.waveDamage = 0;

    if (this.player.upgrades.shield) {
      this.player.upgrades.shieldActive = this.player.upgrades.shield;
    }

    const waveHpScale = this.wave * 0.8;
    // Solo gets full asteroid count
    const count = this.WAVE_BASE_COUNT + Math.floor(this.wave * this.WAVE_COUNT_SCALE);

    for (let i = 0; i < count; i++) {
      const largeChance = Math.min(0.15 + this.wave * 0.015, 0.30);
      const mediumChance = 0.35;
      const sizeRoll = Math.random();
      let type, r;

      if (sizeRoll < largeChance) {
        type = "large";
        r = this.rand(15, this.ASTEROID_R_MAX);
      } else if (sizeRoll < largeChance + mediumChance) {
        type = "medium";
        r = this.rand(11, 14);
      } else {
        type = "small";
        r = this.rand(this.ASTEROID_R_MIN, 10);
      }

      const baseHpVal = type === "large" ? 3 : type === "medium" ? 1.5 : 0.75;
      const hp = Math.ceil(baseHpVal + waveHpScale);
      const x = this.rand(r + 20, this.SEGMENT_W - r - 20);
      const y = this.rand(-r - 10, -r);

      this.spawnQueue.push({
        x, y, type, hp, r,
        targetSlot: 0,
        attackType: null,
        vx: this.rand(-15, 15),
        vy: this.rand(30, 50),
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: this.rand(-2, 2),
      });
    }

    // Shuffle spawn queue
    for (let i = this.spawnQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.spawnQueue[i], this.spawnQueue[j]] = [this.spawnQueue[j], this.spawnQueue[i]];
    }
  },

  // ===== Main Game Loop =====
  tick() {
    if (this.phase !== "playing" && this.phase !== "upgrades") return;

    const p = this.player;
    const DT = this.DT;

    if (this.phase === "upgrades") {
      // Check timeout
      if (Date.now() > this.upgradePhaseStart + this.UPGRADE_TIMEOUT * 1000 && !this.upgradePicked) {
        if (this.upgradeOptions.length > 0) {
          const opt = this.upgradeOptions[0];
          this.applyUpgrade(opt);
          this.upgradePicked = true;
          this.send({ t: "picked", key: opt.key, auto: true });
          this.wave++;
          this.phase = "playing";
          this.spawnWave();
          this.send({ t: "wave", wave: this.wave });
        }
      }
      this.broadcastState();
      return;
    }

    // Process spawn queue
    this.spawnTimer -= DT;
    if (this.spawnTimer <= 0 && this.spawnQueue.length > 0) {
      const toSpawn = Math.random() < 0.3 ? 2 : 1;
      for (let i = 0; i < toSpawn && this.spawnQueue.length > 0; i++) {
        const data = this.spawnQueue.shift();
        const waveSpeedBonus = this.wave >= 5 ? 1 + (this.wave - 5) * 0.02 : 1;

        // FTL entry
        const ftlThreshold = this.rand(30, 100);

        this.missiles.push({
          id: this.uid(),
          x: data.x,
          y: -50 - Math.random() * 100,
          vx: data.vx,
          vy: data.vy * waveSpeedBonus,
          r: data.r,
          hp: data.hp,
          maxHp: data.hp,
          type: data.type,
          targetSlot: 0,
          attackType: data.attackType,
          dead: false,
          rotation: data.rotation,
          rotSpeed: data.rotSpeed,
          inFTL: true,
          ftlThreshold: ftlThreshold,
        });
      }
      this.spawnTimer = this.SPAWN_INTERVAL + this.rand(-0.1, 0.1);
    }

    // Player aiming
    const turretX = this.SEGMENT_W / 2;
    const turretY = this.GROUND_Y;

    let targetX = p.targetX;
    let targetY = p.targetY;

    if (!p.manualShooting) {
      const target = this.findBestTarget(turretX, turretY);
      if (target) {
        targetX = target.x;
        targetY = target.y;
      }
    }

    const clamped = this.clampAimAngle(turretX, turretY, targetX, targetY);
    p.turretAngle = clamped.angle;
    targetX = clamped.x;
    targetY = clamped.y;

    // Player firing
    p.cooldown -= DT;
    const hasTargets = this.missiles.some(m => !m.dead && m.y > 0);
    if (p.cooldown <= 0 && hasTargets) {
      const cd = this.BULLET_COOLDOWN / (p.upgrades.fireRateMult || 1);
      p.cooldown = cd;
      this.fireWithMultishot(turretX, turretY, targetX, targetY);
    }

    // Tower updates
    for (let i = 0; i < p.towers.length; i++) {
      const tower = p.towers[i];
      if (!tower) continue;
      
      const towerX = 60 + i * 80;
      const towerY = this.GROUND_Y - 30;
      const towerDef = this.TOWER_TYPES[tower.type];
      
      // Find target
      const target = this.findBestTarget(towerX, towerY);
      if (target) {
        tower.angle = Math.atan2(target.y - towerY, target.x - towerX);
        
        tower.cd = (tower.cd || 0) - DT;
        if (tower.cd <= 0) {
          this.fireTowerBullet(tower, towerDef, towerX, towerY, target.x, target.y);
          tower.cd = towerDef.cooldown / (1 + (tower.level - 1) * 0.1);
        }
      } else {
        tower.angle = -Math.PI / 2;
        tower.cd = Math.max(0, (tower.cd || 0) - DT);
      }
    }

    // Update missiles
    for (const m of this.missiles) {
      if (m.dead) continue;

      // Ghost phasing
      if (m.phaseTimer !== undefined) {
        m.phaseTimer += DT;
        m.isPhased = Math.sin(m.phaseTimer * 4) > 0.5;
      }

      // FTL entry
      if (m.inFTL) {
        const ftlSpeed = 8;
        m.y += m.vy * DT * ftlSpeed;
        m.x += m.vx * DT * 0.3;
        m.rotation += m.rotSpeed * DT * 3;
        if (m.y >= m.ftlThreshold) {
          m.inFTL = false;
          this.createExplosion(m.x, m.y, 15, "#88f");
        }
        continue;
      }

      let speedMult = p.upgrades.slowfield ? 0.75 : 1;

      m.x += m.vx * DT * speedMult;
      m.y += m.vy * DT * speedMult;
      m.rotation += m.rotSpeed * DT;

      // Bounce off walls
      if (m.x - m.r < 0) { m.x = m.r; m.vx = Math.abs(m.vx); }
      if (m.x + m.r > this.SEGMENT_W) { m.x = this.SEGMENT_W - m.r; m.vx = -Math.abs(m.vx); }

      // Hit ground
      if (m.y + m.r >= this.GROUND_Y) {
        let blocked = false;

        if (p.upgrades.shieldActive > 0) {
          p.upgrades.shieldActive--;
          blocked = true;
          this.createExplosion(m.x, this.GROUND_Y - 5, 30, "#0ff");
        }

        m.dead = true;

        if (!blocked) {
          const damage = m.explosive ? 2 : 1;
          p.hp = Math.max(0, p.hp - damage);
          this.createExplosion(m.x, this.GROUND_Y - 5, m.explosive ? 60 : 40, m.explosive ? "#ff00ff" : "#f44");

          if (p.hp <= 0) {
            this.endGame();
            return;
          }
        }
      }
    }

    // Update bullets - homing
    for (const b of this.bullets) {
      if (b.dead) continue;

      if (b.magnet) {
        let nearest = null;
        let nearestDist = 400;
        for (const m of this.missiles) {
          if (m.dead || m.isPhased || m.inFTL) continue;
          const d = Math.hypot(m.x - b.x, m.y - b.y);
          if (d < nearestDist) { nearestDist = d; nearest = m; }
        }
        if (nearest) {
          const dx = nearest.x - b.x;
          const dy = nearest.y - b.y;
          const len = Math.hypot(dx, dy) || 1;
          const homingStrength = 1500 * DT;
          b.vx += (dx / len) * homingStrength;
          b.vy += (dy / len) * homingStrength;
          const speed = Math.hypot(b.vx, b.vy);
          const targetSpeed = this.BULLET_SPEED * 1.2;
          b.vx = (b.vx / speed) * targetSpeed;
          b.vy = (b.vy / speed) * targetSpeed;
        }
      }

      b.x += b.vx * DT;
      b.y += b.vy * DT;
      b.lifespan -= DT;

      if (b.lifespan <= 0) { b.dead = true; continue; }

      // Ricochet
      let didRicochet = false;
      if (b.x < 0) {
        if (b.ricochet > 0) { b.x = 0; b.vx = -b.vx; b.ricochet--; didRicochet = true; }
        else { b.dead = true; }
      }
      if (b.x > this.SEGMENT_W) {
        if (b.ricochet > 0) { b.x = this.SEGMENT_W; b.vx = -b.vx; b.ricochet--; didRicochet = true; }
        else { b.dead = true; }
      }
      if (b.y < -50) {
        if (b.ricochet > 0) { b.y = -50; b.vy = -b.vy; b.ricochet--; didRicochet = true; }
        else { b.dead = true; }
      }
      if (b.y > this.GROUND_Y) {
        if (b.ricochet > 0) { b.y = this.GROUND_Y; b.vy = -b.vy; b.ricochet--; didRicochet = true; }
        else { b.dead = true; }
      }
      if (didRicochet) b.hitList = [];
    }

    // Bullet-asteroid collisions
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const m of this.missiles) {
        if (m.dead || m.inFTL) continue;
        if (m.isPhased && Math.random() > 0.3) continue;
        if (b.hitList && b.hitList.includes(m.id)) continue;

        const dx = m.x - b.x;
        const dy = m.y - b.y;
        const rr = m.r + b.r;

        if (dx * dx + dy * dy <= rr * rr) {
          m.hp -= b.dmg;
          if (!b.hitList) b.hitList = [];
          b.hitList.push(m.id);
          if (b.pierce > 0) { b.pierce--; } else { b.dead = true; }

          this.addDamageNumber(m.x, m.y - m.r, b.dmg, b.isCrit);
          p.damageDealt += b.dmg;
          p.waveDamage += b.dmg;

          // Explosion
          if (b.explosive > 0) {
            const radius = 20 + b.explosive * 8;
            for (const m2 of this.missiles) {
              if (m2.dead || m2.id === m.id || m2.inFTL) continue;
              const d = Math.hypot(m2.x - m.x, m2.y - m.y);
              if (d < radius + m2.r) {
                const splashDmg = b.dmg * 0.5;
                m2.hp -= splashDmg;
                this.addDamageNumber(m2.x, m2.y - m2.r, splashDmg, false);
                p.damageDealt += splashDmg;
                p.waveDamage += splashDmg;
              }
            }
            this.createExplosion(m.x, m.y, radius, "#ff8800");
          }

          // Chain lightning
          if (b.chain) {
            const chainTargets = [];
            for (const m2 of this.missiles) {
              if (m2.dead || m2.id === m.id || m2.inFTL) continue;
              const d = Math.hypot(m2.x - m.x, m2.y - m.y);
              if (d < 100) chainTargets.push({ m: m2, d });
            }
            chainTargets.sort((a, cb) => a.d - cb.d);
            for (let ci = 0; ci < Math.min(2, chainTargets.length); ci++) {
              const chainDmg = b.dmg * 0.4;
              chainTargets[ci].m.hp -= chainDmg;
              this.addDamageNumber(chainTargets[ci].m.x, chainTargets[ci].m.y - chainTargets[ci].m.r, chainDmg, false);
              p.damageDealt += chainDmg;
            }
          }

          // Kill check
          if (m.hp <= 0) {
            m.dead = true;
            this.createExplosion(m.x, m.y, 25, "#fa0");
            p.score += 50;
            p.kills++;
            const goldGain = Math.round((3 + Math.floor(this.wave / 3)) * (p.upgrades.goldMult || 1));
            p.gold += goldGain;

            // Splitter
            if (m.splits) {
              for (let si = 0; si < m.splits; si++) {
                const angle = (si / m.splits) * Math.PI * 2 + Math.random() * 0.5;
                const childHp = Math.ceil(m.maxHp * 0.3);
                this.missiles.push({
                  id: this.uid(),
                  x: m.x + Math.cos(angle) * 15,
                  y: m.y + Math.sin(angle) * 15,
                  vx: Math.cos(angle) * 40 + this.rand(-10, 10),
                  vy: Math.abs(Math.sin(angle) * 30) + 20,
                  r: 6,
                  hp: childHp,
                  maxHp: childHp,
                  type: "small",
                  targetSlot: m.targetSlot,
                  attackType: m.attackType,
                  dead: false,
                  rotation: Math.random() * Math.PI * 2,
                  rotSpeed: this.rand(-3, 3),
                });
              }
            }
          }

          break;
        }
      }
    }

    // Clean up
    this.bullets = this.bullets.filter(b => !b.dead);
    this.missiles = this.missiles.filter(m => !m.dead);

    // Update particles
    for (const part of this.particles) {
      part.x += part.vx * DT;
      part.y += part.vy * DT;
      part.life -= DT;
      part.alpha = Math.max(0, part.life / part.maxLife);
    }
    this.particles = this.particles.filter(pa => pa.life > 0);

    // Update damage numbers
    for (const dn of this.damageNumbers) {
      dn.age += DT;
      dn.y -= 40 * DT;
    }
    this.damageNumbers = this.damageNumbers.filter(d => d.age < 0.8);

    // Check wave complete
    if (this.missiles.length === 0 && this.spawnQueue.length === 0) {
      if (this.waveClearedTime === 0) {
        this.waveClearedTime = Date.now();
      } else if (Date.now() - this.waveClearedTime >= this.WAVE_CLEAR_DELAY) {
        this.beginUpgradePhase();
      }
    } else {
      this.waveClearedTime = 0;
    }

    this.broadcastState();
  },

  // ===== Targeting =====
  findBestTarget(turretX, turretY) {
    let best = null;
    let bestScore = -Infinity;
    for (const m of this.missiles) {
      if (m.dead || m.y < 0 || m.inFTL) continue;
      const danger = m.y / this.GROUND_Y;
      const dist = Math.hypot(m.x - turretX, m.y - turretY);
      const score = danger * 1000 - dist * 0.1;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  },

  clampAimAngle(turretX, turretY, targetX, targetY) {
    const dx = targetX - turretX;
    const dy = targetY - turretY;
    let angle = Math.atan2(dy, dx);
    const fromVertical = angle - (-Math.PI / 2);
    const clampedFromVertical = this.clamp(fromVertical, -this.MAX_AIM_ANGLE, this.MAX_AIM_ANGLE);
    const clampedAngle = -Math.PI / 2 + clampedFromVertical;
    const dist = Math.hypot(dx, dy);
    return {
      x: turretX + Math.cos(clampedAngle) * dist,
      y: turretY + Math.sin(clampedAngle) * dist,
      angle: clampedAngle
    };
  },

  // ===== Firing =====
  fireWithMultishot(originX, originY, targetX, targetY) {
    const shots = this.player.upgrades.multishot || 1;
    const spread = 0.10;
    this.fireBullet(originX, originY, targetX, targetY, 0);
    for (let i = 1; i < shots; i++) {
      const side = (i % 2 === 1) ? -1 : 1;
      const layer = Math.ceil(i / 2);
      const offset = side * layer * spread;
      this.fireBullet(originX, originY, targetX, targetY, offset);
    }
  },

  fireBullet(originX, originY, targetX, targetY, angleOffset) {
    const p = this.player;
    const u = p.upgrades;

    let dmg = this.BULLET_DAMAGE + (u.damageAdd || 0);
    dmg *= (u.multishotDmgMult || 1);
    const speed = this.BULLET_SPEED * (u.bulletSpeedMult || 1);
    const isCrit = Math.random() < (u.critChance || 0);
    const finalDmg = isCrit ? dmg * 3 : dmg;

    let dx = targetX - originX;
    let dy = targetY - originY;
    let len = Math.hypot(dx, dy) || 1;

    if (angleOffset !== 0) {
      const angle = Math.atan2(dy, dx) + angleOffset;
      dx = Math.cos(angle) * len;
      dy = Math.sin(angle) * len;
    }

    this.bullets.push({
      id: this.uid(),
      ownerId: p.id,
      ownerSlot: 0,
      x: originX,
      y: originY - 6,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      r: this.BULLET_R,
      dmg: finalDmg,
      isCrit: isCrit,
      explosive: u.explosive || 0,
      lifespan: this.BULLET_LIFESPAN + (u.lifespanAdd || 0),
      bulletType: "main",
      magnet: true,
      chain: !!u.chain,
      ricochet: u.ricochet || 0,
      pierce: u.pierce || 0,
      hitList: [],
    });
  },

  fireTowerBullet(tower, towerDef, originX, originY, targetX, targetY) {
    const dx = targetX - originX;
    const dy = targetY - originY;
    const len = Math.hypot(dx, dy) || 1;
    const speed = this.BULLET_SPEED * (towerDef.bulletType === "sniper" ? 1.5 : 1);
    const dmg = Math.round(towerDef.damage * (1 + (tower.level - 1) * 0.25));

    this.bullets.push({
      id: this.uid(),
      ownerId: this.player.id,
      ownerSlot: 0,
      x: originX,
      y: originY,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      r: towerDef.bulletType === "sniper" ? 4 : towerDef.bulletType === "missile" ? 5 : this.BULLET_R,
      dmg: dmg,
      isCrit: false,
      explosive: towerDef.explosive || 0,
      lifespan: this.BULLET_LIFESPAN,
      bulletType: towerDef.bulletType,
      magnet: true,
      chain: false,
      ricochet: 0,
      pierce: towerDef.bulletType === "sniper" ? 1 : 0,
      hitList: [],
      isTowerBullet: true,
    });
  },

  // ===== Effects =====
  addDamageNumber(x, y, val, isCrit) {
    this.damageNumbers.push({ x, y, val: Math.round(val * 10) / 10, isCrit, age: 0 });
  },

  createExplosion(x, y, size, color) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 50 + Math.random() * 100;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.2,
        maxLife: 0.5,
        alpha: 1,
        color: color,
        size: 2 + Math.random() * 3,
      });
    }
  },

  // ===== Phase Transitions =====
  beginUpgradePhase() {
    this.phase = "upgrades";
    this.upgradePhaseStart = Date.now();
    this.rerollCount = 0;
    this.upgradePicked = false;
    this.upgradeOptions = this.makeUpgradeOptions();
    this.send({
      t: "upgrade",
      options: this.upgradeOptions,
      deadline: this.upgradePhaseStart + this.UPGRADE_TIMEOUT * 1000,
      rerollCost: this.getRerollCost()
    });
    this.send({ t: "upgradePhase", deadline: this.upgradePhaseStart + this.UPGRADE_TIMEOUT * 1000 });
  },

  endGame() {
    this.stop();
    this.phase = "gameover";
    const p = this.player;
    this.send({
      t: "gameOver",
      wave: this.wave,
      solo: true,
      scores: [{
        id: p.id,
        name: p.name,
        score: p.score,
        kills: p.kills,
        slot: 0,
        isWinner: false,
      }],
      winnerId: null,
    });
  },

  // ===== State Broadcasting =====
  broadcastState() {
    const p = this.player;
    this.send({
      t: "state",
      phase: this.phase,
      wave: this.wave,
      world: { width: this.SEGMENT_W, height: this.WORLD_H, segmentWidth: this.SEGMENT_W },
      missiles: this.missiles.filter(m => !m.dead).map(m => ({
        id: m.id, x: m.x, y: m.y, r: m.r, hp: m.hp, maxHp: m.maxHp, type: m.type,
        targetSlot: m.targetSlot, attackType: m.attackType,
        rotation: m.rotation, inFTL: m.inFTL, isPhased: m.isPhased,
        splits: m.splits, explosive: m.explosive,
      })),
      bullets: this.bullets.filter(b => !b.dead).map(b => ({
        id: b.id, x: b.x, y: b.y, r: b.r, vx: b.vx, vy: b.vy,
        isCrit: b.isCrit, bulletType: b.bulletType, lifespan: b.lifespan,
        ownerSlot: b.ownerSlot, isTowerBullet: b.isTowerBullet,
      })),
      particles: this.particles,
      damageNumbers: this.damageNumbers,
      players: [{
        id: p.id,
        slot: 0,
        name: p.name,
        score: p.score,
        gold: p.gold,
        hp: p.hp,
        maxHp: p.maxHp,
        turretAngle: p.turretAngle,
        isManual: p.manualShooting,
        towers: p.towers,
        kills: p.kills,
        damageDealt: p.damageDealt,
        waveDamage: p.waveDamage,
        upgrades: {
          shieldActive: p.upgrades.shieldActive || 0,
          slowfield: !!p.upgrades.slowfield,
        },
      }],
    });
  },
};

// Export for use in client.js
if (typeof window !== 'undefined') {
  window.LocalServer = LocalServer;
}
