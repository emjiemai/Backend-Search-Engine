# Playwright's official image already contains Chromium + every OS-level
# dependency it needs (libnss3, libatk, etc.) — no apt-get/sudo required at
# build time, which is what was failing on Render's native Node runtime.
# Keep this version in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Render sets $PORT itself; server.js already reads process.env.SCRAPER_PORT.
# We map PORT -> SCRAPER_PORT so the app listens on whatever port Render assigns.
ENV SCRAPER_PORT=8081
EXPOSE 8081

CMD ["node", "server.js"]
