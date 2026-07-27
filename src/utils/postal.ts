// Postal-code normalization shared by the geocoder and rate matching.
//
// Owners paste Canadian postal codes both ways — "J1Z 2C2" and "J1Z2C2".
// The geocoder and the canonical-zip rate lookup both expect ONE canonical
// form, so we normalize to the official Canada Post form: uppercase, a single
// space in the middle (ANA NAN → "J1Z 2C2").
//
// Anything that isn't CA-postal-shaped (US ZIP, ZIP+4, city names, garbage)
// is returned UNCHANGED so this is safe to call on any address/ZIP string.
//
// The identical tiny regex is duplicated in the browser client
// (src/server/public/app.js `normalizePostal`) because that file is plain,
// unbundled browser JS and can't import this ESM module.

const CA_POSTAL = /^([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)$/;

/**
 * Canonicalize a Canadian postal code to "ANA NAN" (uppercase, single mid
 * space). Non-CA-postal input (US ZIP, ZIP+4, arbitrary text) passes through
 * unchanged.
 */
export function normalizePostal(s: string): string {
  if (typeof s !== 'string') return s;
  const m = CA_POSTAL.exec(s.trim());
  if (!m) return s;
  return `${m[1]} ${m[2]}`.toUpperCase();
}
