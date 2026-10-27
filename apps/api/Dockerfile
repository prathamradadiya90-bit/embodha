# Build: compile TypeScript, then drop dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Run: the compiled app, its runtime dependencies and the migrations. Nothing else.
FROM node:22-alpine
# ffmpeg normalises the loudness of audio chapters.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# The App Review screenshot sent with every store product the server makes.
COPY --from=build /app/assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# Migrations run on boot. Fine with one API container; move them to a release step before running several.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
