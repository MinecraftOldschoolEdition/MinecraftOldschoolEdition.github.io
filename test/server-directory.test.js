import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createListingHandler, createSyncHandler, createTagsHandler } from '../lib/server-directory/http.js';
import { InMemoryDirectoryStorage } from '../lib/server-directory/memory-storage.js';
import { validateListingInput } from '../lib/server-directory/validation.js';

const ENDPOINT_A = 'play.example.net:25565';
const ENDPOINT_B = 'two.example.net:25565';

function request(method, options = {}) {
  return {
    method,
    headers: options.headers || {},
    query: options.query || {},
    body: options.body
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  };
}

function listingRequest(method, body, query = {}) {
  return request(method, {
    headers: { 'x-forwarded-proto': 'https' },
    body,
    query
  });
}

function listing(overrides = {}) {
  return {
    name: 'Oldschool Survival',
    host: 'play.example.net',
    port: 25565,
    creator: { username: 'Eric', uuid: '550e8400-e29b-41d4-a716-446655440000' },
    description: 'A classic survival server with a small community.',
    tagIds: ['survival', 'vanilla'],
    ...overrides
  };
}

async function setup() {
  const storage = new InMemoryDirectoryStorage();
  return { storage };
}

test('listing handler requires no token and keys state by normalized endpoint', async () => {
  const { storage } = await setup();
  const handler = createListingHandler(storage);
  const created = response();
  await handler(listingRequest('PUT', listing()), created);
  assert.equal(created.statusCode, 201);

  const fetched = response();
  await handler(listingRequest('GET', undefined, { host: 'PLAY.Example.NET', port: '25565' }), fetched);
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.body.listing.listingId, created.body.listing.listingId);
  assert.equal(fetched.headers['Cache-Control'], 'no-store');
});

