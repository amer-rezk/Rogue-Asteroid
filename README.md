# Rogue Asteroid PvP - WebRTC/UDP Version

This version uses **geckos.io** for WebRTC DataChannels, giving you UDP-like performance for game state updates while keeping reliable delivery for important messages.

## Architecture

- **Reliable Channel (TCP-like)**: Lobby, chat, purchases, tower buying, upgrades, game events
- **Unreliable Channel (UDP-like)**: Game state broadcasts at 22Hz (missiles, bullets, positions)

## Key Benefits

1. **Lower Latency**: UDP doesn't wait for lost packet retransmission
2. **No Head-of-Line Blocking**: One lost packet doesn't delay all following packets
3. **Better for Real-time Games**: Perfect for your 22Hz state updates

## Files Changed

- `server.js` - Uses `@geckos.io/server` instead of `ws`
- `client.js` - Uses geckos.io client for WebRTC connection
- `index.html` - Loads geckos.io client from CDN
- `package.json` - Dependencies updated
- `fly.toml` - UDP ports configured for WebRTC
- `Dockerfile` - Exposes UDP port range

## Deployment to Fly.io

1. Copy all files to your project root (same level as your existing files)

2. Deploy:
   ```bash
   fly deploy
   ```

3. The game will be available at `https://rogue-asteroid.fly.dev`

## Port Configuration

- **TCP 3000**: HTTP server + WebRTC signaling
- **UDP 10000-10010**: WebRTC data channels

## Local Development

```bash
npm install
npm start
```

Then open http://localhost:3000

## Notes

- The UDP ports in `fly.toml` support up to ~10 concurrent WebRTC connections
- If you need more concurrent players, add more UDP port entries
- geckos.io handles the WebRTC complexity automatically