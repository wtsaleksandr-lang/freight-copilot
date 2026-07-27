/**
 * Address / ZIP autosuggest providers for GET /api/data/geocode.
 *
 * Two backends behind an identical output contract so the frontend
 * (`geocodeFetch` / `applyGeocodePick` in public/app.js) needs no change:
 *
 *   - Geoapify Autocomplete  — used when GEOAPIFY_API_KEY is set. Real
 *     street-address + postal-code typeahead for US + CA.
 *   - OpenStreetMap Nominatim — free, keyless fallback so dev without the
 *     key still works. Coarser (mostly city/region) matches.
 *
 * Every result is normalized to GeocodeResult. The key is server-side only:
 * it is embedded in the outbound Geoapify URL here and never reaches the
 * browser (the route proxies the call).
 */

/** Normalized shape the frontend consumes. Keep stable — the browser depends on it. */
export interface GeocodeResult {
  display: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  countryCode: string;
  lat: number | null;
  lng: number | null;
}

/** One item from Geoapify autocomplete `format=json`. Fields we consume. */
export interface GeoapifyItem {
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  housenumber?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  postcode?: string | null;
  country?: string | null;
  country_code?: string | null;
  lon?: number | null;
  lat?: number | null;
  result_type?: string | null;
}

export interface GeoapifyResponse {
  results?: GeoapifyItem[];
}

/** One item from Nominatim `format=json&addressdetails=1`. */
export interface NominatimItem {
  display_name: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string | undefined>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Build the Geoapify autocomplete URL. The API key is appended here (server
 * side) and never exposed to the client.
 */
export function buildGeoapifyUrl(q: string, ccFilter: string, apiKey: string): string {
  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', q);
  url.searchParams.set('filter', `countrycode:${ccFilter}`);
  url.searchParams.set('limit', '8');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);
  return url.toString();
}

/** Build the Nominatim search URL (keyless fallback). */
export function buildNominatimUrl(q: string, ccFilter: string): string {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '8');
  url.searchParams.set('countrycodes', ccFilter);
  url.searchParams.set('q', q);
  return url.toString();
}

/** Map a Geoapify `format=json` response to the frontend contract. */
export function mapGeoapifyResults(raw: GeoapifyResponse): GeocodeResult[] {
  const items = Array.isArray(raw?.results) ? raw.results : [];
  return items.map((it) => {
    const street = [it.housenumber, it.street].filter(Boolean).join(' ').trim();
    const countryCode = (it.country_code ?? '').toUpperCase();
    return {
      display: it.formatted ?? '',
      street,
      city: it.city ?? '',
      state: it.state_code ?? it.state ?? '',
      zip: it.postcode ?? '',
      // Per contract: expose the upper-cased ISO code as `country`; the
      // frontend uses `countryCode || country`, so both being the code is safe.
      country: countryCode,
      countryCode,
      lat: num(it.lat),
      lng: num(it.lon),
    };
  });
}

/** Map a Nominatim response to the frontend contract. */
export function mapNominatimResults(raw: NominatimItem[]): GeocodeResult[] {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((it) => {
    const a = it.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
    const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? '';
    return {
      display: it.display_name,
      street,
      city,
      state: a.state ?? a.region ?? '',
      zip: a.postcode ?? '',
      country: a.country ?? '',
      countryCode: (a.country_code ?? '').toUpperCase(),
      lat: num(it.lat),
      lng: num(it.lon),
    };
  });
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GeocodeSearchOpts {
  q: string;
  ccFilter: string;
  /** GEOAPIFY_API_KEY, if provisioned. Absent → Nominatim fallback. */
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Run the geocode search against Geoapify (when a key is present) or the
 * Nominatim fallback, returning the normalized results. Throws on a non-OK
 * upstream response so the route can map it to a 502.
 */
export async function geocodeSearch(opts: GeocodeSearchOpts): Promise<GeocodeResult[]> {
  const { q, ccFilter, apiKey } = opts;
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));

  if (apiKey) {
    const r = await doFetch(buildGeoapifyUrl(q, ccFilter, apiKey), {
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Geoapify returned ${r.status}`);
    return mapGeoapifyResults((await r.json()) as GeoapifyResponse);
  }

  const r = await doFetch(buildNominatimUrl(q, ccFilter), {
    headers: {
      'User-Agent': 'freight-copilot/1.0 (personal-use freight forwarder app)',
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Nominatim returned ${r.status}`);
  return mapNominatimResults((await r.json()) as NominatimItem[]);
}
