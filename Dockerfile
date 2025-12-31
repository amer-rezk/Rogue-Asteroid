# Dockerfile for Rogue Asteroid PvP with WebRTC/UDP (geckos.io)
FROM node:20-slim

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app files
COPY . .

# Expose HTTP port
EXPOSE 3000

# Expose UDP ports for WebRTC (geckos.io)
EXPOSE 10000-10100/udp

# Start the server
CMD ["node", "server.js"]
