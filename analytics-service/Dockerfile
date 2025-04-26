# Dockerfile for Analytics Service
FROM node:16-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Expose port
EXPOSE 4000

# Start service
CMD ["npm", "start"]
