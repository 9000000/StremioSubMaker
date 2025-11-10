const StorageAdapter = require('./StorageAdapter');
const FilesystemStorageAdapter = require('./FilesystemStorageAdapter');
const RedisStorageAdapter = require('./RedisStorageAdapter');
const StorageFactory = require('./StorageFactory');

module.exports = {
  StorageAdapter,
  FilesystemStorageAdapter,
  RedisStorageAdapter,
  StorageFactory
};
