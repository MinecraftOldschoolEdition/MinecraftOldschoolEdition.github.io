# MCOSE Server Directory Protocol v1

This document is the shared contract for the Minecraft Oldschool Edition client, UberBukkit MCOSE, and minecraftoldschool.com. The three repositories must keep this file byte-for-byte synchronized when the protocol changes.

## Ownership and security boundary

The client reads the public directory, caches and searches metadata locally, resolves and pings endpoints, renders fetched entries with online/offline state, and sends listing-management requests to its connected server. It never receives a website bearer token, and Join is enabled only for a successful current or fresh cached ping.

UberBukkit owns the configured public endpoint and bearer token, captures the connected player's username and UUID, rechecks the native Bukkit permission on every mutation, validates bounded payloads, and performs authenticated HTTPS requests on its bounded worker pool. Results are scheduled back to the server thread.

The website is the final authority for credentials, normalization, validation, optimistic concurrency, cooldowns, durable listings, and the change log. It never pings submitted endpoints. Online state is deliberately absent from public metadata.

## Versions and identifiers

- Public JSON schema: 1
- Tag catalog schema: 1
- Tag catalog version: 2
- Server-directory custom payload version: 1
- MCOSE feature bit: `FEATURE_SERVER_DIRECTORY = 1 << 15`
- Permission: `mcose.serverbrowser.advertise`, default `PermissionDefault.OP`

A `listingId` is an immutable UUID. A `listingNumber` is a positive generated identity assigned only on first creation and never reused. A `revision` changes on edits and is used for optimistic concurrency. A `changeSequence` is a positive generated identity for every create, update, disable, or delete event. Sequence gaps are valid; clients request `sequence > lastAppliedSequence`.

## Public HTTP API

All successful and error bodies use `Content-Type: application/json; charset=utf-8`. Public GET endpoints allow gzip, return ETags, honor `If-None-Match`, and may return 304. Tags use a long public CDN lifetime; sync responses use a short public CDN lifetime with stale-while-revalidate. Authenticated endpoints always use `Cache-Control: no-store`.

### GET /api/servers/tags

Response:

```json
{
  "schemaVersion": 1,
  "tagCatalogVersion": 2,
  "tags": [
    {
      "id": "survival",
      "label": "Survival",
      "description": "Classic survival gameplay and progression.",
      "color": "#FF5555",
      "sortOrder": 10,
      "active": true
    }
  ]
}
```

The canonical catalog lives in the standalone root file `server-directory-tags-v1.json`. The Vercel `/api/servers/tags` function loads and validates that file, then returns it with ETag/CDN caching. Clients fetch labels, descriptions, colors, ordering, and active state instead of compiling them into the client.

Catalog v2 IDs are `survival`, `creative`, `alpha`, `classic`, `vanilla`, `economy`, `pvp`, `roleplay`, `minigames`, `anarchy`, and `custom`. Colors are six-digit RGB strings. The requested core colors are Creative `#5555FF`, Survival `#FF5555`, Alpha `#55FF55`, and Classic `#FFAA00`.

### GET /api/servers/sync?after=<sequence>&limit=<limit>

`after` is a non-negative integer. `limit` defaults to 250 and is capped at 250.

A cold request with `after=0` returns one current snapshot:

```json
{
  "schemaVersion": 1,
  "mode": "snapshot",
  "fromSequence": 0,
  "throughSequence": 1842,
  "hasMore": false,
  "resetRequired": false,
  "listings": []
}
```

A request with `after>0` returns ascending changes strictly newer than that cursor:

```json
{
  "schemaVersion": 1,
  "mode": "delta",
  "fromSequence": 1840,
  "throughSequence": 1842,
  "hasMore": false,
  "resetRequired": false,
  "changes": [
    { "sequence": 1841, "operation": "upsert", "listing": {} },
    { "sequence": 1842, "operation": "delete", "listingId": "550e8400-e29b-41d4-a716-446655440000" }
  ]
}
```

Every upsert contains a complete public listing. If `hasMore` is true, request the next page with the returned `throughSequence`. If `resetRequired` is true, discard only the cached listing set and cursor, preserve the tag catalog, and request `after=0`.

The public listing schema is:

```json
{
  "schemaVersion": 1,
  "listingId": "550e8400-e29b-41d4-a716-446655440000",
  "listingNumber": 42,
  "revision": 3,
  "name": "Oldschool Survival",
  "host": "play.example.net",
  "port": 25565,
  "creator": { "username": "Eric" },
  "description": "A classic survival server with a small community.",
  "tagIds": ["survival", "vanilla"],
  "createdAt": "2026-08-19T18:00:00Z",
  "updatedAt": "2026-08-19T18:20:00Z"
}
```

There is no authoritative `online` property. Creator UUID is stored internally when supplied but is not public.

