export function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function toPublicListing(row) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    listingId: row.listingId ?? row.listing_id,
    listingNumber: Number(row.listingNumber ?? row.listing_number),
    revision: Number(row.revision),
    name: row.name,
    host: row.host ?? row.normalized_host,
    port: Number(row.port),
    creator: {
      username: row.creatorUsername ?? row.creator_username
    },
    description: row.description,
    tagIds: [...(row.tagIds ?? row.tag_ids)],
    createdAt: toIso(row.createdAt ?? row.created_at),
    updatedAt: toIso(row.updatedAt ?? row.updated_at)
  };
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
