FROM node:22-alpine AS builder

# Work inside the backend folder context
WORKDIR /app

# Toolchain for native modules (e.g., bcrypt)
RUN apk add --no-cache python3 make g++

# Install dependencies with devDeps for building
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies for a slimmer runtime
RUN npm prune --omit=dev

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# App uses process.env.PORT; defaults to 3001
EXPOSE 3001

CMD ["node", "dist/src/main.js"]
