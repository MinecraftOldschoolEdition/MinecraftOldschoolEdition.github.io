export const TAG_SCHEMA_VERSION = 1;
export const TAG_CATALOG_VERSION = 1;

export const SERVER_DIRECTORY_TAGS = Object.freeze([
  Object.freeze({ id: 'survival', label: 'Survival', description: 'Classic survival gameplay and progression.', sortOrder: 10, active: true }),
  Object.freeze({ id: 'creative', label: 'Creative', description: 'Creative building and unrestricted construction.', sortOrder: 20, active: true }),
  Object.freeze({ id: 'vanilla', label: 'Vanilla', description: 'Mostly unmodified oldschool gameplay.', sortOrder: 30, active: true }),
  Object.freeze({ id: 'economy', label: 'Economy', description: 'Trading, shops, currency, or player markets.', sortOrder: 40, active: true }),
  Object.freeze({ id: 'pvp', label: 'PvP', description: 'Player-versus-player combat is a primary feature.', sortOrder: 50, active: true }),
  Object.freeze({ id: 'roleplay', label: 'Roleplay', description: 'Roleplay, lore, or community storytelling.', sortOrder: 60, active: true }),
  Object.freeze({ id: 'minigames', label: 'Minigames', description: 'Short-form games, arenas, or rotating activities.', sortOrder: 70, active: true }),
  Object.freeze({ id: 'anarchy', label: 'Anarchy', description: 'Minimal rules and unrestricted player competition.', sortOrder: 80, active: true }),
  Object.freeze({ id: 'custom', label: 'Custom', description: 'Custom mechanics, worlds, or server-specific content.', sortOrder: 90, active: true })
]);

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
