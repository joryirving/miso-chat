'use strict';

/**
 * Middleware that validates Content-Type headers for POST/PUT/PATCH requests.
 * - API routes (/api/*) require application/json
 * - Form routes require application/x-www-form-urlencoded
 * - GET, HEAD, DELETE and other methods without bodies are skipped
 */
function validateContentType(req, res, next) {
  const method = req.method;

  // Only validate methods that typically send a request body
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    return next();
  }

  const contentType = req.get('content-type');

  // If no Content-Type header is present, allow it through (body parsers will handle it)
  if (!contentType) {
    return next();
  }

  // Strip charset and other parameters for comparison
  const cleanType = contentType.split(';')[0].trim().toLowerCase();

  const isApiRoute = req.path.startsWith('/api/');

  if (isApiRoute) {
    if (cleanType !== 'application/json') {
      return res.status(415).json({
        error: 'Unsupported Media Type',
        message: `API routes require Content-Type: application/json. Received: ${contentType}`
      });
    }
  } else {
    // Non-API routes (e.g., /login form POST) expect form-encoded data
    if (cleanType !== 'application/x-www-form-urlencoded') {
      return res.status(415).json({
        error: 'Unsupported Media Type',
        message: `Form routes require Content-Type: application/x-www-form-urlencoded. Received: ${contentType}`
      });
    }
  }

  next();
}

module.exports = validateContentType;
