FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
ARG API_URL=http://api:3001
ENV API_URL=$API_URL
RUN npm run build -w apps/web

FROM node:22-alpine
WORKDIR /app/apps/web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/web ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
