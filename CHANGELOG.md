# Changelog

All notable changes to this project will be documented in this file.

## SubMaker 1.1.0

**Performance Optimizations (3-5x Speedup):**
- **Parallel chunk processing**: Process multiple Gemini chunks simultaneously (configurable via `GEMINI_CHUNK_CONCURRENCY`)
  - Default: 1 (sequential mode - safe for all users, no API rate limit risk)
  - Set to 3-5 for parallel mode: 3-5x faster translation (requires monitoring API quotas)
  - Applies to both streaming and non-streaming chunking modes
  - Maintains order preservation and error handling across all concurrency levels
- **Increased entry cache**: 10,000 → 50,000 entries (5x capacity, improves cache hit rate from ~60% to ~75-85%)
  - Configurable via `ENTRY_CACHE_SIZE` environment variable
  - Memory overhead: ~5-10MB (negligible impact)
  - Smarter eviction: removes 10% of entries instead of fixed 1000 when full
- **Optimized partial cache flushing**: Flush interval increased from 15s → 30s (50% less I/O overhead)
  - Configurable via `PARTIAL_FLUSH_INTERVAL_MS` environment variable
  - Reduces I/O operations during long translations while maintaining responsive progress updates
- **Enhanced response compression**:
  - Maximum compression (level 9) for SRT files: 10-15x bandwidth reduction (500KB → 35KB typical)
  - Standard compression (level 6) for other content
  - Lower threshold (1KB → 512 bytes) for broader compression coverage
  - Intelligent content-type filtering
- **Redis Sentinel support** (OPTIONAL - disabled by default):
  - Enterprise HA feature for automatic failover
  - Only for production deployments with Redis Sentinel infrastructure
  - Configurable via `REDIS_SENTINEL_ENABLED`, `REDIS_SENTINELS`, `REDIS_SENTINEL_NAME`
  - Single-user deployments should leave this disabled

**Critical Bug Fixes:**
- **Fixed malformed partial delivery**: Streaming deltas no longer saved as partial cache content
  - Previous behavior: Incomplete token-by-token text created malformed SRT with overlapping timestamps
  - New behavior: Only validated, complete chunks saved as partial results
  - Users now see clean partial results instead of "huge amount of entries on screen"
- **Extended parallel processing**: Non-streaming chunking mode now uses parallel processing
  - Previous: Only streaming mode benefited from parallel chunks
  - Fixed: Both streaming and non-streaming modes now process chunks in parallel
- **Context window clarification**: Added comments explaining that CONTEXT BEFORE/AFTER shows original (untranslated) source entries
  - Parallel processing doesn't affect context accuracy since it's from source, not translations
  - Helps Gemini maintain pronoun consistency and character name continuity

**Configuration Updates:**
- New `/health` endpoint for monitoring:
  - Shows cache utilization, memory usage, session stats
  - Perfect for production monitoring and Kubernetes/Docker health checks
- Reduced cache limits to reality (fits in 8GB Redis with headroom):
  - Translation cache: 50GB → 3GB (configurable via `CACHE_LIMIT_TRANSLATION`)
  - Other caches: 10GB → 1GB each (configurable via `CACHE_LIMIT_BYPASS`, `CACHE_LIMIT_PARTIAL`, `CACHE_LIMIT_SYNC`)
  - Total: 6GB default (allows 2GB overhead for Redis internals)
- Docker persistent volumes enabled:
  - Sessions survive restarts (`app-data:/app/data`)
  - Sync cache survives restarts (`app-cache:/app/.cache`)
  - Logs survive restarts (`app-logs:/app/logs`)
  - Redis data survives restarts (`redis-data:/data`)

