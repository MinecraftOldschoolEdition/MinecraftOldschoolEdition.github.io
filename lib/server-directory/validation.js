import net from 'node:net';
import { domainToASCII } from 'node:url';
import { DirectoryError } from './errors.js';
import { isActiveTagId } from './tags.js';

export const LIMITS = Object.freeze({
  nameChars: 64,
  descriptionChars: 200,
  creatorUsernameChars: 32,
  creatorUuidChars: 36,
  hostnameChars: 253,
  maxTags: 3,
  maxBodyBytes: 8192,
  defaultPageSize: 250,
  maxPageSize: 250
});

const FORMAT_OR_CONTROL = /[\u0000-\u001f\u007f\u00a7]/;
const HTML_MARKUP = /[<>]/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validation(message, details) {
  throw new DirectoryError(400, 'validation_failed', message, details);
}

export function normalizeVisibleText(value, field, minChars, maxChars) {
  if (typeof value !== 'string') validation(`${field} must be a string.`, { field });
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length < minChars || normalized.length > maxChars) {
    validation(`${field} must contain between ${minChars} and ${maxChars} characters.`, { field });
  }
  if (FORMAT_OR_CONTROL.test(normalized) || HTML_MARKUP.test(normalized)) {
    validation(`${field} contains forbidden control, formatting, or markup characters.`, { field });
  }
  return normalized;
}

function parseIpv4(ip) {
  return ip.split('.').map((part) => Number(part));
}

