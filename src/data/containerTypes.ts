/**
 * Standard ocean container types. The `label` matches Maersk's autocomplete
 * dropdown text so the existing fetchRates flow keeps working without changes.
 * Add more as needed.
 */
export const CONTAINER_TYPES = [
  { code: '20GP', label: '20 Dry Standard' },
  { code: '40GP', label: '40 Dry Standard' },
  { code: '40HC', label: '40 Dry High' },
  { code: '20RF', label: '20 Reefer' },
  { code: '40RF', label: '40 Reefer' },
  { code: '40RH', label: '40 Reefer High Cube' },
  { code: '20OT', label: '20 Open Top' },
  { code: '40OT', label: '40 Open Top' },
  { code: '20FR', label: '20 Flat Rack' },
  { code: '40FR', label: '40 Flat Rack' },
  { code: '20TK', label: '20 Tank' },
  { code: '40NOR', label: '40 NOR (Non-Operating Reefer)' },
] as const;