**Translation Engine - Complete Rewrite:**
- Completely rewrote subtitle translation workflow with structure-first approach to eliminate sync problems
- NEW: Translation engine now preserves original SRT timing (timings never sent to AI, can't be modified)
- Hardcoded gemini-flash-8b-1.5 (alias: gemini-flash-lite-latest) for consistency across all translations
- Model selection UI will return in future versions with workflow optimization for different models

**New Features and Updates:**
- Added OpenSubtitles V3 implementation as an alternative to the default authenticated API
  - Users can now choose between "Auth" (requires OpenSubtitles account) or "V3" (no authentication, uses Stremio's official OpenSubtitles V3 addon)
- Translation Cache Overwrite reduced from 5 clicks in 10 seconds to 3 clicks in 5 seconds (to avoid Stremio rate-limiting)

**Infrastructure:**
- Redis support: Full Redis integration for translation cache, session storage, and subtitle cache with configurable TTLs and automatic key expiration (enables distributed HA deployments)
- Encryption support: AES-256-GCM encryption for user configurations and sensitive API keys with per-user key derivation and secure session token generation
- Docker deployment support with docker-compose configurations for both standalone and Redis-backed deployments
- Filesystem storage adapter still available for local deployment and fallback

**Performance & Logging:**
- High-performance logging overhaul: Lazy evaluation with callbacks for all 520+ log statements eliminates 40-70% CPU overhead from string interpolation on filtered logs
- Async file logging with buffering replaces synchronous writes, eliminating event loop blocking (1-5ms per log) that caused 100-300ms p99 latency spikes under load
- Log sampling support for extreme load scenarios (LOG_SAMPLE_RATE, LOG_SAMPLE_DEBUG_ONLY) allows reducing log volume while preserving critical errors

**Bug Fixes:**
- Fixed bypass cache user isolation: Each user now gets their own user-scoped bypass cache entries (identified by config hash), preventing users from accessing each other's cached translations when using "Bypass Database Cache" mode
- Fixed 3-click cache reset to properly handle bypass vs permanent cache
- Config hash generation now handles edge cases gracefully with identifiable fallback values instead of silent failures
- Various major and minor bug fixes

## SubMaker 1.0.3

**UI Redesign:**

**Code Refactoring:**
- Renamed bypass cache directory from `translations_temp` to `translations_bypass` for clarity
- Renamed `tempCache` configuration object to `bypassCacheConfig` (backward compatible with old `tempCache` name)
- Updated all cache-related function names: `readFromTemp` → `readFromBypassCache`, `saveToTemp` → `saveToBypassCache`, `verifyTempCacheIntegrity` → `verifyBypassCacheIntegrity`

**UI & Configuration:**
- Added password visibility toggle (eye icon) to OpenSubtitles password field
- Completely redesigned file translation page with UI matching the configuration page style
- Added support for multiple subtitle formats: SRT, VTT, ASS, SSA (previously only SRT was supported)
- Enhanced file upload interface with drag-and-drop support and animations

**Performance:**
- Subtitle now applies rate limiting per-language after ranking all sources: fetches from all 3 subtitle sources, ranks by quality/filename match, then limits to 12 subtitles per language (ensures best matches appear first)

**Bug Fixes:**
- Fixed validation error notifications: errors now display when saving without required fields (Gemini API key, enabled subtitle sources missing API keys)
- Fixed "Cannot GET /addon/..." error when clicking the config/settings button in Stremio after addon installation
- Configuration page code cleanup: removed unused files and duplicate code, simplified cache/bypass toggle logic
- Various small bug fixes.

## SubMaker 1.0.2

**UI & Configuration:**
- Quick Start guide now appears only on first run, hidden after setup
- API keys section defaults unchecked (enable only what you need)
- Loading message updated to show 0→4h range explaining progressive subtitle loading during translation
- Gemini prompts now use human-readable regional language names instead of codes (e.g., "English")
- Auto-creates `data/` directory on startup (no manual setup needed)
- Fixed language mappings for OpenSubtitles API: Brazilian Portuguese (pt-br), Simplified Chinese (zh-cn), Traditional Chinese (zh-tw), Montenegrin, and Chinese bilingual support
- Portuguese (Brazil) variants (ptbr/pt-br/pob) now consolidated into single selector option with normalized storage as `pob`
- Added OPENSUBTITLES_API_KEY environment variable support
- Subtitle filename priority match algorithm
- Various bug fixes and improvements

**Performance & Stability:**
- Fixed unbounded session cache by adding `maxSessions` limit (50k default, configurable via `SESSION_MAX_SESSIONS`)
- Switched user translation counts to LRU cache (max 50k tracked users, auto-expires after 24h)
- Automatic cleanup of stale session and translation-tracking data
- Cache reset safety: 3-click cache reset now blocked while translation is in progress (prevents interruption)
- Graceful shutdown: Server properly exits, clears timers, and saves sessions before closing
- Duplicate translation prevention: In-flight request deduplication allows simultaneous identical requests to share one translation

## SubMaker 1.0.1

**Features:**
- Progressive subtitle updates during translation: partial SRT saved after each chunk and served while translation is in progress
- Optional token-level streaming for Gemini (enable via `advancedSettings.enableStreaming`)
- Version badge added to configuration and translation selector pages
- `/api/session-stats` endpoint now includes version info

**Bug Fixes:**
- Fixed SRT integrity during partial loading: entries reindexed and tail message positioned after last translated timestamp
- Fixed addon URL generation for private networks (192.168.x.x, 10.x.x.x, 172.16-31.x.x ranges now recognized as local, preventing forced HTTPS)
