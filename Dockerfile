FROM node:20-bookworm

ENV PUPPETEER_SKIP_DOWNLOAD=true

# Use Debian's chromium on all architectures (amd64 + arm64). We previously installed
# google-chrome-stable on amd64 only; unified on distro Chromium for consistency and simpler builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    chromium \
  && ln -sf /usr/bin/chromium /usr/bin/byos-browser \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY .env.example ./.env.example

RUN npm run build

EXPOSE 8787 2525

CMD ["node", "dist/index.js"]
