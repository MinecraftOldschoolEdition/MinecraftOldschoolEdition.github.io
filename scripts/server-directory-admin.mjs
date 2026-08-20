#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDirectoryStorage, hashCredentialToken } from '../lib/server-directory/postgres-storage.js';

function usage() {
  console.error('Usage:');
  console.error('  npm run server-directory:migrate');
  console.error('  npm run server-directory:credential -- create <label>');
  console.error('  npm run server-directory:credential -- disable <credential-id>');
  console.error('  npm run server-directory:credential -- rotate <credential-id>');
  console.error('  npm run server-directory:prune -- <retention-days>');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeLabel(parts) {
  const label = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Credential label must contain 1 to 100 visible characters.');
  return label;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const storage = new PostgresDirectoryStorage(databaseUrl);
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'migrate') {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const migration = await fs.readFile(path.join(here, '..', 'migrations', '001_server_directory_v1.sql'), 'utf8');
      await storage.sql.unsafe(migration);
      console.log('Applied migrations/001_server_directory_v1.sql');
    } else if (command === 'create') {
      const label = normalizeLabel(args);
      const token = newToken();
      const credential = await storage.createCredential(label, hashCredentialToken(token));
      console.log(`Credential ID: ${credential.credential_id}`);
      console.log(`Token (shown once): ${token}`);
    } else if (command === 'disable' && args.length === 1) {
      const credential = await storage.disableCredential(args[0]);
      console.log(`Disabled credential ${credential.credential_id} (${credential.label})`);
    } else if (command === 'rotate' && args.length === 1) {
      const token = newToken();
      const credential = await storage.rotateCredential(args[0], hashCredentialToken(token));
      console.log(`Rotated credential ${credential.credential_id} (${credential.label})`);
      console.log(`Token (shown once): ${token}`);
    } else if (command === 'prune' && args.length === 1) {
      const retentionDays = Number(args[0]);
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Retention days must be an integer from 1 to 3650.');
      const cutoff = new Date(Date.now() - retentionDays * 86400000);
      const result = await storage.pruneChangesBefore(cutoff);
      console.log(`Pruned through sequence ${result.deletedThroughSequence}; minimum retained sequence is ${result.minimumRetainedSequence}.`);
    } else {
      usage();
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await storage.close();
  }
}
