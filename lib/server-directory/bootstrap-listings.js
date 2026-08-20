import { readFileSync } from 'node:fs';
import { validateListingInput } from './validation.js';

const sourceUrl = new URL('../../server-directory-bootstrap-listings-v1.json', import.meta.url);
const source = JSON.parse(readFileSync(sourceUrl, 'utf8'));

if (source.schemaVersion !== 1 || !Array.isArray(source.listings) || source.listings.length !== 1) {
  throw new Error('Invalid server-directory bootstrap listing catalog.');
}

const listing = source.listings[0];
const normalized = validateListingInput({
  expectedRevision: null,
  name: listing.name,
  host: listing.host,
  port: listing.port,
  creator: listing.creator,
  description: listing.description,
  tagIds: listing.tagIds
});
if (listing.schemaVersion !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(listing.listingId)
    || !Number.isSafeInteger(listing.listingNumber) || listing.listingNumber < 1
    || !Number.isSafeInteger(listing.revision) || listing.revision < 1
    || normalized.host !== listing.host || normalized.port !== listing.port
    || !Number.isFinite(Date.parse(listing.createdAt)) || !Number.isFinite(Date.parse(listing.updatedAt))) {
  throw new Error('Invalid server-directory bootstrap listing entry.');
}

const bootstrapListings = Object.freeze([Object.freeze({
  ...listing,
  creator: Object.freeze({ ...listing.creator }),
  tagIds: Object.freeze([...listing.tagIds])
})]);

export function createBootstrapSnapshot() {
  return {
    schemaVersion: 1,
    mode: 'snapshot',
    fromSequence: 0,
    throughSequence: 0,
    hasMore: false,
    resetRequired: false,
    listings: bootstrapListings
  };
}

export function createBootstrapReset(after) {
  return {
    schemaVersion: 1,
    mode: 'delta',
    fromSequence: after,
    throughSequence: 0,
    hasMore: false,
    resetRequired: true,
    changes: []
  };
}
