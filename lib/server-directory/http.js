import crypto from 'node:crypto';
import { createBootstrapReset, createBootstrapSnapshot } from './bootstrap-listings.js';
import { DirectoryError, sendError, sendJson } from './errors.js';
import { getDirectoryStorage } from './storage.js';
import { createTagResponse } from './tags.js';
import { parsePageParameters, validateBodySize, validateDeleteInput, validateListingEndpoint, validateListingInput } from './validation.js';

const TAG_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const SYNC_CACHE = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';

function etagFor(body) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 24);
  return `W/"sd-v1-${digest}"`;
}

function headerValue(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function sendCacheable(req, res, body, cacheControl) {
  const etag = etagFor(body);
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (headerValue(req, 'if-none-match') === etag) {
    res.setHeader('Cache-Control', cacheControl);
    return res.status(304).end();
  }
  return sendJson(res, 200, body, cacheControl);
}

function allow(res, methods) {
  res.setHeader('Allow', methods.join(', '));
}

function requireMethod(req, res, methods) {
  if (!methods.includes(req.method)) {
    allow(res, methods);
    throw new DirectoryError(405, 'method_not_allowed', 'Method not allowed.');
  }
}

function requireHttps(req) {
  const forwarded = headerValue(req, 'x-forwarded-proto') || headerValue(req, 'x-vercel-forwarded-proto');
  const secureSocket = req.socket?.encrypted === true;
  if (!secureSocket && (!forwarded || forwarded.split(',')[0].trim().toLowerCase() !== 'https')) {
    throw new DirectoryError(400, 'https_required', 'Listing operations require HTTPS.');
  }
}

function mutationCooldownMs() {
  const configured = Number(process.env.SERVER_DIRECTORY_MUTATION_COOLDOWN_SECONDS || 60);
  return Math.max(0, Math.min(3600, Number.isFinite(configured) ? configured : 60)) * 1000;
}

export function createTagsHandler() {
  return async function tagsHandler(req, res) {
    try {
      requireMethod(req, res, ['GET']);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return sendCacheable(req, res, createTagResponse(), TAG_CACHE);
    } catch (error) {
      return sendError(res, error);
    }
  };
}

export function createSyncHandler(storage = undefined) {
  return async function syncHandler(req, res) {
    try {
      requireMethod(req, res, ['GET']);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const { after, limit } = parsePageParameters(req.query);
      let body;
      if (storage === undefined && !process.env.DATABASE_URL) {
        res.setHeader('X-MCOSE-Directory-Mode', 'bootstrap');
        body = after === 0 ? createBootstrapSnapshot() : createBootstrapReset(after);
      } else if (after === 0) {
        const target = storage || getDirectoryStorage();
        const snapshot = await target.getSnapshot();
        body = {
          schemaVersion: 1,
          mode: 'snapshot',
          fromSequence: 0,
          throughSequence: snapshot.throughSequence,
          hasMore: false,
          resetRequired: false,
          listings: snapshot.listings
        };
      } else {
        const target = storage || getDirectoryStorage();
        const delta = await target.getDelta(after, limit);
        body = {
          schemaVersion: 1,
          mode: 'delta',
          fromSequence: after,
          throughSequence: delta.throughSequence,
          hasMore: delta.hasMore,
          resetRequired: delta.resetRequired,
          changes: delta.changes
        };
      }
      return sendCacheable(req, res, body, SYNC_CACHE);
    } catch (error) {
      return sendError(res, error);
    }
  };
}

export function createListingHandler(storage = undefined) {
  return async function listingHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      requireMethod(req, res, ['GET', 'PUT', 'DELETE']);
      const target = storage || getDirectoryStorage();
      requireHttps(req);
      if (req.method === 'GET') {
        const endpoint = validateListingEndpoint(req.query);
        const listing = await target.getListing(endpoint.normalizedEndpoint);
        return sendJson(res, 200, { schemaVersion: 1, listing }, 'no-store');
      }
      const body = validateBodySize(req);
      if (req.method === 'PUT') {
        const input = validateListingInput(body);
        const result = await target.putListing(input, { cooldownMs: mutationCooldownMs() });
        return sendJson(res, result.created ? 201 : 200, {
          schemaVersion: 1,
          listing: result.listing,
          changeSequence: result.changeSequence
        }, 'no-store');
      }
      const input = validateDeleteInput(body);
      const result = await target.deleteListing(input.normalizedEndpoint, input.expectedRevision, { cooldownMs: mutationCooldownMs() });
      return sendJson(res, 200, {
        schemaVersion: 1,
        deleted: true,
        ...result
      }, 'no-store');
    } catch (error) {
      return sendError(res, error);
    }
  };
}

export { etagFor };