### Authenticated /api/servers/listing

Send `Authorization: Bearer <per-server-token>` over HTTPS. The credential owns exactly one stable listing identity.

This is a Vercel Serverless Function/API route, as are the public tag and sync routes. Submission requires no separately hosted application server or long-running backend process; Postgres is only the durable data store used by the serverless functions.

- `GET` returns `{"schemaVersion":1,"listing":null}` or the current listing.
- `PUT` creates or updates. A create sends `expectedRevision: null`; an update sends the current positive revision.
- `DELETE` sends `{"expectedRevision":3}` and emits a deletion change.
- A stale revision returns HTTP 409 with error details and the current public listing when active.
- A mutation inside the configured per-credential cooldown returns HTTP 429.
- All mutations and their change records commit in the same Postgres transaction.

PUT body:

```json
{
  "expectedRevision": 3,
  "name": "Oldschool Survival",
  "host": "play.example.net",
  "port": 25565,
  "creator": {
    "username": "Eric",
    "uuid": "550e8400-e29b-41d4-a716-446655440000"
  },
  "description": "A classic survival server.",
  "tagIds": ["survival", "vanilla"]
}
```

Stable errors have `{"schemaVersion":1,"error":{"code":"...","message":"...","details":{}}}`. Relevant status codes are 400 validation/HTTPS, 401 invalid or disabled credential, 404 missing listing, 409 revision or endpoint conflict, 413 oversized body, 429 cooldown, and 500 internal failure.

## Custom payload protocol

All integers are big-endian Java `DataInputStream`/`DataOutputStream` values. Strings use bounded Java modified UTF-8. Every payload begins with a one-byte directory protocol version, currently 1. Trailing bytes, invalid counts, invalid operations, and oversized data are rejected.

Channels:

- `MCOSE|SDIR_REQ`: client capability/state request. Payload is only the version byte.
- `MCOSE|SDIR_STATE`: server state response.
- `MCOSE|SDIR_MUT`: client create/update/delete request.
- `MCOSE|SDIR_RESULT`: server result.

STATE fields after version:

1. booleans: supported, permitted, configured-ready, loading
2. public endpoint UTF, maximum 320 characters
3. creator username UTF, maximum 32 characters
4. message UTF, maximum 300 characters
5. listing-present boolean
6. if present: listing ID UTF, listing number long, revision int, name UTF, description UTF, tag count byte, tag ID UTF values

MUT fields after version:

1. operation byte: 1 upsert, 2 delete
2. expected revision int; zero means create, positive means update/delete
3. for upsert: name UTF, description UTF, tag count byte, tag ID UTF values

Mutation payloads are capped at 1024 bytes. Names are at most 64 characters, descriptions 200, tag IDs 32, and tag counts 1 to 3.

RESULT fields after version are a result-code byte and a message UTF capped at 300 characters. Codes are 0 success, 1 validation/rate limit, 2 conflict, 3 authorization, 4 server configuration, and 5 website/unavailable.

The feature is used only after the existing MCOSE hello negotiation confirms bit 15. GUI visibility is never authorization. UberBukkit rechecks `mcose.serverbrowser.advertise` for every mutation and never serializes its bearer token.

## Validation and endpoint safety

Names contain 1 to 64 visible characters; descriptions contain 1 to 200. Whitespace is normalized. Control characters, Minecraft formatting codes, and angle-bracket markup are rejected. A listing has one to three distinct active tags.

Hosts are lowercase ASCII/punycode hostnames or valid IP literals. Ports are 1 through 65535 and default to 25565 when omitted from server configuration. Schemes, paths, userinfo, query strings, fragments, local-only suffixes, and non-global-unicast literals are rejected.

Before every directory ping and directory-originated join, the client resolves the hostname on a worker thread, checks the exact selected address is global unicast, and connects using that checked socket address. Loopback, private, link-local, multicast, unspecified, documentation, and other reserved IPv4/IPv6 destinations are rejected. The website stores metadata but does not resolve or ping it.

## Client cache and online model

The cache is `server-directory-cache-v1.json` in the client data directory, with a `.bak` last-known-good file. It contains schema version, last applied sequence, sync ETag/time, listings keyed by UUID, tag catalog/version/ETag/time, and successful short-lived ping results.

The client:

1. loads and validates the main file, then tries the backup;
2. fetches tags when the local catalog is older than catalog v2 or older than 24 hours;
3. avoids automatic listing sync for five minutes after success;
4. requests changes after the applied cursor and follows pagination;
5. rejects out-of-order events, ignores duplicate/already-applied sequences, and accepts valid sequence gaps;
6. applies a complete page before advancing its cursor;
7. saves by temporary file, flush, backup, and atomic replacement;
8. handles 304 without rewriting the cache;
9. resets to a snapshot when history retention requires it;
10. uses exponential failure backoff up to 30 minutes and keeps stale cached metadata available.

