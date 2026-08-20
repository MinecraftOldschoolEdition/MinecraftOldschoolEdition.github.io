import crypto from 'node:crypto';
import { DirectoryError } from './errors.js';
import { clone, toPublicListing } from './model.js';
import { hashCredentialToken } from './postgres-storage.js';

function conflict(listing) {
  throw new DirectoryError(409, 'revision_conflict', 'The listing changed since it was loaded.', {
    currentRevision: listing ? listing.revision : null
  }, listing && listing.status === 'active' ? toPublicListing(listing) : null);
}

export class InMemoryDirectoryStorage {
  constructor() {
    this.credentials = new Map();
    this.listings = new Map();
    this.changes = [];
    this.nextListingNumber = 1;
    this.nextSequence = 1;
    this.retainedAfter = 0;
  }

  async close() {}

  async authenticate(token) {
    const hash = hashCredentialToken(token || '');
    for (const credential of this.credentials.values()) {
      if (credential.enabled && credential.tokenHash === hash) {
        credential.lastUsedAt = new Date().toISOString();
        return { id: credential.id, label: credential.label };
      }
    }
    return null;
  }

  async getListing(credentialId) {
    const row = this.listings.get(credentialId);
    return row && row.status === 'active' ? toPublicListing(row) : null;
  }

  assertCredential(credentialId) {
    const credential = this.credentials.get(credentialId);
    if (!credential || !credential.enabled) throw new DirectoryError(401, 'unauthorized', 'Invalid or disabled server credential.');
  }

  assertCooldown(existing, now, cooldownMs) {
    if (!existing) return;
    const elapsed = now.getTime() - new Date(existing.lastMutationAt).getTime();
    if (elapsed < cooldownMs) {
      throw new DirectoryError(429, 'mutation_cooldown', 'This server listing was changed too recently.', {
        retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000))
      });
    }
  }

  assertUniqueEndpoint(credentialId, endpoint) {
    for (const [owner, row] of this.listings) {
      if (owner !== credentialId && row.status === 'active' && row.normalizedEndpoint === endpoint) {
        throw new DirectoryError(409, 'duplicate_endpoint', 'An active listing already uses this host and port.');
      }
    }
  }

  async putListing(credentialId, input, options = {}) {
    this.assertCredential(credentialId);
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    const existing = this.listings.get(credentialId) || null;
    this.assertCooldown(existing, now, cooldownMs);
    if (existing && existing.status === 'active' && input.expectedRevision !== existing.revision) conflict(existing);
    if (!existing && input.expectedRevision !== null) conflict(null);
    if (existing && existing.status !== 'active' && input.expectedRevision !== null) conflict(existing);
    this.assertUniqueEndpoint(credentialId, input.normalizedEndpoint);

    const created = !existing;
    const row = {
      listingId: existing?.listingId || crypto.randomUUID(),
      listingNumber: existing?.listingNumber || this.nextListingNumber++,
      credentialId,
      normalizedHost: input.host,
      host: input.host,
      port: input.port,
      normalizedEndpoint: input.normalizedEndpoint,
      name: input.name,
      creatorUsername: input.creatorUsername,
      creatorUuid: input.creatorUuid,
      description: input.description,
      tagIds: [...input.tagIds],
      revision: existing ? existing.revision + 1 : 1,
      status: 'active',
      createdAt: existing?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      lastMutationAt: now.toISOString()
    };
    const listing = toPublicListing(row);
    const change = { sequence: this.nextSequence++, operation: 'upsert', listing: clone(listing) };

    if (options.failBeforeCommit) throw new Error('Injected transaction failure');
    this.listings.set(credentialId, row);
    this.changes.push(change);
    return { listing, changeSequence: change.sequence, created };
  }

  async deleteListing(credentialId, expectedRevision, options = {}) {
    this.assertCredential(credentialId);
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    const current = this.listings.get(credentialId);
    if (!current || current.status !== 'active') throw new DirectoryError(404, 'listing_not_found', 'This server has no active listing.');
    this.assertCooldown(current, now, cooldownMs);
    if (current.revision !== expectedRevision) conflict(current);
    const updated = { ...current, revision: current.revision + 1, status: 'deleted', updatedAt: now.toISOString(), lastMutationAt: now.toISOString() };
    const change = { sequence: this.nextSequence++, operation: 'delete', listingId: current.listingId };
    if (options.failBeforeCommit) throw new Error('Injected transaction failure');
    this.listings.set(credentialId, updated);
    this.changes.push(change);
    return { listingId: updated.listingId, listingNumber: updated.listingNumber, revision: updated.revision, changeSequence: change.sequence };
  }

  async getSnapshot() {
    const listings = [...this.listings.values()].filter((row) => row.status === 'active').map(toPublicListing);
    listings.sort((a, b) => a.listingId.localeCompare(b.listingId));
    return { throughSequence: this.nextSequence - 1, listings };
  }

  async getDelta(after, limit) {
    const latest = this.nextSequence - 1;
    if (after > latest) return { resetRequired: true, throughSequence: latest, changes: [], hasMore: false };
    if (latest > after && after < this.retainedAfter) return { resetRequired: true, throughSequence: latest, changes: [], hasMore: false };
    const all = this.changes.filter((change) => change.sequence > after);
    const page = all.slice(0, limit);
    return {
      resetRequired: false,
      throughSequence: page.length ? page[page.length - 1].sequence : after,
      changes: clone(page),
      hasMore: all.length > page.length
    };
  }

  async createCredential(label, tokenHash, credentialId = crypto.randomUUID()) {
    if ([...this.credentials.values()].some((credential) => credential.tokenHash === tokenHash)) throw new Error('Duplicate credential hash');
    const credential = { id: credentialId, label, tokenHash, enabled: true, createdAt: new Date().toISOString(), lastUsedAt: null };
    this.credentials.set(credentialId, credential);
    return clone(credential);
  }

  async disableCredential(credentialId) {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new DirectoryError(404, 'credential_not_found', 'Credential not found.');
    credential.enabled = false;
    const listing = this.listings.get(credentialId);
    if (listing && listing.status === 'active') {
      const now = new Date().toISOString();
      listing.status = 'disabled';
      listing.revision += 1;
      listing.updatedAt = now;
      listing.lastMutationAt = now;
      this.changes.push({ sequence: this.nextSequence++, operation: 'delete', listingId: listing.listingId });
    }
    return clone(credential);
  }

  async rotateCredential(credentialId, tokenHash) {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new DirectoryError(404, 'credential_not_found', 'Credential not found.');
    credential.tokenHash = tokenHash;
    credential.enabled = true;
    credential.lastUsedAt = null;
    return clone(credential);
  }

  pruneThrough(sequence) {
    this.changes = this.changes.filter((change) => change.sequence > sequence);
    this.retainedAfter = Math.max(this.retainedAfter, sequence);
  }
}
