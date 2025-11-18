# Session Purge Mechanism Review

## Overview
This document reviews the 50,000 session limit and purge mechanism implemented in StremioSubMaker.

---

## 1. Configuration & Limits

### Session Limit
- **Location**: `index.js:43`
- **Default**: 50,000 concurrent sessions
- **Environment Variable**: `SESSION_MAX_SESSIONS`
- **Scope**: **GLOBAL** (across all users, not per-user)

```javascript
const sessionOptions = {
    maxSessions: parseInt(process.env.SESSION_MAX_SESSIONS) || 50000,
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 90 * 24 * 60 * 60 * 1000, // 90 days
    persistencePath: process.env.SESSION_PERSISTENCE_PATH || './data/sessions.json'
};
```

### Per-User Limits
- **Translation Concurrency**: 3 concurrent translations per user (`src/handlers/subtitles.js:52`)
- **Session Limit**: **NONE** - A single user could theoretically create all 50k sessions
- **User Tracking**: Separate LRU cache tracking up to 50k users with 24h TTL

---

## 2. Architecture: Two-Tier System

### Tier 1: In-Memory Cache (LRU)
- **Implementation**: `lru-cache` package (`src/utils/sessionManager.js:131`)
- **Capacity**: 50,000 sessions (configurable)
- **Eviction Strategy**: **Least Recently Used (LRU)**
- **TTL**: 90 days with **sliding expiration** (`updateAgeOnGet: true`)
- **Purpose**: Fast access to active sessions

### Tier 2: Persistent Storage
- **Backends**: Redis or Filesystem
- **Capacity**: **UNBOUNDED** (limited only by disk/Redis memory)
- **Purpose**: Durability across restarts, multi-instance support
- **Behavior**: Sessions evicted from memory can be reloaded from storage on next access

---

## 3. Purge & Cleanup Mechanisms

### A. LRU Automatic Eviction
**When**: Session creation when cache is full (50k entries)

**Strategy**: Least Recently Used (LRU)
- Evicts sessions that haven't been accessed recently
- **NOT** purely age-based ("oldest by creation date")
- Sliding window: Each session access refreshes its position in the LRU

**Location**: Handled automatically by `lru-cache` package

**Dispose Callback**: `src/utils/sessionManager.js:124-126`
```javascript
dispose: (value, key) => {
    log.debug(() => `[SessionManager] Session expired: ${key}`);
}
```

### B. Memory Cleanup Timer
**When**: Every hour (`src/utils/sessionManager.js:720`)

**Strategy**: Age-based eviction from memory only
- Evicts sessions not accessed in **30 days** from in-memory cache
- Sessions remain in persistent storage (Redis/filesystem)
- Reloaded on next access via `loadSessionFromStorage()`

**Purpose**: Prevent long-lived but inactive sessions from bloating memory

**Code**: `src/utils/sessionManager.js:714-752`

### C. TTL-Based Expiration
**When**: On session access (`getSession()`)

**Strategy**: Absolute expiration after 90 days of inactivity
- Sessions older than 90 days (configurable) are deleted from both memory and storage
- Uses sliding expiration: TTL resets on each access

**Code**: `src/utils/sessionManager.js:507-512`

---

## 4. Is "Oldest" Strategy Appropriate?

### Current Strategy: LRU (NOT oldest)
The system does **NOT** use simple "oldest by creation date". Instead:

1. **Primary eviction**: **LRU (Least Recently Used)**
   - Tracks access time, not creation time
   - Evicts sessions that haven't been used recently
   - ✅ **CORRECT** - This is the right approach for sessions

2. **Secondary cleanup**: **Age-based memory eviction**
   - 30-day inactivity threshold for memory cleanup
   - Does NOT delete from storage
   - ✅ **CORRECT** - Prevents memory bloat while preserving sessions

3. **Final expiration**: **90-day TTL with sliding window**
   - Complete deletion after 90 days of no access
   - ✅ **CORRECT** - Prevents indefinite session accumulation

### Why LRU is Better Than "Oldest"
- **User Experience**: Active users keep their sessions even if created long ago
- **Fairness**: Inactive sessions are evicted regardless of age
- **Efficiency**: Hot sessions stay in memory, cold sessions move to storage

**Verdict**: ✅ The current strategy is **appropriate and well-designed**

---

## 5. Storage vs Memory

