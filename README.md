# 🎬 SubMaker

**AI-Powered Subtitle Translation for Stremio**

Watch any content in your language!

SubMaker fetches subtitles from multiple sources, and translates them instantly using AI — without ever leaving your player.

No-Translation mode: simply fetch selected languages from OpenSubtitles, SubSource, SubDL, Wyzie, SCS and Subs.ro.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-purple)](https://www.stremio.com)

---

## 🎉 Try It Now - No Setup Required!

**Want to jump straight in?**

### **[https://submaker.elfhosted.com](https://submaker.elfhosted.com)**

Configure, install, done. A huge thanks to [ElfHosted](https://elfhosted.com) ❤️

Check their [FREE Stremio Addons Guide](https://stremio-addons-guide.elfhosted.com/) for more great addons and features!

> For self-hosting, see [Installation](#-installation) below.

---

## ✨ Why SubMaker?

- 🌍 **197 Languages**
- 📥 **Multiple Subtitle Sources**
- 🎯 **One-Click Translation**
- ⚡ **Shared Translation Database**
- 🧰 **Subtitles Toolbox**

## ✨ Features

### 🌍 Subtitle Sources
| Provider | Auth Required | Notes |
|----------|---------------|-------|
| OpenSubtitles | Optional (recommended) | V3 or authenticated mode |
| SubDL | API key | [subdl.com/panel/api](https://subdl.com/panel/api) |
| SubSource | API key | [subsource.net/api-docs](https://subsource.net/api-docs) |
| Wyzie Subs | None | Aggregator (beta) |
| Stremio Community Subs | None | Requires 30s timeout (beta) |
| Subs.ro | API key | Romanian subtitles (beta) |

### 🤖 AI Translation Providers
| Provider | Notes |
|----------|-------|
| **Google Gemini** | Default, free tier available, key rotation supported |
| OpenAI | GPT models |
| Anthropic | Claude models |
| DeepL | Traditional translation API |
| DeepSeek | |
| XAI (Grok) | |
| Mistral | |
| OpenRouter | Access multiple models |
| Cloudflare Workers AI | |
| Google Translate | Unofficial, no key needed |
| Custom | Ollama, LM Studio, LocalAI, any OpenAI-compatible API |

---

## 🚀 Quick Start

### Prerequisites

### Prerequisites
- **Node.js** 18+ — [nodejs.org](https://nodejs.org)
- **Gemini API Key** — [Get free](https://aistudio.google.com/app/api-keys)
- At least one subtitle provider key
- Keys for any alternative subtitles provider or translation provider you want to enable. (Optional)

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
1. Install SubMaker in Stremio
2. Play content → Subtitles list shows "Make [Language]" buttons
3. Click → Select source subtitle to translate
4. Wait ~1-3 minutes → AI translates in batches
5. Reselect the subtitle → Now translated!
6. Next time? Instant — cached in database
```

### Pro Tips
- **Single source language recommended** — Keeps subtitle order consistent
- **Test sync first** — Try the original subtitle before translating
- **Triple-click** — Forces re-translation if result looks wrong
- **Use Flash-Lite** — Fastest model, best for rate limits

---

## ⚙️ Configuration Guide

### Sections Overview

| Section | Purpose |
|---------|---------|
| **API Keys** | Subtitle providers and AI translation keys |
| **Languages** | Source (translate from) and target (translate to) languages |
| **Settings** | Translation behavior, workflows, and caching |

### Key Settings

| Setting | Recommendation |
|---------|----------------|
| Translation Workflow | "XML Tags" for best sync |
| Database Mode | "Use SubMaker Database" for shared caching |
| Provider Timeout | 12s default, increase to 30s for SCS/Wyzie |
| Mobile Mode | Enable for Android/iOS |

### Advanced Mode
Enable "Advanced Mode" in Other Settings to unlock:
- Batch Context (surrounding context for coherence)
- Mismatch Retries (retry on wrong entry count)
- Gemini Parameters (temperature, top-p, thinking budget)

---

## 🐛 Troubleshooting

> **📖 Full Guide:** [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

### ⏱️ Subtitles Out of Sync?

Change **Translation Workflow** in Settings → Translation Settings:
- **XML Tags** (default, recommended) — Best for sync issues
- **Original Timestamps** — Legacy mode, reattaches original timecodes
- **Send Timestamps to AI** — Trusts AI to preserve timecodes

### 🔄 Bad / Broken Translation?

1. **Force re-translation** — Triple-click the subtitle in Stremio (within 6 seconds)
2. **Try a different model** — Switch between Flash-Lite, Flash, or other models
3. **Bypass cache** — Enable "Bypass Cache" in Translation Settings

### ❌ Translation Fails / Rate Limits?

1. **Validate API key** — Test at [Google AI Studio](https://aistudio.google.com)
2. **Switch model** — Gemma 27b has higher rate limits than Flash
3. **Enable key rotation** — Add multiple Gemini keys in API Keys section
4. **Use secondary provider** — Enable fallback provider in Translation Settings

### 📱 Android / Mobile Issues?

1. **Enable Mobile Mode** — Check "Mobile Mode" in Other Settings
2. **Wait 1-3 minutes** — Mobile mode delivers complete subtitle when ready
3. **Use Flash-Lite** — Fastest model for mobile compatibility

### 💾 Configuration Not Saving?

1. **Verify Token** — Is the token installed in Stremio (unique URL) the same one being saved in the config page?
2. **Hard refresh** — Press `Ctrl+F5` (Windows/Linux) or `Cmd+Shift+R` (Mac)
3. **Check console** — Press `F12` → Console for errors
4. **Try incognito** — Rules out extension conflicts

### ⚡ Reset Everything
Click the "Reset" button at the bottom of the config page to clear all settings and start fresh.

---

## 🙏 Acknowledgments

**Built With**
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk) - Addon framework
- [OpenSubtitles](https://www.opensubtitles.com/) - Primary subtitle database
- [SubDL](https://subdl.com/) - Alternative subtitle source
- [SubSource](https://subsource.net/) - Alternative subtitle source
- [Google Gemini](https://ai.google.dev/) - AI translation

**Special Thanks**
- Stremio team for excellent addon SDK
- Google for free Gemini API access
- All Subtitles communities
- [ElfHosted](https://elfhosted.com/) - our free community hosting provider

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
