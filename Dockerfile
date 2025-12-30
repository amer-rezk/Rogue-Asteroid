# Use a lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy the rest of your game code
COPY . .

# Expose the ports we need:
# 3000 = HTTP/TCP (Signaling & Static Files)
# 9208 = UDP (Geckos.io Game Data)
EXPOSE 3000/tcp
EXPOSE 9208/udp

# Start the server
CMD [ "node", "server.js" ]