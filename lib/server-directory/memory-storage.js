import crypto from 'node:crypto';
import { DirectoryError } from './errors.js';
import { clone, toPublicListing } from './model.js';

function conflict(listing) {
  throw new DirectoryError(409, 'revision_conflict', 'The listing changed since it was loaded.', {
    currentRevision: listing ? listing.revision : null
  }, listing && listing.status === 'active' ? toPublicListing(listing) : null);
}

export class InMemoryDirectoryStorage {
  constructor() {
    this.listings = new Map();
    this.changes = [];
    this.nextListingNumber = 1;
    this.nextSequence = 1;
    this.retainedAfter = 0;
  }

  async close() {}

  async getListing(normalizedEndpoint) {
    const row = this.listings.get(normalizedEndpoint);
    return row && row.status === 'active' ? toPublicListing(row) : null;
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

  async putListing(input, options = {}) {
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    const existing = this.listings.get(input.normalizedEndpoint) || null;
    this.assertCooldown(existing, now, cooldownMs);
    if (existing && existing.status === 'active' && input.expectedRevision !== existing.revision) conflict(existing);
    if (!existing && input.expectedRevision !== null) conflict(null);
    if (existing && existing.status !== 'active' && input.expectedRevision !== null) conflict(existing);

    const created = !existing;
    const row = {
      listingId: existing?.listingId || crypto.randomUUID(),
      listingNumber: existing?.listingNumber || this.nextListingNumber++,
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
    this.listings.set(input.normalizedEndpoint, row);
    this.changes.push(change);
    return { listing, changeSequence: change.sequence, created };
  }

  async deleteListing(normalizedEndpoint, expectedRevision, options = {}) {
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    const current = this.listings.get(normalizedEndpoint);
    if (!current || current.status !== 'active') throw new DirectoryError(404, 'listing_not_found', 'This server has no active listing.');
    this.assertCooldown(current, now, cooldownMs);
    if (current.revision !== expectedRevision) conflict(current);
    const updated = { ...current, revision: current.revision + 1, status: 'deleted', updatedAt: now.toISOString(), lastMutationAt: now.toISOString() };
    const change = { sequence: this.nextSequence++, operation: 'delete', listingId: current.listingId };
    if (options.failBeforeCommit) throw new Error('Injected transaction failure');
    this.listings.set(normalizedEndpoint, updated);
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

  pruneThrough(sequence) {
    this.changes = this.changes.filter((change) => change.sequence > sequence);
    this.retainedAfter = Math.max(this.retainedAfter, sequence);
  }
}