### Current Behavior
| Component | Memory (LRU) | Storage (Redis/FS) |
|-----------|--------------|---------------------|
| **Limit** | 50k sessions | Unlimited* |
| **Eviction** | LRU + 30-day age | 90-day TTL only |
| **On eviction** | Kept in storage | Deleted permanently |
| **On access** | Fast | Reload to memory |

\* Storage is technically unbounded - only limited by disk space or Redis `maxmemory`

### Potential Issues
1. **No storage size limit**: Sessions can grow unbounded in Redis/filesystem
   - Redis: Relies on external `maxmemory` configuration
   - Filesystem: No limit until disk fills

2. **No per-user limit**: One user could create 50k sessions
   - Risk: Session stuffing attack
   - Mitigation: Global 50k cap + LRU eviction provides some protection

---

## 6. Per-User/Per-Session Limits

### Session Limits
- ❌ **No per-user session limit**
- ✅ Global 50k limit across all users
- ❌ No rate limiting on session creation

### Translation Limits
- ✅ **3 concurrent translations per user** (`MAX_CONCURRENT_TRANSLATIONS_PER_USER`)
- ✅ User tracking via separate LRU cache (50k users, 24h TTL)

### Security Implications
**Risk**: A malicious or buggy client could:
1. Create sessions until hitting global 50k cap
2. Evict legitimate user sessions (via LRU)
3. Fill up storage (Redis/filesystem)

**Current Mitigations**:
- LRU eviction prevents permanent session monopolization
- 90-day TTL prevents indefinite growth
- Session tokens are cryptographically random (hard to guess)

**Missing Mitigations**:
- No per-IP rate limiting on session creation
- No per-user session count limit
- No storage size cap

---

## 7. Recommendations

### Critical (Security)
1. **Add per-user session limit** (e.g., 10 sessions per user config hash)
   - Track sessions per user via LRU cache
   - Delete oldest user session when limit reached
   - Prevents single user from monopolizing global session pool

2. **Add rate limiting on session creation** (e.g., 10 sessions/hour per IP)
   - Use existing `express-rate-limit` infrastructure
   - Prevents session creation floods

### Important (Reliability)
3. **Add storage size cap for sessions** (e.g., SESSION_STORAGE_LIMIT_BYTES)
   - Monitor total session storage size
   - Run cleanup when approaching limit
   - Aligns with existing cache size limit architecture

4. **Document SESSION_MAX_SESSIONS in .env.example**
   - Currently missing from .env.example
   - Add under "Session Management" section

### Nice-to-Have (Observability)
5. **Add session metrics endpoint**
   - Total sessions in memory vs storage
   - Eviction rate
   - Storage size used
   - Top users by session count

6. **Alert on abnormal session growth**
   - Log warning if evictions spike
   - Alert if approaching 50k limit
   - Monitor storage size growth rate

---

## 8. Code Locations Reference

| Component | File | Lines |
|-----------|------|-------|
| Session limit config | `index.js` | 40-53 |
| LRU cache init | `src/utils/sessionManager.js` | 118-131 |
| Memory cleanup timer | `src/utils/sessionManager.js` | 714-752 |
| TTL expiration check | `src/utils/sessionManager.js` | 507-512 |
| Storage loading fallback | `src/utils/sessionManager.js` | 489-542 |
| Translation concurrency limit | `src/handlers/subtitles.js` | 52 |
| User tracking cache | `src/handlers/subtitles.js` | 47-51 |

---

## 9. Summary

### What Works Well ✅
- **LRU eviction**: Correct strategy for session management
- **Two-tier architecture**: Memory + storage provides good balance
- **Sliding expiration**: Keeps active sessions alive
- **Memory cleanup**: Prevents unbounded memory growth
- **Per-user translation limits**: Prevents API abuse

### What Needs Improvement ⚠️
- **No per-user session limit**: Risk of session monopolization
- **No session creation rate limiting**: Risk of session floods
- **No storage size cap**: Risk of disk/Redis exhaustion
- **Missing documentation**: SESSION_MAX_SESSIONS not in .env.example

### Overall Assessment
The current implementation is **well-designed** for the core use case, but lacks **defense-in-depth** for multi-tenant scenarios. The LRU strategy is appropriate and superior to simple age-based eviction.

**Priority**: Address per-user session limits and rate limiting to prevent resource exhaustion attacks.

---

*Review Date: 2025-11-18*
*Reviewer: Claude*
*Branch: claude/review-session-purge-limits-01LWWePjoF3PDpxDm9VRABRX*
