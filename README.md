# 🎬 SubMaker

**AI-Powered Subtitle Translation for Stremio**

Watch any content in your language!

SubMaker fetches subtitles from multiple sources and allows you to translate them instantly using Google's Gemini AI (or alternative providers like DeepL, OpenAI, Anthropic, XAI, DeepSeek, Mistral, OpenRouter, or Cloudflare Workers), all without leaving your player.

No-Translation mode: simply fetch selected languages from OpenSubtitles, SubSource and SubDL.

Auto-sync subtitles in development!

## 🚀 [Roadmap 🗺️](docs/ROADMAP.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-purple)](https://www.stremio.com)

---

## 🎉 Try It Now - No Setup Required!

**Want to jump straight in?**

### **[https://submaker.elfhosted.com](https://submaker.elfhosted.com)**

Just click the link, configure your languages, and install the addon. Done!

**A huge thanks to [ElfHosted](https://elfhosted.com)** for making SubMaker accessible to everyone in the Stremio community! ❤️

Check their [FREE Stremio Addons Guide](https://stremio-addons-guide.elfhosted.com/) for more great addons and features!

> **For self-hosting, keep reading the installation guide below.**

---

## ✨ Why SubMaker?

- 🌍 **197 Languages** - Full ISO-639-2 support including regional variants (PT-BR, etc.)
- 📥 **3 Subtitle Sources** - OpenSubtitles, SubDL, SubSource, with automatic fallback
- 🎯 **One-Click Translation** - Translate on-the-fly without ever leaving Stremio
- 🤖 **Context-Aware AI** - Google Gemini by default, plus optional providers (DeepL, OpenAI, Anthropic, XAI, DeepSeek, Mistral, OpenRouter, Cloudflare Workers)
- ⚡ **Translation Caching** - Permanent subtitles database with dual-layer cache (memory + redis/disk) and deduplication
- 🔒 **Production-Ready** - Rate limiting, CORS protection, session tokens, HTTPS enforcement
- 🎨 **Beautiful UI** - Modern configuration interface with live model fetching

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org))
- **Gemini API Key** ([Get one free](https://makersuite.google.com/app/apikey))
- **OpenSubtitles Account** ([Sign up](https://www.opensubtitles.com/en/newuser))
- **SubSource API Key** ([Get one free](https://subsource.net/api-docs))
- **SubDL API Key** ([Get one free](https://subdl.com/panel/api))
- *(Optional)* Keys for any alternative translation provider you want to enable (DeepL, OpenAI-compatible keys, Anthropic, XAI, DeepSeek, Mistral, OpenRouter, Cloudflare Workers)

### Installation

```bash
# Clone and install
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker
npm install

# Create .env
cp .env.example .env

# Configure .env
nano .env

# Start the server
npm start
```

## 🐳 Docker Deployment

📦 **[See complete Docker deployment guide →](docs/DOCKER.md)**

Quick start (Docker Hub, no clone):
```bash
mkdir stremio-submaker && cd stremio-submaker
cat > .env <<'EOF'
OPENSUBTITLES_API_KEY=your_opensubtitles_key
STORAGE_TYPE=redis
EOF
cat > docker-compose.yaml <<'EOF'
version: "3.9"
services:
  submaker:
    image: xtremexq/submaker:latest
    container_name: submaker
    ports:
      - "${PORT:-7001}:7001"
    env_file:
      - .env
    environment:
      - STORAGE_TYPE=redis
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD:-}
      - REDIS_DB=0
      - REDIS_KEY_PREFIX=stremio
      - ENCRYPTION_KEY_FILE=/app/keys/.encryption-key
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - stremio-network
    volumes:
      - app-data:/app/data
      - app-cache:/app/.cache
      - app-logs:/app/logs
      - encryption-key:/app/keys
  redis:
    image: redis:7-alpine
    container_name: stremio-redis
    command: >
      redis-server
      --maxmemory 4gb
      --maxmemory-policy allkeys-lru
      --save 900 1
      --save 300 10
      --save 60 10000
      --appendonly yes
      --appendfsync everysec
      --no-appendfsync-on-rewrite no
      --timeout 300
      --tcp-keepalive 60
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - stremio-network
networks:
  stremio-network:
    driver: bridge
volumes:
  redis-data:
  app-data:
  app-cache:
  app-logs:
  encryption-key:
EOF
docker-compose up -d
docker-compose logs -f submaker
```

Alternate (clone + build locally):
```bash
git clone https://github.com/xtremexq/StremioSubMaker.git && cd StremioSubMaker
cp .env.example .env && nano .env
docker-compose up -d          # defaults to build: .
# or switch to image: xtremexq/submaker:latest inside docker-compose.yaml
```

### Open configuration page in your browser
Visit: http://localhost:7001

### Configure & Install

1. **Add Subtitle Sources API keys**
2. **Add Gemini API Key** (required)
3. **Select source languages**
4. **Select target languages** (what to translate to)
5. **Click "Install in Stremio"** or copy and paste the URL to Stremio

That's it!
Fetched languages and translation buttons (Make [Language]) will now appear in your Stremio subtitle menu.

---

## 🎯 How It Works

```
┌─────────────────────────────────────────────┐
│  1. Watch content in Stremio                │
│  2. Subtitles appear with "Make [Language]" │
│  3. Click → Select source subtitle          │
│  4. AI translates in ~1 to 3 minutes        │
│  5. Reselect the translated subtitles       │
│  6. Next time? Instant! (cached on DB)      │
└─────────────────────────────────────────────┘
```

### Architecture

```
Stremio Player
    ↓
SubMaker Addon (Express + Stremio SDK)
    ├── Subtitle Fetcher → [OpenSubtitles, SubDL, SubSource]
    ├── Translation Engine → [Google Gemini AI] (with optional provider swap/fallbacks)
    └── Cache Manager → [Memory LRU + Redis/Filesystem]

```

## ⚙️ Configuration Guide

### Source Languages
Languages to **translate subtitles from** (Single language recommended)
- Example: English, Spanish, Portuguese (BR)

### Target Languages
Languages to **translate subtitles to**
- Example: French, German, Japanese

**Provider Configuration**
- OpenSubtitles: Optional username/password
- SubDL: Requires API key
- SubSource: Requires API key

## 🌐 Localization

- UI strings live in `locales/<code>.json` with the same shape as `locales/en.json` (`lang` + `messages`).
- To add a new language, copy `locales/en.json`, translate the values, and keep the keys/placeholder tokens (`{provider}`, `{count}`, etc.) intact.
- The configuration page lets you pick a UI language; that selection flows through to addon pages, subtitles, and API responses via `/api/locale`.

---

## 🐛 Troubleshooting

### Translation problem?

1. **Force cache overwrite** - Within stremio, click 3 times (within 6 secs) on the problematic translation subtitle
2. **Bypass Translation Cache** - Change your config to bypass the addons' subtitles database

### Translation Fails?

1. **Validate API key** - Test at [Google AI Studio](https://makersuite.google.com)
2. **Check Gemini quota** - Review your API usage
3. **Test other subtitles** - Try translating a different subtitle

### Configuration Not Saving?

1. **Clear browser cache** - Force reload with Ctrl+F5
2. **Check JavaScript console** - Look for errors (F12)
3. **Disable browser extensions** - Some block localStorage
4. **Try incognito mode** - Eliminate cache/extension issues

---

## 🙏 Acknowledgments

**Built With**
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk) - Addon framework
- [Google Gemini](https://ai.google.dev/) - AI translation
- [OpenSubtitles](https://www.opensubtitles.com/) - Primary subtitle database
- [SubDL](https://subdl.com/) - Alternative subtitle source
- [SubSource](https://subsource.net/) - Alternative subtitle source

**Special Thanks**
- Stremio team for excellent addon SDK
- Google for free Gemini API access
- All Subtitles communities

---

## 📧 Support

**Issues & Questions**
[Open an issue](https://github.com/xtremexq/StremioSubMaker/issues) on GitHub

**Documentation**
Check the `/public/configure.html` UI for interactive help

**Community**
Join Stremio Discord for general Stremio addon help
Join StremioAddons on Reddit for community news and support

---

**Made with ❤️ for the Stremio community**

[⭐ Star this repo](https://github.com/xtremexq/StremioSubMaker) · [🐛 Report Bug](https://github.com/xtremexq/StremioSubMaker/issues) · [✨ Request Feature](https://github.com/xtremexq/StremioSubMaker/issues)
