class StorageUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.isStorageUnavailable = true;
    this.operation = options.operation;
    this.cause = options.cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StorageUnavailableError);
    }
  }
}

class SessionCapacityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SessionCapacityError';
    this.isSessionCapacity = true;
    this.reason = options.reason || 'capacity';
    this.limit = Number.isFinite(options.limit) ? options.limit : null;
    this.current = Number.isFinite(options.current) ? options.current : null;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SessionCapacityError);
    }
  }
}

module.exports = { SessionCapacityError, StorageUnavailableError };
