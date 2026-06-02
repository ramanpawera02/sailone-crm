# Works on Fly.io, Railway, or any container host.
FROM node:22-slim
WORKDIR /app

# Install dependencies first (better build caching).
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app.
COPY . .

# Database location (override with a mounted volume in production).
ENV NODE_ENV=production
ENV DB_PATH=/data/sailone_crm.db
RUN mkdir -p /data

EXPOSE 3000
CMD ["npm", "start"]