function isGlobalIpv4(ip) {
  const p = parseIpv4(ip);
  if (p.length !== 4 || p.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
  if (p[0] === 198 && p[1] === 51 && p[2] === 100) return false;
  if (p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
  return true;
}

function parseIpv6Words(ip) {
  let address = ip.toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) return null;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const embedded = address.substring(lastColon + 1);
    if (net.isIP(embedded) !== 4) return null;
    const bytes = parseIpv4(embedded);
    address = `${address.substring(0, lastColon)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...new Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function isGlobalIpv6(ip) {
  const words = parseIpv6Words(ip);
  if (!words) return false;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  const first = words[0];
  if ((first & 0xff00) === 0xff00) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isGlobalIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if (first === 0x2001 && words[1] === 0x0db8) return false;
  return (first & 0xe000) === 0x2000;
}

function canonicalizeIpv6(ip) {
  const words = parseIpv6Words(ip);
  if (!words) return null;
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) return words.map((word) => word.toString(16)).join(':');
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(':');
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(':');
  return `${left}::${right}`;
}

export function isGlobalUnicastIp(ip) {
  const version = net.isIP(ip);
  return version === 4 ? isGlobalIpv4(ip) : version === 6 ? isGlobalIpv6(ip) : false;
}

export function normalizeHost(value) {
  if (typeof value !== 'string') validation('host must be a string.', { field: 'host' });
  let host = value.trim();
  if (!host || host.length > LIMITS.hostnameChars || FORMAT_OR_CONTROL.test(host)) validation('host is invalid.', { field: 'host' });
  if (host.includes('://') || host.includes('/') || host.includes('\\') || host.includes('@') || host.includes('?') || host.includes('#')) {
    validation('host must not include a URL scheme, path, query, fragment, or user information.', { field: 'host' });
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const ipVersion = net.isIP(host);
  if (ipVersion !== 0) {
    if (!isGlobalUnicastIp(host)) validation('host must be a global-unicast address.', { field: 'host' });
    return ipVersion === 6 ? canonicalizeIpv6(host) : host.toLowerCase();
  }
  if (host.includes(':')) validation('IPv6 literals must be valid addresses.', { field: 'host' });
  const ascii = domainToASCII(host.toLowerCase()).replace(/\.$/, '');
  if (!ascii || ascii.length > LIMITS.hostnameChars) validation('host is not a valid hostname.', { field: 'host' });
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) validation('host is not a valid public hostname.', { field: 'host' });
  const suffix = labels[labels.length - 1];
  if (suffix === 'local' || suffix === 'localhost' || suffix === 'internal' || suffix === 'home' || suffix === 'test' || suffix === 'invalid' || suffix === 'example') {
    validation('host must not use a reserved or local-only name.', { field: 'host' });
  }
  return ascii;
}

export function normalizePort(value) {
  const port = value === undefined || value === null || value === '' ? 25565 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) validation('port must be an integer from 1 to 65535.', { field: 'port' });
  return port;
}

export function formatEndpoint(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function validateListingEndpoint(value) {
  const host = normalizeHost(value?.host);
  const port = normalizePort(value?.port);
  return { host, port, normalizedEndpoint: formatEndpoint(host, port) };
}

export function normalizeTags(value) {
  if (!Array.isArray(value)) validation('tagIds must be an array.', { field: 'tagIds' });
  const tagIds = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') validation('Every tag ID must be a string.', { field: 'tagIds' });
    const tagId = raw.trim().toLowerCase();
    if (!tagId || seen.has(tagId)) validation('Tag IDs must be distinct.', { field: 'tagIds' });
    if (!isActiveTagId(tagId)) validation(`Unknown or inactive tag: ${tagId}`, { field: 'tagIds', tagId });
    seen.add(tagId);
    tagIds.push(tagId);
  }
  if (tagIds.length < 1 || tagIds.length > LIMITS.maxTags) validation('A listing must have between one and three tags.', { field: 'tagIds' });
  return tagIds;
}

export function validateListingInput(body) {
  const endpoint = validateListingEndpoint(body);
  const creator = body?.creator;
  if (!creator || typeof creator !== 'object' || Array.isArray(creator)) validation('creator is required.', { field: 'creator' });
  const username = normalizeVisibleText(creator.username, 'creator.username', 1, LIMITS.creatorUsernameChars);
  let uuid = null;
  if (creator.uuid !== undefined && creator.uuid !== null && creator.uuid !== '') {
    if (typeof creator.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creator.uuid)) {
      validation('creator.uuid must be a valid UUID.', { field: 'creator.uuid' });
    }
    uuid = creator.uuid.toLowerCase();
  }
  const expectedRevision = body.expectedRevision === undefined || body.expectedRevision === null ? null : Number(body.expectedRevision);
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    validation('expectedRevision must be a positive integer.', { field: 'expectedRevision' });
  }
  return {
    expectedRevision,
    name: normalizeVisibleText(body.name, 'name', 1, LIMITS.nameChars),
    ...endpoint,
    creatorUsername: username,
    creatorUuid: uuid,
    description: normalizeVisibleText(body.description, 'description', 1, LIMITS.descriptionChars),
    tagIds: normalizeTags(body.tagIds)
  };
}

export function validateDeleteInput(body) {
  const endpoint = validateListingEndpoint(body);
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) validation('expectedRevision must be a positive integer.', { field: 'expectedRevision' });
  return { ...endpoint, expectedRevision };
}

export function validateBodySize(req) {
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > LIMITS.maxBodyBytes) throw new DirectoryError(413, 'payload_too_large', 'Request body is too large.');
  const encoded = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (Buffer.byteLength(encoded, 'utf8') > LIMITS.maxBodyBytes) throw new DirectoryError(413, 'payload_too_large', 'Request body is too large.');
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      validation('Request body must be valid JSON.');
    }
  }
  return req.body || {};
}

export function parsePageParameters(query) {
  const after = query?.after === undefined ? 0 : Number(query.after);
  const requestedLimit = query?.limit === undefined ? LIMITS.defaultPageSize : Number(query.limit);
  if (!Number.isSafeInteger(after) || after < 0) validation('after must be a non-negative integer.', { field: 'after' });
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) validation('limit must be a positive integer.', { field: 'limit' });
  return { after, limit: Math.min(requestedLimit, LIMITS.maxPageSize) };
}
