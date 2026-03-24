/**
 * Shared CORS origin registry populated by platformBoot() at startup.
 *
 * Extracted into its own module to avoid a circular dependency between
 * app.ts (which needs the origins for CORS middleware) and index.ts
 * (which calls platformBoot and sets the origins).
 */

let _productCorsOrigins: string[] | null = null;

/** Called by index.ts after platformBoot() resolves. */
export function setProductCorsOrigins(origins: string[]): void {
  _productCorsOrigins = origins;
}

/**
 * Returns DB-derived CORS origins, or null if platformBoot() has not run yet
 * (e.g. no DATABASE_URL). The CORS middleware falls back to UI_ORIGIN env var
 * when this returns null.
 */
export function getProductCorsOrigins(): string[] | null {
  return _productCorsOrigins;
}
