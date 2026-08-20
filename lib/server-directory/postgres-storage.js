import crypto from 'node:crypto';
import postgres from 'postgres';
import { DirectoryError } from './errors.js';
import { toPublicListing } from './model.js';

function sha256(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function cooldownError(remainingMs) {
  return new DirectoryError(429, 'mutation_cooldown', 'This server listing was changed too recently.', {
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000))
  });
}

function revisionConflict(row) {
  return new DirectoryError(409, 'revision_conflict', 'The listing changed since it was loaded.', {
    currentRevision: Number(row.revision)
  }, row.status === 'active' ? toPublicListing(row) : null);
}

export class PostgresDirectoryStorage {
  constructor(databaseUrl, options = {}) {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for production server-directory storage.');
    const configuredPoolSize = Number(process.env.SERVER_DIRECTORY_DB_POOL_SIZE || 1);
    this.sql = options.sql || postgres(databaseUrl, {
      max: Number.isInteger(configuredPoolSize) ? Math.max(1, Math.min(5, configuredPoolSize)) : 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: process.env.SERVER_DIRECTORY_DB_SSL === 'disable' ? false : 'require'
    });
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async authenticate(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const tokenHash = sha256(token);
    const rows = await this.sql`
      WITH matched AS MATERIALIZED (
        SELECT credential_id, label
          FROM server_directory_credentials
         WHERE token_sha256 = ${tokenHash}
           AND enabled = TRUE
         LIMIT 1
      ), touched AS (
        UPDATE server_directory_credentials AS credential
           SET last_used_at = NOW()
          FROM matched
         WHERE credential.credential_id = matched.credential_id
           AND (credential.last_used_at IS NULL OR credential.last_used_at < NOW() - INTERVAL '1 hour')
        RETURNING credential.credential_id
      )
      SELECT credential_id, label FROM matched
    `;
    return rows.length === 1 ? { id: rows[0].credential_id, label: rows[0].label } : null;
  }

  async getListing(credentialId) {
    const rows = await this.sql`
      SELECT *
        FROM server_directory_listings
       WHERE credential_id = ${credentialId}
         AND status = 'active'
       LIMIT 1
    `;
    return rows.length === 1 ? toPublicListing(rows[0]) : null;
  }

  async putListing(credentialId, input, options = {}) {
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    try {
      return await this.sql.begin(async (tx) => {
        const credentials = await tx`
          SELECT credential_id
            FROM server_directory_credentials
           WHERE credential_id = ${credentialId}
             AND enabled = TRUE
           FOR UPDATE
        `;
        if (credentials.length !== 1) throw new DirectoryError(401, 'unauthorized', 'Invalid or disabled server credential.');

        const existingRows = await tx`
          SELECT * FROM server_directory_listings
           WHERE credential_id = ${credentialId}
           FOR UPDATE
        `;
        const existing = existingRows[0] || null;
        if (existing && existing.status === 'active' && input.expectedRevision !== Number(existing.revision)) throw revisionConflict(existing);
        if (!existing && input.expectedRevision !== null) {
          throw new DirectoryError(409, 'revision_conflict', 'No listing exists for the supplied revision.', { currentRevision: null }, null);
        }
        if (existing && existing.status !== 'active' && input.expectedRevision !== null) throw revisionConflict(existing);
        if (existing && now.getTime() - new Date(existing.last_mutation_at).getTime() < cooldownMs) {
          throw cooldownError(cooldownMs - (now.getTime() - new Date(existing.last_mutation_at).getTime()));
        }

        let row;
        if (!existing) {
          const listingId = crypto.randomUUID();
          [row] = await tx`
            INSERT INTO server_directory_listings (
              listing_id, credential_id, normalized_host, port, normalized_endpoint,
              name, creator_username, creator_uuid, description, tag_ids,
              revision, status, created_at, updated_at, last_mutation_at
            ) VALUES (
              ${listingId}, ${credentialId}, ${input.host}, ${input.port}, ${input.normalizedEndpoint},
              ${input.name}, ${input.creatorUsername}, ${input.creatorUuid}, ${input.description}, ${tx.array(input.tagIds)},
              1, 'active', ${now}, ${now}, ${now}
            )
            RETURNING *
          `;
        } else {
          [row] = await tx`
            UPDATE server_directory_listings
               SET normalized_host = ${input.host},
                   port = ${input.port},
                   normalized_endpoint = ${input.normalizedEndpoint},
                   name = ${input.name},
                   creator_username = ${input.creatorUsername},
                   creator_uuid = ${input.creatorUuid},
                   description = ${input.description},
                   tag_ids = ${tx.array(input.tagIds)},
                   revision = revision + 1,
                   status = 'active',
                   updated_at = ${now},
                   last_mutation_at = ${now}
             WHERE listing_id = ${existing.listing_id}
            RETURNING *
          `;
        }
        const listing = toPublicListing(row);
        await tx`SELECT singleton FROM server_directory_state WHERE singleton = TRUE FOR UPDATE`;
        const [change] = await tx`
          INSERT INTO server_directory_changes (operation, listing_id, listing_snapshot, created_at)
          VALUES ('upsert', ${row.listing_id}, ${JSON.stringify(listing)}::jsonb, ${now})
          RETURNING sequence
        `;
        await tx`UPDATE server_directory_state SET latest_sequence = ${change.sequence} WHERE singleton = TRUE`;
        return { listing, changeSequence: Number(change.sequence), created: !existing };
      });
    } catch (error) {
      if (error?.code === '23505' && String(error.constraint_name || error.constraint || '').includes('endpoint')) {
        throw new DirectoryError(409, 'duplicate_endpoint', 'An active listing already uses this host and port.');
      }
      throw error;
    }
  }

  async deleteListing(credentialId, expectedRevision, options = {}) {
    const cooldownMs = options.cooldownMs ?? 60000;
    const now = options.now || new Date();
    return this.sql.begin(async (tx) => {
      const credentials = await tx`
        SELECT credential_id FROM server_directory_credentials
         WHERE credential_id = ${credentialId} AND enabled = TRUE
         FOR UPDATE
      `;
      if (credentials.length !== 1) throw new DirectoryError(401, 'unauthorized', 'Invalid or disabled server credential.');
      const rows = await tx`
        SELECT * FROM server_directory_listings
         WHERE credential_id = ${credentialId}
         FOR UPDATE
      `;
      if (rows.length !== 1 || rows[0].status !== 'active') throw new DirectoryError(404, 'listing_not_found', 'This server has no active listing.');
      const current = rows[0];
      if (Number(current.revision) !== expectedRevision) throw revisionConflict(current);
      const elapsed = now.getTime() - new Date(current.last_mutation_at).getTime();
      if (elapsed < cooldownMs) throw cooldownError(cooldownMs - elapsed);
      const [deleted] = await tx`
        UPDATE server_directory_listings
           SET status = 'deleted', revision = revision + 1,
               updated_at = ${now}, last_mutation_at = ${now}
         WHERE listing_id = ${current.listing_id}
        RETURNING listing_id, listing_number, revision
      `;
      await tx`SELECT singleton FROM server_directory_state WHERE singleton = TRUE FOR UPDATE`;
      const [change] = await tx`
        INSERT INTO server_directory_changes (operation, listing_id, listing_snapshot, created_at)
        VALUES ('delete', ${current.listing_id}, NULL, ${now})
        RETURNING sequence
      `;
      await tx`UPDATE server_directory_state SET latest_sequence = ${change.sequence} WHERE singleton = TRUE`;
      return {
        listingId: deleted.listing_id,
        listingNumber: Number(deleted.listing_number),
        revision: Number(deleted.revision),
        changeSequence: Number(change.sequence)
      };
    });
  }

  async getSnapshot() {
    return this.sql.begin('read only', async (tx) => {
      const [{ latest_sequence: latest }] = await tx`SELECT latest_sequence FROM server_directory_state WHERE singleton = TRUE`;
      const rows = await tx`
        SELECT * FROM server_directory_listings
         WHERE status = 'active'
         ORDER BY listing_id ASC
      `;
      return { throughSequence: Number(latest), listings: rows.map(toPublicListing) };
    });
  }

  async getDelta(after, limit) {
    return this.sql.begin('read only', async (tx) => {
      const [bounds] = await tx`
        SELECT minimum_retained_sequence AS minimum, latest_sequence AS latest
          FROM server_directory_state
         WHERE singleton = TRUE
      `;
      const minimum = Number(bounds.minimum);
      const latest = Number(bounds.latest);
      if (after > latest) return { resetRequired: true, throughSequence: latest, changes: [], hasMore: false };
      if (latest > after && after < minimum - 1) {
        return { resetRequired: true, throughSequence: latest, changes: [], hasMore: false };
      }
      const rows = await tx`
        SELECT sequence, operation, listing_id, listing_snapshot
          FROM server_directory_changes
         WHERE sequence > ${after}
         ORDER BY sequence ASC
         LIMIT ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const changes = page.map((row) => row.operation === 'upsert'
        ? { sequence: Number(row.sequence), operation: 'upsert', listing: row.listing_snapshot }
        : { sequence: Number(row.sequence), operation: 'delete', listingId: row.listing_id });
      return {
        resetRequired: false,
        throughSequence: changes.length ? changes[changes.length - 1].sequence : after,
        changes,
        hasMore
      };
    });
  }

  async createCredential(label, tokenHash, credentialId = crypto.randomUUID()) {
    const rows = await this.sql`
      INSERT INTO server_directory_credentials (credential_id, token_sha256, label, enabled)
      VALUES (${credentialId}, ${tokenHash}, ${label}, TRUE)
      RETURNING credential_id, label, enabled, created_at
    `;
    return rows[0];
  }

  async disableCredential(credentialId) {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE server_directory_credentials SET enabled = FALSE
         WHERE credential_id = ${credentialId}
        RETURNING credential_id, label, enabled
      `;
      if (!rows.length) throw new DirectoryError(404, 'credential_not_found', 'Credential not found.');
      const listings = await tx`
        UPDATE server_directory_listings
           SET status = 'disabled', revision = revision + 1,
               updated_at = NOW(), last_mutation_at = NOW()
         WHERE credential_id = ${credentialId} AND status = 'active'
        RETURNING listing_id
      `;
      if (listings.length) {
        await tx`SELECT singleton FROM server_directory_state WHERE singleton = TRUE FOR UPDATE`;
        const [change] = await tx`
          INSERT INTO server_directory_changes (operation, listing_id, listing_snapshot)
          VALUES ('delete', ${listings[0].listing_id}, NULL)
          RETURNING sequence
        `;
        await tx`UPDATE server_directory_state SET latest_sequence = ${change.sequence} WHERE singleton = TRUE`;
      }
      return rows[0];
    });
  }

  async rotateCredential(credentialId, tokenHash) {
    const rows = await this.sql`
      UPDATE server_directory_credentials
         SET token_sha256 = ${tokenHash}, enabled = TRUE, last_used_at = NULL
       WHERE credential_id = ${credentialId}
      RETURNING credential_id, label, enabled
    `;
    if (!rows.length) throw new DirectoryError(404, 'credential_not_found', 'Credential not found.');
    return rows[0];
  }

  async pruneChangesBefore(cutoff) {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new Error('A valid retention cutoff is required.');
    return this.sql.begin(async (tx) => {
      const [state] = await tx`SELECT latest_sequence FROM server_directory_state WHERE singleton = TRUE FOR UPDATE`;
      const candidates = await tx`
        SELECT COALESCE(MAX(sequence), 0) AS through
          FROM server_directory_changes
         WHERE created_at < ${cutoff}
      `;
      const through = Number(candidates[0].through);
      if (through > 0) await tx`DELETE FROM server_directory_changes WHERE sequence <= ${through}`;
      const retained = await tx`SELECT COALESCE(MIN(sequence), ${Number(state.latest_sequence) + 1}) AS minimum FROM server_directory_changes`;
      await tx`
        UPDATE server_directory_state
           SET minimum_retained_sequence = ${Number(retained[0].minimum)}
         WHERE singleton = TRUE
      `;
      return { deletedThroughSequence: through, minimumRetainedSequence: Number(retained[0].minimum) };
    });
  }
}

export { sha256 as hashCredentialToken };
