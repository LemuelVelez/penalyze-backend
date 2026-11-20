# Build-time ARG/ENV must never contain database credentials, JWT keys, or
# repository integration keys. Supply secrets via Coolify runtime Environment.
FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./

# Retry with a clean npm cache if a registry/CDN returns a corrupted tarball.
RUN npm ci --no-audit --no-fund --fetch-retries=5 --prefer-online \
    || (npm cache clean --force \
        && npm ci --no-audit --no-fund --fetch-retries=5 --prefer-online)


FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build


# Reuse the verified dependency tree; don't download the same packages again.
FROM node:22-alpine AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
RUN npm prune --omit=dev --no-audit --no-fund \
    && npm cache clean --force


FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules

COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/src/database/migration ./src/database/migration

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const port=Number(process.env.PORT||3000);const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:4000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('timeout',()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));"

CMD ["npm", "start"]
