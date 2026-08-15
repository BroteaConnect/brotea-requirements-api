# syntax=docker/dockerfile:1
# Two stages so dev deps never reach the runtime image. Replaces nixpacks
# (~150 MB final image instead of 1 GB). All config is runtime env.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The email templates point at these by absolute URL. The tests passed and the
# deploy was green while the folder was not in the image at all — CI runs
# against the working tree, the container runs against whatever was COPYed.
COPY assets ./assets
RUN test -f assets/email/brotea.png || (echo "the email assets did not reach the image" && exit 1)
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
