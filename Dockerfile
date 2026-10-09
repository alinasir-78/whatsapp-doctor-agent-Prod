FROM node:20-alpine

# Install build dependencies required for compiling native node modules
RUN apk add --no-cache python3 make g++ sqlite wget

WORKDIR /app

# Ensure persistent data directory exists
RUN mkdir -p /app/data

# Copy package manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Expose default service port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/doctor_agent.db

# Container health probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start server
CMD ["node", "index.js"]
