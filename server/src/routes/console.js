import path from 'node:path';
import express from 'express';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', '..', 'public');

/**
 * The owner's control panel: three static files, no build step and nothing
 * loaded from a CDN.
 *
 * The panel is served without authentication on purpose — it holds no
 * credentials. The owner token is typed into the page and kept in the browser's
 * session storage, and every call it makes goes through the same authenticated
 * /api/v1 routes as curl would, so the panel cannot widen any rule.
 */
export function createConsoleRouter() {
  return express.static(PUBLIC_DIR, {
    index: 'console.html',
    extensions: ['html'],
    setHeaders(res) {
      // Nothing here should be cached or framed, and nothing here loads from
      // anywhere but this origin.
      res.setHeader('cache-control', 'no-store');
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    },
  });
}
