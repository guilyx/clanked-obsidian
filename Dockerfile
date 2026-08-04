FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Vault is mounted at /vault (read-only unless you need writes)
ENV VAULT_PATH=/vault
ENV DATA_DIR=/data
ENV BIND_HOST=0.0.0.0
EXPOSE 8484
USER node
CMD ["node", "dist/index.js"]
