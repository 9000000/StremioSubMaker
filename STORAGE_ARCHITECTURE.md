# Storage Architecture - SubMaker HA Deployment

## Overview

SubMaker uses a **dual-storage architecture** to balance performance and persistence:

1. **Redis** - Hot cache (in-memory, fast)
2. **Filesystem** - Cold storage (persistent volumes, unlimited)

## Storage Types and Their Purpose

### 1. Translation Cache (TRANSLATION)
- **What:** Permanently cached translated subtitles
- **Storage:** Redis (configurable via `STORAGE_TYPE`)
- **Default Limit:** 6GB (configurable via `CACHE_LIMIT_TRANSLATION`)
- **TTL:** None (permanent until evicted by LRU)
- **Purpose:** Avoid re-translating the same subtitle
- **Eviction:** Oldest/least-used first when limit reached

### 2. Bypass Cache (BYPASS)
- **What:** User-scoped temporary translations
- **Storage:** Redis
- **Default Limit:** 2GB (configurable via `CACHE_LIMIT_BYPASS`)
- **TTL:** 12 hours
- **Purpose:** Temporary translations without polluting permanent cache
- **Eviction:** Auto-expire after 12h OR LRU when limit reached

### 3. Partial Cache (PARTIAL)
- **What:** In-progress translations (partial results)
- **Storage:** Redis
- **Default Limit:** 2GB (configurable via `CACHE_LIMIT_PARTIAL`)
- **TTL:** 1 hour
- **Purpose:** Show progress to concurrent users during translation
- **Eviction:** Auto-expire after 1h OR LRU when limit reached

### 4. Sync Cache (SYNC)
- **What:** User-synced subtitle files
- **Storage:** Filesystem (`.cache/sync_cache/`)
- **Default Limit:** 2GB (configurable via `CACHE_LIMIT_SYNC`)
- **TTL:** None (permanent)
- **Purpose:** Store manually synchronized subtitles
- **Eviction:** Oldest first when limit reached

### 5. Sessions (SESSION)
- **What:** User configuration and API keys (encrypted)
- **Storage:** Node.js memory + filesystem (`data/sessions.json`)
- **Limit:** 50,000 sessions (configurable via `SESSION_MAX_SESSIONS`)
- **TTL:** 90 days sliding expiration
- **Purpose:** Secure storage of user credentials
- **Eviction:** LRU when max sessions reached

## Redis vs Filesystem Storage

### When to Use Redis (`STORAGE_TYPE=redis`)

**Pros:**
- ⚡ Ultra-fast (sub-millisecond access)
- 🔄 Atomic operations (safe for concurrent requests)
- 📊 Built-in LRU eviction
- 🌐 Works in distributed/HA deployments

**Cons:**
- 💰 Limited by RAM (costs scale with memory)
- ⚠️ Data loss if evicted (when RAM full)
- 📏 Requires careful sizing

**Best for:**
- Production HA deployments
- Multiple pod instances
- High concurrency (100+ users)

### When to Use Filesystem (`STORAGE_TYPE=filesystem`)

**Pros:**
- 💾 Unlimited storage (limited by disk)
- 💵 Cheaper (disk vs RAM)
- 🔒 True permanence (no eviction)

**Cons:**
- 🐢 Slower than Redis (disk I/O)
- ⚠️ Not suitable for multi-pod deployments (no sharing)
- 🔄 Manual cleanup required

**Best for:**
- Single-server deployments
- VPS/bare metal hosting
- Development/testing
- Cost-conscious deployments

## Critical: Redis Memory Sizing

### The Problem

Redis persistence **saves what's in RAM to disk**, but:
- Evicted data is **gone forever**
- You can't store more than Redis `maxmemory` allows
- `--save` and `--appendonly` only persist what's currently in RAM

### Example Scenario

```yaml
redis:
  command: --maxmemory 8gb --maxmemory-policy allkeys-lru
```

**What happens:**
1. Translation cache grows to 3GB ✅
2. Bypass cache adds 1GB (total: 4GB) ✅
3. More translations arrive...
4. Redis RAM hits 8GB limit 🔴
5. **Redis starts evicting old translations** 🔴
6. "Permanent" translations are deleted 🔴
7. User requests deleted translation → API call → costs money 💸

### Solution: Match Redis Memory to Cache Limits

**Current defaults:**
- Translation: 3GB
- Bypass: 1GB
- Partial: 1GB
- Sync: 1GB
- **Total: 6GB**

**Redis configuration needed:** `--maxmemory 8gb` (6GB + 2GB overhead)

### Scaling Up

For 100+ concurrent users with large translation cache:

