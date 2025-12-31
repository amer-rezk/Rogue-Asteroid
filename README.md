# ☄️ Rogue Asteroid PvP - Self-Hosted Internet Edition

A competitive multiplayer tower defense game where players defend against waves of asteroids while sending attacks at each other. **Configured for hosting on your PC so remote friends can join over the internet!**

## 🎮 Quick Start (For the Host)

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

The server will display your **public IP** and setup instructions:
```
=================================================================
🚀 ROGUE ASTEROID PvP - INTERNET SERVER RUNNING
=================================================================

📡 Server listening on port 3000

🏠 Local access (you): http://localhost:3000

🌍 PUBLIC IP (share with remote friends):
   → http://203.0.113.45:3000

=================================================================
📋 SETUP FOR INTERNET PLAY (required for remote friends):
=================================================================

1. PORT FORWARDING - In your router settings, forward:
   • Port 3000 TCP (for the web page)
   • Ports 1025-65535 UDP (for game data)

2. FIREWALL - Allow Node.js through Windows/Mac firewall

3. SHARE YOUR PUBLIC IP - Give friends the URL shown above

4. FRIENDS CONNECT - They open the URL in their browser
=================================================================
```

## ⚙️ Required Setup for Internet Play

### 1. Port Forwarding (Required!)

You need to forward ports on your router so friends can reach your PC:

1. Find your router's admin page (usually `192.168.1.1` or `192.168.0.1`)
2. Look for "Port Forwarding" or "NAT" settings
3. Add these rules:
   - **Port 3000 TCP** → Your PC's local IP (e.g., 192.168.1.100)
   - **UDP ports** → Geckos.io uses dynamic UDP ports. Either:
     - Forward a range like `9000-9100 UDP`, OR
     - Enable "UPnP" on your router (easier but less secure)

### 2. Windows Firewall

When you first run `node server.js`, Windows will ask to allow it. **Click "Allow"!**
If you missed it:
1. Open **Windows Defender Firewall**
2. Click **Allow an app through firewall**
3. Add `node.exe` and enable for **Private** and **Public** networks

### 3. Find Your Public IP

The server tries to detect it automatically. If not, visit: https://whatismyip.com

## 👥 For Friends Joining

1. Get the **public IP** from the host (e.g., `http://203.0.113.45:3000`)
2. Open that URL in your browser
3. Wait for "ONLINE (UDP)" status
4. Enter your callsign and click **READY UP**
5. Host clicks **BATTLE** when everyone is ready!

## 🔧 Troubleshooting

### "Connection Refused" or Timeout
- **Port forwarding not set up** - This is the #1 issue! See setup above
- **Firewall blocking** - Make sure Node.js is allowed
- **Wrong IP** - Make sure you're using the PUBLIC IP, not local (192.168.x.x)

### Connected but Game Laggy/Disconnecting
- Geckos.io uses WebRTC which needs UDP. Make sure UDP ports are forwarded
- Try enabling UPnP on your router as an alternative

### Can't Set Up Port Forwarding?
Some ISPs or network setups make port forwarding impossible. Try these alternatives:

**Option A: ngrok (Easiest)**
```bash
# Install ngrok from https://ngrok.com
ngrok http 3000
```
This gives you a public URL like `https://abc123.ngrok.io` - share that instead!

**Option B: Tailscale/ZeroTier**
These create a virtual private network between you and friends. Everyone installs the app, joins your network, then connects via the virtual IP.

**Option C: Rent a cheap server**
Services like DigitalOcean, Vultr, or Oracle Cloud (free tier!) let you run the game on a real server.

## 🎮 Gameplay

- **Defend** your base from asteroid waves
- **Earn gold** by destroying asteroids  
- **Buy towers** for extra firepower
- **Send attacks** at opponents to overwhelm them
- **Choose upgrades** between waves (roguelike card system)

## 🎯 Controls

| Action | Control |
|--------|---------|
| Aim | Mouse movement |
| Manual fire | Click |
| Auto-aim | Enabled by default |
| Buy towers/attacks | Click UI buttons |

## 🗼 Towers

| Tower | Cost | Description |
|-------|------|-------------|
| Gatling | 50g | Fast fire rate, low damage |
| Sniper | 120g | Slow, high damage, piercing |
| Missile | 250g | Homing rockets, AOE damage |

## ⚔️ Attack Units

| Attack | Cost | Effect |
|--------|------|--------|
| 🐝 Swarm | 25g | 3 fast weak asteroids |
| 🪨 Bruiser | 35g | 1 very tanky asteroid |
| 👻 Ghost | 40g | 2 phasing asteroids (hard to hit) |
| 💎 Splitter | 50g | Splits into 15 on death |
| 👑 Carrier | 60g | Spawns minions as it descends |

## 💡 Tips for Hosting

- **Keep the server running** - Don't close the terminal/command prompt
- **Stable internet helps** - Upload speed matters when hosting
- **Up to 4 players** can join a game
- **Late joiners** can spectate ongoing games

---

*Survive the asteroid storm. Destroy your enemies!* 🎉