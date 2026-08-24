const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getIsolationKey } = require('../utils/isolation');

/**
 * Filesystem Storage Adapter
 *
 * Stores all cache data on the local filesystem.
 * This is the default storage adapter and maintains backwards compatibility.
 */
class FilesystemStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    const isolationSegment = getIsolationKey();
    this.baseDir = options.baseDir || path.join(process.cwd(), '.cache', isolationSegment);

    // Cache directories for each type
    this.directories = {
      [StorageAdapter.CACHE_TYPES.TRANSLATION]: path.join(this.baseDir, 'translations'),
      [StorageAdapter.CACHE_TYPES.BYPASS]: path.join(this.baseDir, 'translations_bypass'),
      [StorageAdapter.CACHE_TYPES.PARTIAL]: path.join(this.baseDir, 'translations_partial'),
      [StorageAdapter.CACHE_TYPES.SYNC]: path.join(this.baseDir, 'sync_cache'),
      [StorageAdapter.CACHE_TYPES.AUTOSUB]: path.join(this.baseDir, 'autosub_cache'),
      [StorageAdapter.CACHE_TYPES.EMBEDDED]: path.join(this.baseDir, 'embedded_cache'),
      [StorageAdapter.CACHE_TYPES.SESSION]: path.join(process.cwd(), 'data'),
      [StorageAdapter.CACHE_TYPES.HISTORY]: path.join(this.baseDir, 'history'),
      [StorageAdapter.CACHE_TYPES.PROVIDER_METADATA]: path.join(this.baseDir, 'provider_meta'),
      [StorageAdapter.CACHE_TYPES.SMDB]: path.join(this.baseDir, 'smdb')
    };

    this.initialized = false;

    // Track cache sizes in memory for better performance
    this.cacheSizes = {};
  }

  _getSessionStorageUsage({ removeExpired = false } = {}) {
    const dir = this.directories[StorageAdapter.CACHE_TYPES.SESSION];
    if (!fs.existsSync(dir)) return { count: 0, bytes: 0 };

    let count = 0;
    let bytes = 0;
    const now = Date.now();
    for (const file of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (removeExpired) {
          const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (wrapper?.expiresAt && now > wrapper.expiresAt) {
            fs.unlinkSync(filePath);
            continue;
          }
        }
        count += 1;
        bytes += stats.size;
      } catch (_) {
        // Unreadable/corrupt entries remain on disk but cannot be admitted as
        // free space. Account their stat size when possible.
        try {
          bytes += fs.statSync(filePath).size;
        } catch (_) { /* best effort */ }
      }
    }
    return { count, bytes };
  }

  async _withSessionCreationLock(operation) {
    const sessionDir = this.directories[StorageAdapter.CACHE_TYPES.SESSION];
    const lockPath = path.join(sessionDir, '.session-create.lock');
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
      let descriptor = null;
      try {
        descriptor = fs.openSync(lockPath, 'wx');
        try {
          return await operation();
        } finally {
          try { fs.closeSync(descriptor); } catch (_) { /* already closed */ }
          try { fs.unlinkSync(lockPath); } catch (_) { /* best effort */ }
        }
      } catch (error) {
        if (descriptor !== null) {
          try { fs.closeSync(descriptor); } catch (_) { /* best effort */ }
        }
        if (error?.code !== 'EEXIST') throw error;

        try {
          const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (lockAge > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (_) {
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    return { ok: false, reason: 'busy' };
  }

  /**
   * Sanitize cache key to prevent path traversal attacks
   * @private
   */
  _sanitizeKey(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('Cache key must be a non-empty string');
    }

    // First, decode any URL-encoded characters to catch encoded traversal attempts
    let decoded = key;
    try {
      // Decode twice to catch double-encoding
      decoded = decodeURIComponent(decodeURIComponent(key));
    } catch (e) {
      // If decoding fails, use original (it's safer)
      decoded = key;
    }

    // Remove all path separators and dots (including encoded versions)
    // This prevents: ../ ./ .\ ..\ and any variations
    let sanitized = decoded.replace(/[.\/\\]/g, '_');

    // Remove any remaining special/control characters
    // Only allow alphanumeric, underscore, and hyphen
    sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Prevent empty or only-special-char keys
    if (!sanitized || /^[_-]+$/.test(sanitized)) {
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      sanitized = 'key_' + hash.substring(0, 16);
    }

    // Limit length and hash if too long
    if (sanitized.length > 200) {
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      sanitized = sanitized.substring(0, 150) + '_' + hash.substring(0, 16);
    }

    return sanitized;
  }

  /**
   * Get the file path for a cache entry
   * @private
   */
  _getFilePath(key, cacheType) {
    const dir = this.directories[cacheType];
    const safeKey = this._sanitizeKey(key);

    // Special handling for session type
    if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
      return path.join(dir, `${safeKey}.json`);
    }

    return path.join(dir, `${safeKey}.json`);
  }

  /**
   * Verify path is within the allowed directory (security check)
   * Prevents path traversal attacks even if key sanitization is bypassed
   * @private
   * @throws {Error} If path escapes the allowed directory
   */
  _verifyPath(filePath, cacheType) {
    const resolvedPath = path.resolve(filePath);
    const resolvedDir = path.resolve(this.directories[cacheType]);

    // Ensure resolved path starts with the allowed directory
    // Use path.sep to ensure proper directory boundary check
    const isWithinDir = resolvedPath.startsWith(resolvedDir + path.sep) || resolvedPath === resolvedDir;

    if (!isWithinDir) {
      log.error(() => [
        '[FilesystemStorage] Path traversal attempt detected!',
        `Attempted path: ${resolvedPath}`,
        `Allowed directory: ${resolvedDir}`,
        `Cache type: ${cacheType}`
      ]);
      throw new Error('Path traversal detected - access denied');
    }

    return true;
  }

  /**
   * Calculate directory size
   * @private
   */
  _calculateDirectorySize(dir) {
    if (!fs.existsSync(dir)) {
      return 0;
    }

    let totalSize = 0;
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      } catch (error) {
        // Skip files that can't be accessed
      }
    }

    return totalSize;
  }

  /**
   * Initialize the filesystem storage
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Create all cache directories
      for (const [cacheType, dir] of Object.entries(this.directories)) {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Calculate initial cache sizes
        this.cacheSizes[cacheType] = this._calculateDirectorySize(dir);
      }

      this.initialized = true;
      log.debug(() => 'Filesystem storage adapter initialized successfully');
    } catch (error) {
      log.error(() => 'Failed to initialize filesystem storage adapter:', error);
      throw error;
    }
  }

  /**
   * Get a value from filesystem
   */
  async get(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      // Verify path is within allowed directory (throws on traversal attempt)
      this._verifyPath(filePath, cacheType);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // Touch file to update atime for LRU
      try {
        const stats = fs.statSync(filePath);
        fs.utimesSync(filePath, new Date(), stats.mtime);
      } catch (error) {
        // Ignore touch errors
      }

      const data = JSON.parse(content);

      // Check if expired
      if (data.expiresAt && Date.now() > data.expiresAt) {
        fs.unlinkSync(filePath);
        return null;
      }

      // Return the content field if it exists, otherwise return the whole object
      return data.content !== undefined ? data.content : data;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to read key ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Set a value in filesystem
   */
  async set(key, value, cacheType, ttl = null) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);
      const tempPath = `${filePath}.tmp`;
      const previousSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      const isSessionToken = cacheType === StorageAdapter.CACHE_TYPES.SESSION
        && /^[a-f0-9]{32}$/.test(key);

      // Verify path is within allowed directory (throws on traversal attempt)
      this._verifyPath(filePath, cacheType);

      // Prepare data to store
      const now = Date.now();
      const expiresAt = ttl ? now + (ttl * 1000) : null;

      // Preserve createdAt if file already exists
      let preservedCreatedAt = null;
      try {
        if (fs.existsSync(filePath)) {
          const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (existing && typeof existing.createdAt === 'number') {
            preservedCreatedAt = existing.createdAt;
          }
        }
      } catch (_) {
        // ignore read/parse errors and fall back to now
      }

      const data = {
        key,
        content: value,
        createdAt: preservedCreatedAt || now,
        expiresAt
      };
      const jsonData = JSON.stringify(data, null, 2);

      const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
      if (isSessionToken && sizeLimit) {
        const currentUsage = this._getSessionStorageUsage();
        const projectedSize = currentUsage.bytes - previousSize + Buffer.byteLength(jsonData, 'utf8');
        if (projectedSize > sizeLimit) {
          log.warn(() => `[Filesystem] Refused session write above hard byte quota (${projectedSize} > ${sizeLimit})`);
          return false;
        }
      }

      // Atomic write: write to temp then rename
      try {
        const fd = fs.openSync(tempPath, 'w');
        fs.writeSync(fd, jsonData);

        // Ensure data hits disk before rename
        try {
          fs.fsyncSync(fd);
        } catch (error) {
          // Ignore fsync errors on unsupported platforms
        }

        fs.closeSync(fd);
        fs.renameSync(tempPath, filePath);
      } finally {
        // Cleanup stray temp file on failure
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (error) {
          // Ignore cleanup errors
        }
      }

      // Update cache size
      const stats = fs.statSync(filePath);
      this.cacheSizes[cacheType] = Math.max(0, (this.cacheSizes[cacheType] || 0) - previousSize + stats.size);

      // Check if we need to enforce size limits
      if (cacheType !== StorageAdapter.CACHE_TYPES.SESSION && sizeLimit && this.cacheSizes[cacheType] > sizeLimit) {
        // Don't await - run cleanup in background
        this._enforceLimit(cacheType).catch(err => {
          log.error(() => `[Filesystem] Background cleanup error:`, err);
        });
      }

      return true;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to set key ${key}:`, error.message);
      return false;
    }
  }

  async createSession(key, value, ttl = null, limits = {}) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    return this._withSessionCreationLock(async () => {
      const filePath = this._getFilePath(key, StorageAdapter.CACHE_TYPES.SESSION);
      this._verifyPath(filePath, StorageAdapter.CACHE_TYPES.SESSION);
      if (fs.existsSync(filePath)) {
        return { ok: false, reason: 'exists' };
      }

      const usage = this._getSessionStorageUsage({ removeExpired: true });
      const maxSessions = Number(limits.maxSessions);
      if (Number.isFinite(maxSessions) && maxSessions > 0 && usage.count >= maxSessions) {
        return { ok: false, reason: 'count', current: usage.count, limit: maxSessions };
      }

      const maxBytes = Number(limits.maxBytes) > 0
        ? Number(limits.maxBytes)
        : StorageAdapter.SIZE_LIMITS[StorageAdapter.CACHE_TYPES.SESSION];
      const now = Date.now();
      const wrapper = {
        key,
        content: value,
        createdAt: now,
        expiresAt: ttl ? now + (ttl * 1000) : null
      };
      const newBytes = Buffer.byteLength(JSON.stringify(wrapper, null, 2), 'utf8');
      if (maxBytes && usage.bytes + newBytes > maxBytes) {
        return { ok: false, reason: 'bytes', current: usage.bytes + newBytes, limit: maxBytes };
      }

      const persisted = await this.set(key, value, StorageAdapter.CACHE_TYPES.SESSION, ttl);
      return persisted ? { ok: true } : { ok: false, reason: 'storage' };
    });
  }

  async updateSession(key, value, ttl = null, limits = {}) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    const filePath = this._getFilePath(key, StorageAdapter.CACHE_TYPES.SESSION);
    this._verifyPath(filePath, StorageAdapter.CACHE_TYPES.SESSION);
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };

    const existingSize = fs.statSync(filePath).size;
    let createdAt = Date.now();
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Number.isFinite(existing?.createdAt)) createdAt = existing.createdAt;
    } catch (_) { /* set() will retain its normal recovery behavior */ }

    const now = Date.now();
    const wrapper = {
      key,
      content: value,
      createdAt,
      expiresAt: ttl ? now + (ttl * 1000) : null
    };
    const maxBytes = Number(limits.maxBytes) > 0
      ? Number(limits.maxBytes)
      : StorageAdapter.SIZE_LIMITS[StorageAdapter.CACHE_TYPES.SESSION];
    const usage = this._getSessionStorageUsage();
    const projectedSize = usage.bytes - existingSize + Buffer.byteLength(JSON.stringify(wrapper, null, 2), 'utf8');
    if (maxBytes && projectedSize > maxBytes) {
      return { ok: false, reason: 'bytes', current: projectedSize, limit: maxBytes };
    }

    const persisted = await this.set(key, value, StorageAdapter.CACHE_TYPES.SESSION, ttl);
    return persisted ? { ok: true } : { ok: false, reason: 'storage' };
  }

  /**
   * Delete a value from filesystem
   */
  async delete(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      // Verify path is within allowed directory (throws on traversal attempt)
      this._verifyPath(filePath, cacheType);

      if (!fs.existsSync(filePath)) {
        return false;
      }

      // Get file size before deleting
      const stats = fs.statSync(filePath);
      fs.unlinkSync(filePath);

      // Update cache size
      this.cacheSizes[cacheType] = Math.max(0, (this.cacheSizes[cacheType] || 0) - stats.size);

      return true;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to delete key ${key}:`, error.message);
      return false;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType)) {
        return false;
      }

      return fs.existsSync(filePath);
    } catch (error) {
      log.error(() => `[Filesystem] Failed to check existence of key ${key}:`, error.message);
      return false;
    }
  }

  /**
   * List keys matching a pattern
   */
  async list(cacheType, pattern = '*') {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const dir = this.directories[cacheType];

      if (!fs.existsSync(dir)) {
        return [];
      }

      const files = fs.readdirSync(dir);
      const keys = [];

      for (const file of files) {
        // Skip temp files
        if (file.endsWith('.tmp')) {
          continue;
        }

        // Remove .json extension
        const key = file.replace(/\.json$/, '');

        // Simple pattern matching (only supports * wildcard)
        if (pattern === '*' || this._matchPattern(key, pattern)) {
          keys.push(key);
        }
      }

      return keys;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to list keys for cache type ${cacheType}:`, error.message);
      return [];
    }
  }

  /**
   * Simple pattern matching helper
   * @private
   */
  _matchPattern(str, pattern) {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }

  /**
   * Get the total size of a cache type
   */
  async size(cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      // Recalculate to ensure accuracy
      const dir = this.directories[cacheType];
      const actualSize = this._calculateDirectorySize(dir);
      this.cacheSizes[cacheType] = actualSize;
      return actualSize;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to calculate size for cache type ${cacheType}:`, error.message);
      return 0;
    }
  }

  /**
   * Get metadata about a cached entry
   */
  async metadata(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType) || !fs.existsSync(filePath)) {
        return null;
      }

      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);

      return {
        size: stats.size,
        createdAt: data.createdAt || stats.birthtimeMs,
        expiresAt: data.expiresAt || null
      };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to get metadata for key ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Enforce size limit by evicting oldest entries (LRU)
   * @private
   */
  async _enforceLimit(cacheType) {
    const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
    if (!sizeLimit) {
      return { deleted: 0, bytesFreed: 0 };
    }

    if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
      return { deleted: 0, bytesFreed: 0 };
    }

    try {
      const currentSize = await this.size(cacheType);
      const targetSize = Math.floor(sizeLimit * 0.8); // Free up to 80% of limit

      if (currentSize <= targetSize) {
        return { deleted: 0, bytesFreed: 0 };
      }

      const dir = this.directories[cacheType];
      const files = fs.readdirSync(dir);

      // Get file stats and sort by access time (oldest first)
      const fileStats = [];
      for (const file of files) {
        if (file.endsWith('.tmp')) continue;

        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          fileStats.push({
            path: filePath,
            atime: stats.atimeMs,
            size: stats.size
          });
        } catch (error) {
          // Skip files that can't be accessed
        }
      }

      // Sort by access time (oldest first)
      fileStats.sort((a, b) => a.atime - b.atime);

      // Delete oldest files until we reach target size
      let deleted = 0;
      let bytesFreed = 0;
      let remainingSize = currentSize;

      for (const file of fileStats) {
        if (remainingSize <= targetSize) {
          break;
        }

        try {
          fs.unlinkSync(file.path);
          deleted++;
          bytesFreed += file.size;
          remainingSize -= file.size;
        } catch (error) {
          log.error(() => `[Filesystem] Failed to delete file ${file.path}:`, error.message);
        }
      }

      // Update cache size
      this.cacheSizes[cacheType] = remainingSize;

      log.debug(() => `[Filesystem] Enforced ${cacheType} cache limit: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to enforce limit for cache type ${cacheType}:`, error.message);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanup(cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const dir = this.directories[cacheType];

      if (!fs.existsSync(dir)) {
        return { deleted: 0, bytesFreed: 0 };
      }

      const files = fs.readdirSync(dir);
      const now = Date.now();

      let deleted = 0;
      let bytesFreed = 0;

      for (const file of files) {
        if (file.endsWith('.tmp')) continue;

        const filePath = path.join(dir, file);

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);

          // Check if expired
          if (data.expiresAt && now > data.expiresAt) {
            const stats = fs.statSync(filePath);
            fs.unlinkSync(filePath);
            deleted++;
            bytesFreed += stats.size;
          }
        } catch (error) {
          // Skip files that can't be read or parsed
        }
      }

      // Also enforce size limits
      const limitResult = await this._enforceLimit(cacheType);
      deleted += limitResult.deleted;
      bytesFreed += limitResult.bytesFreed;

      if (deleted > 0) {
        log.debug(() => `[Filesystem] Cleaned up ${cacheType}: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      }

      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to cleanup cache type ${cacheType}:`, error.message);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Close the filesystem storage (no-op for filesystem)
   */
  async close() {
    this.initialized = false;
    log.debug(() => 'Filesystem storage adapter closed');
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.initialized) {
      return false;
    }

    try {
      // Check if we can read/write to all directories
      for (const [cacheType, dir] of Object.entries(this.directories)) {
        if (!fs.existsSync(dir)) {
          return false;
        }

        // Try to create a test file
        const testFile = path.join(dir, '.health-check');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
      }

      return true;
    } catch (error) {
      log.error(() => '[Filesystem] Health check failed:', error);
      return false;
    }
  }
}

module.exports = FilesystemStorageAdapter;