**Option 1: Increase Redis Memory**
```yaml
redis:
  command: --maxmemory 130gb  # 120GB cache + 10GB overhead

# Set environment variables:
CACHE_LIMIT_TRANSLATION=53687091200   # 50GB
CACHE_LIMIT_BYPASS=10737418240        # 10GB
CACHE_LIMIT_PARTIAL=10737418240       # 10GB
CACHE_LIMIT_SYNC=53687091200          # 50GB
```

**Requires:** 130GB+ RAM pod (expensive!)

**Option 2: Accept Limited Cache**
Keep 8GB Redis, accept that old translations will be evicted and re-translated occasionally.

**Monitoring:** Use `/health` endpoint to track cache utilization

## Persistent Volumes in Docker/Kubernetes

### Docker Compose Setup

```yaml
services:
  stremio-submaker:
    volumes:
      - app-data:/app/data          # Sessions persist here
      - app-cache:/app/.cache       # Filesystem caches persist here
      - app-logs:/app/logs          # Logs persist here

  redis:
    volumes:
      - redis-data:/data            # Redis AOF/RDB files persist here

volumes:
  app-data:
    driver: local
  app-cache:
    driver: local
  app-logs:
    driver: local
  redis-data:
    driver: local
```

### Kubernetes Setup

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: submaker-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi  # For sessions

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: submaker-cache
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi  # For filesystem caches

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 200Gi  # Match Redis maxmemory + overhead
```

## Monitoring Cache Health

### Health Check Endpoint

```bash
curl http://localhost:7001/health
```

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600,
  "storage": {
    "type": "redis",
    "healthy": true,
    "caches": {
      "translation": {
        "currentMB": "2048.50",
        "limitMB": "3072.00",
        "utilizationPercent": "66.7"
      },
      "bypass": {
        "currentMB": "512.25",
        "limitMB": "1024.00",
        "utilizationPercent": "50.0"
      }
    }
  },
  "memory": {
    "rss": "850.23 MB",
    "heapUsed": "456.78 MB"
  },
  "sessions": {
    "active": 1234,
    "maxSessions": 50000
  }
}
```

### Session Statistics

```bash
curl http://localhost:7001/api/session-stats
```

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_TYPE` | `filesystem` | `redis` or `filesystem` |
| `CACHE_LIMIT_TRANSLATION` | `6GB` | Translation cache size (bytes) |
| `CACHE_LIMIT_BYPASS` | `2GB` | Bypass cache size (bytes) |
| `CACHE_LIMIT_PARTIAL` | `2GB` | Partial cache size (bytes) |
| `CACHE_LIMIT_SYNC` | `2GB` | Sync cache size (bytes) |
| `SESSION_MAX_SESSIONS` | `50000` | Maximum concurrent sessions |
| `REDIS_HOST` | `localhost` | Redis server hostname |
| `REDIS_PORT` | `6379` | Redis server port |

### Quick Calculation Helper

**GB to Bytes:**
- 1 GB = `1073741824` bytes
- 10 GB = `10737418240` bytes
- 50 GB = `53687091200` bytes
- 100 GB = `107374182400` bytes

## Deployment Checklist

- [ ] Decided on `STORAGE_TYPE` (redis or filesystem)
- [ ] Sized Redis `maxmemory` to match cache limits
- [ ] Configured persistent volumes for data/cache/logs
- [ ] Configured persistent volume for Redis data
- [ ] Set appropriate `CACHE_LIMIT_*` environment variables
- [ ] Tested `/health` endpoint responds
- [ ] Configured K8s readiness/liveness probes
- [ ] Set up monitoring for cache utilization
- [ ] Reviewed log sampling settings for production load

## Common Issues

### "Translations keep disappearing"
- **Cause:** Redis evicting data (RAM full)
- **Fix:** Increase Redis maxmemory OR reduce cache limits

### "Sessions lost after pod restart"
- **Cause:** No persistent volume mounted
- **Fix:** Mount `app-data` volume to `/app/data`

### "Sync cache not persisting"
- **Cause:** No persistent volume for `.cache` directory
- **Fix:** Mount `app-cache` volume to `/app/.cache`

### "Redis won't start"
- **Cause:** Not enough RAM allocated to pod
- **Fix:** Increase pod memory limits OR reduce Redis maxmemory

## Questions for Your DevOps Team

1. **What pod size (RAM)?** → Determines Redis maxmemory setting
2. **Persistent volumes available?** → Required for data persistence
3. **Single pod or multi-pod?** → Affects storage type choice
4. **Budget for RAM vs disk?** → Redis (fast, expensive) vs Filesystem (slow, cheap)
5. **Expected concurrent users?** → Affects session limits and cache sizing

---

**TL;DR:** Redis is fast but limited by RAM. Match your cache size limits to Redis memory. Use persistent volumes or you'll lose data on restart.