test('anonymous listing endpoint still rejects plaintext transport', async () => {
  const { storage } = await setup();
  const res = response();
  await createListingHandler(storage)(request('GET', {
    headers: { 'x-forwarded-proto': 'http' },
    query: { host: 'play.example.net', port: '25565' }
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'https_required');
});

test('create and update advance sequences while preserving listing identity and number', async () => {
  const { storage } = await setup();
  const created = await storage.putListing(validateListingInput(listing()), { cooldownMs: 0 });
  const second = await storage.putListing(validateListingInput(listing({ host: 'two.example.net' })), { cooldownMs: 0 });
  assert.equal(created.listing.listingNumber, 1);
  assert.equal(second.listing.listingNumber, 2);
  assert.equal(created.changeSequence, 1);
  assert.equal(second.changeSequence, 2);

  const updated = await storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Updated description.' })), { cooldownMs: 0 });
  assert.equal(updated.created, false);
  assert.equal(updated.listing.listingId, created.listing.listingId);
  assert.equal(updated.listing.listingNumber, created.listing.listingNumber);
  assert.equal(updated.listing.revision, 2);
  assert.equal(updated.changeSequence, 3);
});

test('stale revisions return a useful conflict with current listing state', async () => {
  const { storage } = await setup();
  await storage.putListing(validateListingInput(listing()), { cooldownMs: 0 });
  await storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Second revision.' })), { cooldownMs: 0 });
  await assert.rejects(
    storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Stale write.' })), { cooldownMs: 0 }),
    (error) => error.status === 409 && error.code === 'revision_conflict' && error.listing.revision === 2
  );
});

test('unlisting creates a deletion tombstone and removes the listing from snapshots', async () => {
  const { storage } = await setup();
  const created = await storage.putListing(validateListingInput(listing()), { cooldownMs: 0 });
  const deleted = await storage.deleteListing(ENDPOINT_A, 1, { cooldownMs: 0 });
  assert.equal(deleted.listingId, created.listing.listingId);
  assert.equal(deleted.revision, 2);
  assert.deepEqual((await storage.getSnapshot()).listings, []);
  assert.deepEqual(await storage.getDelta(1, 250), {
    resetRequired: false,
    throughSequence: 2,
    changes: [{ sequence: 2, operation: 'delete', listingId: created.listing.listingId }],
    hasMore: false
  });
});

test('normalized endpoint is the stable anonymous listing identity', async () => {
  const { storage } = await setup();
  await storage.putListing(validateListingInput(listing({ host: 'PLAY.Example.NET' })), { cooldownMs: 0 });
  await assert.rejects(
    storage.putListing(validateListingInput(listing()), { cooldownMs: 0 }),
    (error) => error.status === 409 && error.code === 'revision_conflict'
  );
});

test('listing validation rejects invalid tags, excess tags, metadata, and unsafe literal addresses', () => {
  const invalid = [
    listing({ tagIds: ['unknown'] }),
    listing({ tagIds: ['survival', 'creative', 'vanilla', 'pvp'] }),
    listing({ name: '<b>Bad</b>' }),
    listing({ description: '\u00a7cFormatted' }),
    listing({ host: '127.0.0.1' }),
    listing({ host: '10.1.2.3' }),
    listing({ host: '::1' }),
    listing({ host: 'fc00::1' }),
    listing({ host: 'https://play.example.net/path' })
  ];
  for (const body of invalid) assert.throws(() => validateListingInput(body), (error) => error.status === 400);
  assert.equal(validateListingInput(listing({ host: 'PLAY.Example.NET' })).normalizedEndpoint, 'play.example.net:25565');
  assert.equal(validateListingInput(listing({ host: '2606:4700:4700:0:0:0:0:1111' })).normalizedEndpoint, '[2606:4700:4700::1111]:25565');
});

test('cold snapshots, incremental deltas, pagination, ETags, and 304 work', async () => {
  const { storage } = await setup();
  await storage.putListing(validateListingInput(listing()), { cooldownMs: 0 });
  await storage.putListing(validateListingInput(listing({ host: 'two.example.net' })), { cooldownMs: 0 });
  const handler = createSyncHandler(storage);

  const snapshotRes = response();
  await handler(request('GET', { query: { after: '0' } }), snapshotRes);
  assert.equal(snapshotRes.statusCode, 200);
  assert.equal(snapshotRes.body.mode, 'snapshot');
  assert.equal(snapshotRes.body.listings.length, 2);
  assert.equal(snapshotRes.body.throughSequence, 2);
  assert.match(snapshotRes.headers['Cache-Control'], /s-maxage/);

  const notModified = response();
  await handler(request('GET', { query: { after: '0' }, headers: { 'if-none-match': snapshotRes.headers.ETag } }), notModified);
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.ended, true);

  const pageOne = response();
  await handler(request('GET', { query: { after: '1', limit: '1' } }), pageOne);
  assert.equal(pageOne.body.mode, 'delta');
  assert.equal(pageOne.body.changes.length, 1);
  assert.equal(pageOne.body.throughSequence, 2);
  assert.equal(pageOne.body.hasMore, false);

  await storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Updated.' })), { cooldownMs: 0 });
  await storage.deleteListing(ENDPOINT_B, 1, { cooldownMs: 0 });
  const paged = await storage.getDelta(2, 1);
  assert.equal(paged.changes.length, 1);
  assert.equal(paged.hasMore, true);
  assert.equal((await storage.getDelta(paged.throughSequence, 1)).changes[0].operation, 'delete');
});

test('old cursors receive resetRequired after retained history is pruned', async () => {
  const { storage } = await setup();
  await storage.putListing(validateListingInput(listing()), { cooldownMs: 0 });
  await storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Updated.' })), { cooldownMs: 0 });
  await storage.putListing(validateListingInput(listing({ expectedRevision: 2, description: 'Updated again.' })), { cooldownMs: 0 });
  storage.pruneThrough(2);
  const delta = await storage.getDelta(1, 250);
  assert.equal(delta.resetRequired, true);
  assert.equal(delta.throughSequence, 3);
  assert.equal((await storage.getDelta(999, 250)).resetRequired, true);
});

test('mutation cooldown is enforced per endpoint', async () => {
  const { storage } = await setup();
  const now = new Date('2026-08-20T00:00:00Z');
  await storage.putListing(validateListingInput(listing()), { cooldownMs: 60000, now });
  await assert.rejects(
    storage.putListing(validateListingInput(listing({ expectedRevision: 1, description: 'Too soon.' })), { cooldownMs: 60000, now: new Date(now.getTime() + 1000) }),
    (error) => error.status === 429 && error.code === 'mutation_cooldown'
  );
});

test('listing and change event commit atomically in the test adapter', async () => {
  const { storage } = await setup();
  await assert.rejects(storage.putListing(validateListingInput(listing()), { cooldownMs: 0, failBeforeCommit: true }));
  assert.equal(await storage.getListing(ENDPOINT_A), null);
  assert.equal(storage.changes.length, 0);
});

test('anonymous write handler enforces body limits and returns no-store results', async () => {
  const { storage } = await setup();
  const handler = createListingHandler(storage);
  const tooLarge = response();
  await handler(listingRequest('PUT', listing()), tooLarge);
  assert.equal(tooLarge.statusCode, 201);
  assert.equal(tooLarge.headers['Cache-Control'], 'no-store');

  const oversized = response();
  await handler(request('PUT', {
    headers: { 'x-forwarded-proto': 'https', 'content-length': '9000' },
    body: listing()
  }), oversized);
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.body.error.code, 'payload_too_large');
});

