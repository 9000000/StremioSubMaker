# 🎬 SubMaker

**AI-Powered Subtitle Translation for Stremio**

Watch any content in your language!

SubMaker fetches subtitles from multiple sources and allows you to translate them instantly using Google's Gemini AI—all without leaving your player.

No-Translation mode: simply fetch selected languages from OpenSubtitles, SubSource and SubDL.

Auto-sync subtitles in development!

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-purple)](https://www.stremio.com)

---

## ✨ Why SubMaker?

- 🌍 **190+ Languages** - Full ISO-639-2 support including regional variants (PT-BR, etc.)
- 📥 **3 Subtitle Sources** - OpenSubtitles, SubDL, SubSource, with automatic fallback
- 🎯 **One-Click Translation** - Translate on-the-fly without ever leaving Stremio
- 🤖 **Context-Aware AI** - Google Gemini preserves timing, formatting, and natural dialogue flow
- ⚡ **Translation Caching** - Permanent subtitles database with dual-layer cache (memory + disk) and deduplication
- 🔒 **Production-Ready** - Rate limiting, CORS protection, session tokens, HTTPS enforcement
- 🎨 **Beautiful UI** - Modern configuration interface with live model fetching

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org))
- **Gemini API Key** ([Get one free](https://makersuite.google.com/app/apikey))
- **OpenSubtitles** account for higher limits ([Sign up](https://www.opensubtitles.com/en/newuser)) and add your key to a `.env` file via `OPENSUBTITLES_API_KEY=...` (this may be the only `.env` entry you need).
- **SubSource API Key** ([Get one free](https://subsource.net/api-docs))
- **SubDL API Key** ([Get one free](https://subdl.com/panel/api)) 

### Installation

```bash
# Clone and install
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker
npm install

# Create .env file with your OpenSubtitles API key
# Option 1: Create a new file called `.env` in the project root and add:
#   OPENSUBTITLES_API_KEY=your_api_key_here
# Option 2: Use command line (PowerShell, bash, or terminal)
#   echo "OPENSUBTITLES_API_KEY=your_api_key_here" > .env

# Start the server
npm start

# Open configuration page in your browser
# On macOS/Linux: open http://localhost:7001
# On Windows: start http://localhost:7001
# Or manually visit: http://localhost:7001
```

### Configure & Install

1. **Add Subtitle Sources API keys** (required)
2. **Add Gemini API Key** (required)
3. **Select source languages** (where to fetch subtitles from)
4. **Select target languages** (what to translate to)
5. **Click "Install in Stremio"** or copy the URL

That's it!
Fetched languages and translation buttons (Make [Language]) will now appear in your Stremio subtitle menu.

---

## 🐳 Docker Deployment (Production)

For production deployments with high availability and horizontal scaling, use Docker with Redis storage.

### Why Redis?

- **Stateless Pods**: No dependency on local filesystem
- **High Availability**: Survive node reboots and scaling events
- **Horizontal Scaling**: Run multiple instances sharing the same cache
- **Performance**: Fast in-memory cache with persistence

### Quick Start with Docker Compose

#### Option 1: With Redis (Recommended for Production/HA)

```bash
# Clone the repository
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker

# Create .env file with your configuration
cp .env.example .env
# Edit .env and add your API keys

# Start with Redis
docker-compose up -d

# View logs
docker-compose logs -f stremio-submaker
```

#### Option 2: Local Development (Filesystem Storage)

```bash
# Use the local development compose file
docker-compose -f docker-compose.local.yaml up -d
```

### Configuration

The application uses the `STORAGE_TYPE` environment variable to determine storage backend:

- **`STORAGE_TYPE=filesystem`** (default): Uses local disk storage, perfect for npm start/local development
- **`STORAGE_TYPE=redis`**: Uses Redis for distributed caching, required for HA deployments

#### Redis Configuration Options

Add these to your `.env` file when using Redis:

```env
# Storage Configuration
STORAGE_TYPE=redis

# Redis Connection
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_secure_password
REDIS_DB=0
REDIS_KEY_PREFIX=stremio:

# API Keys (optional, for server-level config)
OPENSUBTITLES_API_KEY=your_opensubtitles_key

# Note: Gemini API key is configured per-user in Stremio addon settings
```

### Cache Size Limits

The storage adapter enforces these limits with LRU eviction:

- **Translation Cache**: 50GB (permanent translations)
- **User Config Cache**: 50GB (session data)
- **Bypass Cache**: 10GB (temporary user-scoped cache, 12h TTL)
- **Partial Cache**: 10GB (in-flight partial translations, 1h TTL)
- **Sync Cache**: 50GB (synced subtitles)

**Redis Memory Settings:**

The default Docker setup allocates **8GB** to Redis. For larger deployments, adjust in `docker-compose.yaml`:

```yaml
# Small deployments (single user, testing)
--maxmemory 2gb

# Medium deployments (multiple users)
--maxmemory 8gb  # default

# Large deployments (many concurrent users)
--maxmemory 16gb
```

**Note:** Application-level cache limits are enforced before Redis LRU kicks in. If Redis hits `maxmemory`, it will evict the least recently used keys automatically.

### Manual Docker Build

```bash
# Build the image
docker build -t stremio-submaker .

# Run with Redis
docker run -d \
  --name stremio-submaker \
  -p 7000:7000 \
  -e STORAGE_TYPE=redis \
  -e REDIS_HOST=your-redis-host \
  -e REDIS_PORT=6379 \
  stremio-submaker

# Run with filesystem storage (requires volume mount)
docker run -d \
  --name stremio-submaker \
  -p 7000:7000 \
  -v $(pwd)/.cache:/app/.cache \
  -v $(pwd)/data:/app/data \
  -e STORAGE_TYPE=filesystem \
  stremio-submaker
```

### Health Checks

The Docker image includes built-in health checks:
- Endpoint: `http://localhost:7000/health`
- Interval: 30 seconds
- Timeout: 10 seconds

### Scaling

When using Redis, you can horizontally scale the application:

```bash
# Scale to 3 instances
docker-compose up -d --scale stremio-submaker=3

# Use a load balancer (nginx, traefik, etc.) to distribute traffic
```

---

## 🎯 How It Works

```
┌─────────────────────────────────────────────┐
│  1. Watch content in Stremio                		│
│  2. Subtitles appear with "Make [Language]" 		│
│  3. Click → Select source subtitle          		│
│  4. AI translates in ~1 to 3 minutes        		│
│  5. Reselect the translated subtitles       		│
│  6. Next time? Instant! (cached on DB)      		│
└─────────────────────────────────────────────┘
```

### Architecture

```
Stremio Player
    ↓
SubMaker Addon (Express + Stremio SDK)
    ├── Subtitle Fetcher → [OpenSubtitles, SubDL, SubSource, Podnapisi]
    ├── Translation Engine → [Google Gemini AI]
    └── Cache Manager → [Memory LRU + Persistent Disk]
```

### Key Features

**Multi-Source Fetching**
- Queries 4 providers simultaneously
- Automatic fallback if one fails
- Ranks by downloads, ratings, quality

**AI Translation**
- Context-aware (processes entire subtitle at once)
- Handles files up to unlimited size with chunking
- Customizable translation prompts
- Fetches all Gemini models

**Intelligent Caching**
- **Memory**: LRU cache for hot translations (~200ms)
- **Disk**: Persistent cache survives restarts

---

## ⚙️ Configuration Guide

### Source Languages
Languages to **fetch** subtitles in (Single language recommended)
- Example: English, Spanish, Portuguese (BR)

### Target Languages
Languages to **translate to** (unlimited)
- Example: French, German, Japanese

### Gemini Model Selection
- Flash or Flash-Lite Latest recommended. 
- Do not use Pro or other models. (takes too long/fails)

**Provider Configuration**
- OpenSubtitles: Optional username/password for higher limits
- SubDL: Requires API key
- SubSource: Requires API key
- Podnapisi: (DISABLED)

---

## 🐛 Troubleshooting

### Translation problem?

1. **Force cache overwrite** - Within stremio, click 5 times (within 10 secs) on the problematic translation subtitle
2. **Bypass Translation Cache** - Change your config to bypass the addons' subtitles database

### Translation Fails?

1. **Validate API key** - Test at [Google AI Studio](https://makersuite.google.com)
2. **Check model selection** - Ensure model used is Flash or Flash-Lite Latest
3. **Check Gemini quota** - Review your API usage

### Configuration Not Saving?

1. **Clear browser cache** - Force reload with Ctrl+F5
2. **Check JavaScript console** - Look for errors (F12)
3. **Disable browser extensions** - Some block localStorage
4. **Try incognito mode** - Eliminate cache/extension issues

### No Subtitles Loading?

Stremio sometimes randomly stops sending subtitle requests to addons after installation. If no other subtitle addons load either:
1. Try streaming different titles or files
2. Restart Stremio
3. It should resume working normally

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

---

**Made with ❤️ for the Stremio community**

[⭐ Star this repo](https://github.com/xtremexq/StremioSubMaker) · [🐛 Report Bug](https://github.com/xtremexq/StremioSubMaker/issues) · [✨ Request Feature](https://github.com/xtremexq/StremioSubMaker/issues)
