import { readFileSync } from 'node:fs';

const TAG_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TAG_COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const catalogUrl = new URL('../../server-directory-tags-v1.json', import.meta.url);
const catalog = JSON.parse(readFileSync(catalogUrl, 'utf8'));

if (catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.tagCatalogVersion) || catalog.tagCatalogVersion < 1) {
  throw new Error('Invalid server-directory tag catalog version.');
}
if (!Array.isArray(catalog.tags) || catalog.tags.length < 1 || catalog.tags.length > 64) {
  throw new Error('Server-directory tag catalog must contain 1 through 64 tags.');
}

const seenIds = new Set();
const validatedTags = catalog.tags.map((tag) => {
  if (!tag || typeof tag !== 'object'
      || !TAG_ID_PATTERN.test(tag.id)
      || typeof tag.label !== 'string' || tag.label.length < 1 || tag.label.length > 40
      || typeof tag.description !== 'string' || tag.description.length > 120
      || !TAG_COLOR_PATTERN.test(tag.color)
      || !Number.isSafeInteger(tag.sortOrder)
      || typeof tag.active !== 'boolean'
      || seenIds.has(tag.id)) {
    throw new Error(`Invalid server-directory tag entry: ${tag?.id ?? '<missing>'}`);
  }
  seenIds.add(tag.id);
  return Object.freeze({ ...tag });
});

export const TAG_SCHEMA_VERSION = catalog.schemaVersion;
export const TAG_CATALOG_VERSION = catalog.tagCatalogVersion;
export const SERVER_DIRECTORY_TAGS = Object.freeze(validatedTags);

const ACTIVE_TAG_IDS = new Set(SERVER_DIRECTORY_TAGS.filter((tag) => tag.active).map((tag) => tag.id));

export function isActiveTagId(tagId) {
  return ACTIVE_TAG_IDS.has(tagId);
}

export function createTagResponse() {
  return {
    schemaVersion: TAG_SCHEMA_VERSION,
    tagCatalogVersion: TAG_CATALOG_VERSION,
    tags: SERVER_DIRECTORY_TAGS
  };
}
