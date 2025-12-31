# Dockerfile for Rogue Asteroid PvP
FROM node:20-slim

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app files
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
