FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi


FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build


FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const port=Number(process.env.PORT||3000);const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:4000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('timeout',()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));"

CMD ["npm", "start"]
