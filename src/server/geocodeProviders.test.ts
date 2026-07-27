import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeoapifyUrl,
  buildNominatimUrl,
  mapGeoapifyResults,
  mapNominatimResults,
  geocodeSearch,
  type FetchLike,
  type GeoapifyResponse,
} from './geocodeProviders.js';

// A real-shape Geoapify autocomplete `format=json` response (one CA result
// carrying a postcode). Mirrors an actual live call.
const GEOAPIFY_SAMPLE: GeoapifyResponse = {
  results: [
    {
      formatted: 'Saint-Joachim-de-Courval, Drummondville, QC J1Z 2B9, Canada',
      address_line1: 'Saint-Joachim-de-Courval',
      address_line2: 'Drummondville, QC J1Z 2B9, Canada',
      city: 'Drummondville',
      state: 'Quebec',
      state_code: 'QC',
      postcode: 'J1Z 2B9',
      country: 'Canada',
      country_code: 'ca',
      housenumber: null,
      street: null,
      lon: -72.55,
      lat: 45.97,
      result_type: 'city',
    },
  ],
};

test('mapGeoapifyResults maps a CA result to the frontend contract', () => {
  const [r] = mapGeoapifyResults(GEOAPIFY_SAMPLE);
  assert.ok(r, 'produced a result');
  assert.equal(r.display, 'Saint-Joachim-de-Courval, Drummondville, QC J1Z 2B9, Canada');
  assert.equal(r.zip, 'J1Z 2B9');
  assert.equal(r.state, 'QC'); // state_code preferred over full state name
  assert.equal(r.country, 'CA'); // country_code upper-cased
  assert.equal(r.countryCode, 'CA');
  assert.equal(r.city, 'Drummondville');
  assert.equal(r.lat, 45.97);
  assert.equal(r.lng, -72.55);
  // No housenumber/street on a city-type result → empty street, not "null".
  assert.equal(r.street, '');
});

test('mapGeoapifyResults builds street from housenumber + street when present', () => {
  const [r] = mapGeoapifyResults({
    results: [
      {
        formatted: '350 5th Ave, New York, NY 10118, United States',
        housenumber: '350',
        street: '5th Avenue',
        city: 'New York',
        state: 'New York',
        state_code: 'NY',
        postcode: '10118',
        country: 'United States',
        country_code: 'us',
        lon: -73.985,
        lat: 40.748,
      },
    ],
  });
  assert.ok(r, 'produced a result');
  assert.equal(r.street, '350 5th Avenue');
  assert.equal(r.state, 'NY');
  assert.equal(r.country, 'US');
  assert.equal(r.zip, '10118');
});

test('mapGeoapifyResults tolerates an empty/absent results array', () => {
  assert.deepEqual(mapGeoapifyResults({}), []);
  assert.deepEqual(mapGeoapifyResults({ results: [] }), []);
});

test('mapNominatimResults maps the legacy fallback shape', () => {
  const [r] = mapNominatimResults([
    {
      display_name: 'Toronto, Ontario, Canada',
      lat: '43.6532',
      lon: '-79.3832',
      address: {
        city: 'Toronto',
        state: 'Ontario',
        postcode: 'M5H',
        country: 'Canada',
        country_code: 'ca',
      },
    },
  ]);
  assert.ok(r, 'produced a result');
  assert.equal(r.city, 'Toronto');
  assert.equal(r.state, 'Ontario');
  assert.equal(r.zip, 'M5H');
  assert.equal(r.country, 'Canada');
  assert.equal(r.countryCode, 'CA');
  assert.equal(r.lat, 43.6532);
  assert.equal(r.lng, -79.3832);
});

test('buildGeoapifyUrl targets the Geoapify host and carries the key', () => {
  const u = new URL(buildGeoapifyUrl('drummond', 'us,ca', 'SECRET_KEY'));
  assert.equal(u.host, 'api.geoapify.com');
  assert.equal(u.pathname, '/v1/geocode/autocomplete');
  assert.equal(u.searchParams.get('text'), 'drummond');
  assert.equal(u.searchParams.get('filter'), 'countrycode:us,ca');
  assert.equal(u.searchParams.get('limit'), '8');
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(u.searchParams.get('apiKey'), 'SECRET_KEY');
});

test('buildNominatimUrl targets the Nominatim host', () => {
  const u = new URL(buildNominatimUrl('drummond', 'us,ca'));
  assert.equal(u.host, 'nominatim.openstreetmap.org');
  assert.equal(u.searchParams.get('countrycodes'), 'us,ca');
  assert.equal(u.searchParams.get('q'), 'drummond');
});

test('geocodeSearch hits Geoapify when a key is present', async () => {
  let calledUrl = '';
  const fakeFetch: FetchLike = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => GEOAPIFY_SAMPLE };
  };
  const out = await geocodeSearch({
    q: 'drummond',
    ccFilter: 'us,ca',
    apiKey: 'SECRET_KEY',
    fetchImpl: fakeFetch,
  });
  assert.equal(new URL(calledUrl).host, 'api.geoapify.com');
  assert.equal(out[0]?.zip, 'J1Z 2B9');
  assert.equal(out[0]?.country, 'CA');
});

test('geocodeSearch falls back to Nominatim when GEOAPIFY_API_KEY is unset', async () => {
  let calledUrl = '';
  const fakeFetch: FetchLike = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => [
        { display_name: 'X', address: { city: 'X', country_code: 'us' } },
      ],
    };
  };
  const out = await geocodeSearch({
    q: 'anywhere',
    ccFilter: 'us,ca',
    apiKey: undefined, // key unset → fallback path
    fetchImpl: fakeFetch,
  });
  assert.equal(new URL(calledUrl).host, 'nominatim.openstreetmap.org');
  assert.equal(out[0]?.countryCode, 'US');
});

test('geocodeSearch throws on a non-OK upstream response', async () => {
  const fakeFetch: FetchLike = async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
  });
  await assert.rejects(
    geocodeSearch({ q: 'x', ccFilter: 'us,ca', apiKey: 'K', fetchImpl: fakeFetch }),
    /Geoapify returned 429/,
  );
});
