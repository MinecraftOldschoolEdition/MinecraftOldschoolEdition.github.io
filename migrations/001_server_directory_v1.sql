BEGIN;

CREATE TABLE IF NOT EXISTS server_directory_credentials (
    credential_id UUID PRIMARY KEY,
    token_sha256 CHAR(64) NOT NULL UNIQUE,
    label VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS server_directory_listings (
    listing_id UUID PRIMARY KEY,
    listing_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
    credential_id UUID NOT NULL UNIQUE REFERENCES server_directory_credentials(credential_id),
    normalized_host VARCHAR(253) NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    normalized_endpoint VARCHAR(320) NOT NULL,
    name VARCHAR(64) NOT NULL,
    creator_username VARCHAR(32) NOT NULL,
    creator_uuid UUID NULL,
    description VARCHAR(200) NOT NULL,
    tag_ids TEXT[] NOT NULL CHECK (cardinality(tag_ids) BETWEEN 1 AND 3),
    revision INTEGER NOT NULL CHECK (revision > 0),
    status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_mutation_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS server_directory_active_endpoint_uq
    ON server_directory_listings (normalized_endpoint)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS server_directory_active_listing_idx
    ON server_directory_listings (listing_id)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS server_directory_changes (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation VARCHAR(16) NOT NULL CHECK (operation IN ('upsert', 'delete')),
    listing_id UUID NOT NULL,
    listing_snapshot JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((operation = 'upsert' AND listing_snapshot IS NOT NULL)
        OR (operation = 'delete' AND listing_snapshot IS NULL))
);

CREATE INDEX IF NOT EXISTS server_directory_changes_created_idx
    ON server_directory_changes (created_at);

CREATE TABLE IF NOT EXISTS server_directory_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    latest_sequence BIGINT NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
    minimum_retained_sequence BIGINT NOT NULL DEFAULT 1 CHECK (minimum_retained_sequence >= 1)
);

INSERT INTO server_directory_state (singleton, latest_sequence, minimum_retained_sequence)
SELECT TRUE,
       COALESCE(MAX(sequence), 0),
       COALESCE(MIN(sequence), COALESCE(MAX(sequence), 0) + 1)
  FROM server_directory_changes
ON CONFLICT (singleton) DO NOTHING;

COMMIT;
