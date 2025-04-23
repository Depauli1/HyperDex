FROM node:16-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies for native module builds
RUN apk add --no-cache python3 make g++ git

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Build if applicable
RUN npm run build --if-present

# Production image
FROM node:16-alpine

# Install bash for healthcheck scripts
RUN apk add --no-cache bash curl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S -u 1001 -G nodejs nodejs

# Create app directory and set ownership
WORKDIR /app
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/config ./config

# Create data directory for SQLite (if used in dev)
RUN mkdir -p ./data

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Set a unique instance ID based on container
ENV INSTANCE_ID=${HOSTNAME}

# Command
CMD ["node", "src/index.js"]