test('tag catalog is versioned, cacheable, and supports 304', async () => {
  const handler = createTagsHandler();
  const first = response();
  await handler(request('GET'), first);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.tagCatalogVersion, 4);
  assert.equal(first.body.tags.length, 17);
  assert.deepEqual(
    Object.fromEntries(first.body.tags.filter((tag) => ['creative', 'survival', 'alpha', 'classic'].includes(tag.id)).map((tag) => [tag.id, tag.color])),
    { survival: '#FF5555', creative: '#5555FF', alpha: '#55FF55', classic: '#FFAA00' }
  );
  assert.deepEqual(
    Object.fromEntries(first.body.tags.filter((tag) => ['default', 'sky', 'flat', 'alpha', 'alpha_snow', 'infdev', 'classic'].includes(tag.id)).map((tag) => [tag.id, tag.label])),
    { default: 'Default', sky: 'Sky', flat: 'Superflat', alpha: 'Alpha', alpha_snow: 'Alpha (Snowy)', infdev: 'Infdev', classic: 'Classic' }
  );
  assert.deepEqual(
    first.body.tags.find((tag) => tag.id === 'beta_1_7_3'),
    {
      id: 'beta_1_7_3',
      label: 'Beta 1.7.3',
      description: 'Vanilla Minecraft Beta 1.7.3 gameplay.',
      color: '#AA5500',
      sortOrder: 110,
      active: true
    }
  );
  const sourceCatalog = JSON.parse(readFileSync(new URL('../server-directory-tags-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(first.body, sourceCatalog);
  assert.deepEqual(validateListingInput(listing({ tagIds: ['creative', 'alpha', 'classic'] })).tagIds,
    ['creative', 'alpha', 'classic']);
  const second = response();
  await handler(request('GET', { headers: { 'if-none-match': first.headers.ETag } }), second);
  assert.equal(second.statusCode, 304);
});

test('fetch-test migration creates one disabled-credential offline listing with a valid public snapshot', () => {
  const migration = readFileSync(new URL('../migrations/002_server_directory_fetch_test_listing.sql', import.meta.url), 'utf8');
  assert.match(migration, /'Vercel Fetch Test'/);
  assert.match(migration, /'directory-test\.minecraftoldschool\.com'/);
  assert.match(migration, /ARRAY\['classic', 'alpha', 'survival'\]/);
  assert.match(migration, /'schemaVersion', 1/);
  assert.match(migration, /'creator', jsonb_build_object\('username'/);
  assert.match(migration, /System-owned directory fetch test'[\s\S]*FALSE/);
});

test('sync route serves the static fetch-test snapshot before a database is configured', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const handler = createSyncHandler();
    const snapshot = response();
    await handler(request('GET', { query: { after: '0' } }), snapshot);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.headers['X-MCOSE-Directory-Mode'], 'bootstrap');
    assert.equal(snapshot.body.mode, 'snapshot');
    assert.equal(snapshot.body.throughSequence, 0);
    assert.equal(snapshot.body.listings[0].name, 'Vercel Fetch Test');
    assert.deepEqual(snapshot.body.listings[0].tagIds, ['classic', 'alpha', 'survival']);

    const reset = response();
    await handler(request('GET', { query: { after: '12' } }), reset);
    assert.equal(reset.body.resetRequired, true);
    assert.equal(reset.body.throughSequence, 0);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
