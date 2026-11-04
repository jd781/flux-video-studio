# FLUX Video Studio — production image for Fly.io
#
# Node (Debian-based, not Alpine) so the native better-sqlite3 module builds
# cleanly. Single stage keeps the already-built node_modules (incl. the compiled
# native addon) for the runtime, and bakes the built frontend into /app/dist.

FROM node:22-bookworm-slim

# Build tools for native modules (better-sqlite3 -> node-gyp).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install ALL deps (build needs vite/tsc/tsx; tsx also runs the server at runtime).
# Native modules compile here against this image's toolchain.
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# Build the frontend into /app/dist (served by the Express server in prod).
RUN npm run build

# Fly routes to this internal port (see fly.toml). The server reads FAL_PROXY_PORT.
ENV FAL_PROXY_PORT=8080
EXPOSE 8080

# SQLite lives on the mounted volume (see fly.toml [mounts]).
ENV DATA_DIR=/data

# Run the TypeScript server directly with tsx.
CMD ["npm", "run", "start"]
