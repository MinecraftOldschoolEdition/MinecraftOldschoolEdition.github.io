export class DirectoryError extends Error {
  constructor(status, code, message, details = undefined, listing = undefined) {
    super(message);
    this.name = 'DirectoryError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.listing = listing;
  }
}

export function errorBody(error) {
  const body = {
    schemaVersion: 1,
    error: {
      code: error.code || 'internal_error',
      message: error.message || 'Internal server error.'
    }
  };
  if (error.details !== undefined) body.error.details = error.details;
  if (error.listing !== undefined) body.listing = error.listing;
  return body;
}

export function sendJson(res, status, body, cacheControl = 'no-store') {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  return res.status(status).json(body);
}

export function sendError(res, error) {
  const known = error instanceof DirectoryError;
  if (!known) console.error('[server-directory]', error);
  return sendJson(
    res,
    known ? error.status : 500,
    errorBody(known ? error : new DirectoryError(500, 'internal_error', 'Internal server error.')),
    'no-store'
  );
}
