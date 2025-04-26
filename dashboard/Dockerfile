# Dockerfile for Dashboard
FROM node:16-alpine
WORKDIR /app

# install dependencies
COPY package*.json ./
RUN npm ci --only=production

# copy source
COPY . .

# build
RUN npm run build

# serve
RUN npm install -g serve
EXPOSE 3000
CMD ["serve", "-s", "build", "-l", "3000"]