Opening the browser starts one bounded batch of at most eight concurrent pings with three-second connect/read timeouts. Fresh successful results live for 105 seconds and are prioritized. Every fetched listing enters the visible model: pending probes show `Checking...`, failed probes show `Offline`, and successful probes show latency/player status and permit Join. Closing the GUI cancels pending work. Search and tag filtering are local and stable alphabetical ordering does not use listing number as rank.

The refresh control uses `/assets/minecraft/textures/gui/menu/server/refresh.png`, matching the main multiplayer menu. An unsaved row uses `/assets/minecraft/textures/gui/menu/server/add_server.png`; after the normalized endpoint is present in `servers.dat`, it changes to `/assets/minecraft/textures/gui/menu/server/checkmark.png`. Text glyphs remain failure-safe fallbacks. Saved servers are deduplicated by normalized host and port.

## Deployment and configuration

The website requires:

- `DATABASE_URL`: production Postgres connection URL
- `SERVER_DIRECTORY_DB_POOL_SIZE`: optional, clamped to 1 through 5; default 1
- `SERVER_DIRECTORY_DB_SSL=disable`: optional local-only escape hatch; production defaults to required TLS
- `SERVER_DIRECTORY_MUTATION_COOLDOWN_SECONDS`: optional 0 through 3600; default 60

Install and migrate:

```text
npm install
DATABASE_URL='postgresql://...' npm run server-directory:migrate
DATABASE_URL='postgresql://...' npm run server-directory:credential -- create "Human-readable server label"
```

The migration command applies every numbered SQL file in order. Migration `002_server_directory_fetch_test_listing.sql` adds an idempotent, system-owned `Vercel Fetch Test` entry at `directory-test.minecraftoldschool.com:25565`. Its credential is permanently disabled and has no usable token. The entry is intentionally expected to show as Offline, proving that the browser fetched and rendered directory metadata before a real public server is configured.

The create command prints a random 256-bit base64url token once and stores only its SHA-256 hash. Disable and rotate with:

```text
DATABASE_URL='postgresql://...' npm run server-directory:credential -- disable <credential-id>
DATABASE_URL='postgresql://...' npm run server-directory:credential -- rotate <credential-id>
```

Prune old change history periodically; clients older than retained history receive `resetRequired`:

```text
DATABASE_URL='postgresql://...' npm run server-directory:prune -- 30
```

UberBukkit writes these defaults to `uberbukkit.yml`:

```yaml
server-browser:
  enabled: false
  api-base-url: "https://minecraftoldschool.com"
  public-address: ""
  token: ""
```

Set `enabled: true`, set the explicitly advertised public hostname and optional port, and place the provisioned token in `token` or preferably in `MCOSE_SERVER_BROWSER_TOKEN`. The environment variable overrides the file. Do not infer the public address from a socket or LAN interface.

The client public API base defaults to `https://minecraftoldschool.com`. `-Dmcose.serverDirectoryApiBase=...` can override it. Plain HTTP is accepted only for localhost tests when `-Dmcose.serverDirectoryAllowInsecureLocal=true`.

## Builds and manual acceptance

Website:

```text
npm test
```

Client:

```text
cd minecraft
./gradlew test
./gradlew build
```

UberBukkit:

```text
./gradlew test
./gradlew shadowJar
```

Manual end-to-end acceptance requires a migrated Postgres database and reachable public test server:

1. run all migrations and confirm `Vercel Fetch Test` appears as Offline, proving metadata was fetched even without a reachable Minecraft endpoint;
2. provision a credential and configure UberBukkit's token and explicit public address;
3. join with a compatible operator and confirm Advertise Server is enabled;
4. join as an unauthorized player and confirm the entry is absent or denied;
5. publish a name, description, and one to three fetched, color-coded tags;
6. open Server Browser on another client and verify snapshot cache creation;
7. verify the real row becomes online after ping success, joins directly, and the add-server icon writes one deduplicated `servers.dat` entry;
8. verify the icon changes to the saved checkmark and pressing it again cannot add a duplicate;
9. update description/tags and verify only a delta downloads, listing number remains stable, revision changes, and sequence advances;
10. unlist and verify the deletion delta removes the cache entry;
11. stop the real server and verify it remains visible as Offline after refresh/TTL expiry and cannot be joined;
12. make the website unavailable and verify cached metadata is labeled stale and still pings without crashing.

## Upgrade behavior

Unknown JSON schema or tag versions are not merged. An unsupported local cache schema resets the local cache; an unsupported HTTP schema fails closed while retaining the last valid cache. The custom-payload version is rejected when unknown. Future changes that cannot be represented compatibly must increment the relevant schema/protocol version and update this document in all three repositories.
