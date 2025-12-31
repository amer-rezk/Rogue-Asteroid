# 🚀 Rogue Asteroid PvP - Local Hosting Setup

A competitive asteroid defense game with WebRTC UDP-like transport for low-latency multiplayer.

## Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start
```

Then open `http://localhost:3000` in your browser.

## Network Setup for Internet Play

1. **Port Forward TCP 3000** on your router to your machine
2. Share your **public IP address** with players (find it at [whatismyip.com](https://whatismyip.com))
3. Players connect to: `http://YOUR_PUBLIC_IP:3000`

## Architecture

- **WebSocket (TCP)**: Signaling, lobby, chat, purchases, upgrades
- **WebRTC DataChannel (UDP-like)**: High-frequency game state broadcasts (45Hz physics, ~22Hz network)

### WebRTC Status

The server automatically detects WebRTC availability:
- ✓ **With wrtc**: UDP-like transport via WebRTC DataChannels (lowest latency)
- ✗ **Without wrtc**: Falls back to WebSocket-only (still playable)

To enable WebRTC on the server (optional, requires native compilation):
```bash
npm install wrtc
```

**Note**: Browser clients use native WebRTC - no special setup required.

## Game Features

- 🎮 **1-4 Player Competitive Mode**
- 🎯 **13 Roguelike Upgrades** (4 rarities: Common → Legendary)
- 🗼 **3 Tower Types** (Gatling, Sniper, Missile)
- ⚔️ **6 PvP Attack Units** (Swarm, Bruiser, Carrier, Splitter, Ghost, Berserker)
- 👑 **Boss Waves** with module rewards
- 💬 **Chat System**
- 👁️ **Spectator Mode**

## Controls

- **Mouse**: Aim turret
- **Left Click**: Fire (auto-fires by default)
- **1/2/3**: Quick select upgrades
- **R**: Reroll upgrades
- **Enter**: Focus chat
- **Escape**: Pause game

## File Structure

```
rogue-asteroid/
├── server.js      # Game server (Node.js)
├── package.json   # Dependencies
└── docs/
    └── index.html # Game client
```

## Troubleshooting

**"WebRTC unavailable"**: The game still works over WebSocket. For lowest latency, install `wrtc`:
```bash
npm install wrtc
```

**Players can't connect**: Ensure:
1. Port 3000 is forwarded on your router
2. Firewall allows incoming connections
3. You're sharing your PUBLIC IP, not 192.168.x.x

**High latency**: WebRTC provides the best performance. Check the connection indicator in-game (top-right):
- 🟢 WebRTC = UDP-like transport
- 🟡 WebSocket = TCP fallback