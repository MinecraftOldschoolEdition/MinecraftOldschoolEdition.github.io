BEGIN;

CREATE TABLE IF NOT EXISTS server_directory_migrations (
    migration_id VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM server_directory_migrations
         WHERE migration_id = '002_server_directory_fetch_test_listing'
    ) THEN
        INSERT INTO server_directory_credentials (
            credential_id, token_sha256, label, enabled
        ) VALUES (
            '00000000-0000-4000-8000-000000000001',
            '0000000000000000000000000000000000000000000000000000000000000000',
            'System-owned directory fetch test',
            FALSE
        ) ON CONFLICT (credential_id) DO NOTHING;

        INSERT INTO server_directory_listings (
            listing_id, credential_id, normalized_host, port, normalized_endpoint,
            name, creator_username, creator_uuid, description, tag_ids,
            revision, status, created_at, updated_at, last_mutation_at
        ) VALUES (
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000001',
            'directory-test.minecraftoldschool.com',
            25565,
            'directory-test.minecraftoldschool.com:25565',
            'Vercel Fetch Test',
            'MCOSE',
            NULL,
            'Fetched from the Vercel API; intentionally offline for browser testing.',
            ARRAY['classic', 'alpha', 'survival'],
            1,
            'active',
            NOW(),
            NOW(),
            NOW()
        ) ON CONFLICT (listing_id) DO NOTHING;

        INSERT INTO server_directory_changes (operation, listing_id, listing_snapshot)
        SELECT 'upsert', listing.listing_id, jsonb_build_object(
            'schemaVersion', 1,
            'listingId', listing.listing_id::text,
            'listingNumber', listing.listing_number,
            'revision', listing.revision,
            'name', listing.name,
            'host', listing.normalized_host,
            'port', listing.port,
            'creator', jsonb_build_object('username', listing.creator_username),
            'description', listing.description,
            'tagIds', to_jsonb(listing.tag_ids),
            'createdAt', to_char(listing.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'updatedAt', to_char(listing.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
          FROM server_directory_listings AS listing
         WHERE listing.listing_id = '00000000-0000-4000-8000-000000000002';

        UPDATE server_directory_state
           SET latest_sequence = (SELECT COALESCE(MAX(sequence), 0) FROM server_directory_changes)
         WHERE singleton = TRUE;

        INSERT INTO server_directory_migrations (migration_id)
        VALUES ('002_server_directory_fetch_test_listing');
    END IF;
END $$;

COMMIT;
