# ☄️ Rogue Asteroid PvP

A competitive multiplayer tower defense game where players defend against waves of asteroids while sending attacks at each other. Last player standing wins!

## Quick Start

```bash
npm install
node server.js
```

Then open `http://localhost:3000` in your browser.

## Gameplay

- **Defend** your base from asteroid waves
- **Earn gold** by destroying asteroids
- **Buy towers** for extra firepower
- **Send attacks** at opponents to overwhelm them
- **Choose upgrades** between waves (roguelike card system)

## Controls

| Action | Control |
|--------|---------|
| Aim | Mouse movement |
| Manual fire | Click |
| Auto-aim | Enabled by default |
| Buy towers/attacks | Click UI buttons |

## Towers

| Tower | Cost | Description |
|-------|------|-------------|
| Gatling | 50g | Fast fire rate, low damage |
| Sniper | 120g | Slow, high damage, piercing |
| Missile | 250g | Homing rockets, AOE damage |

## Attack Units

| Attack | Cost | Effect |
|--------|------|--------|
| 🐝 Swarm | 25g | 3 fast weak asteroids |
| 🪨 Bruiser | 35g | 1 very tanky asteroid |
| 👻 Ghost | 40g | 2 phasing asteroids (hard to hit) |
| 💎 Splitter | 50g | Splits into 15 on death |
| 👑 Carrier | 60g | Spawns minions as it descends |

## Boss Waves

Every 10 waves, a boss asteroid appears. Damaging it spawns smaller minions.

### Custom Boss Images

Place PNG images in `docs/images/`:
- `Boss.png` - Main boss
- `boss-ad-1.png` to `boss-ad-5.png` - Boss minions

## Multiplayer

- Up to 4 players
- Host can force-start the game
- Spectator mode for late joiners
- Chat available in lobby and in-game

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `LEADERBOARD_PASSWORD` | Password to clear leaderboard |

---

*Survive the asteroid storm. Destroy your enemies.*