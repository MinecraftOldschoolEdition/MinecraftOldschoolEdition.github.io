import { PostgresDirectoryStorage } from './postgres-storage.js';

let storage;

export function getDirectoryStorage() {
  if (storage) return storage;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Server directory unavailable: DATABASE_URL is required; production never falls back to in-memory storage.');
  }
  storage = new PostgresDirectoryStorage(databaseUrl);
  return storage;
}

export function setDirectoryStorageForTests(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test storage injection is only available when NODE_ENV=test.');
  storage = value;
}
