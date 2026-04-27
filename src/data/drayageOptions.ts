/**
 * Picklists used in drayage forms. Extend as common values come up.
 */

export const SPECIAL_EQUIPMENT = [
  'Tri-axle chassis',
  'Quad-axle chassis',
  'Twin chassis',
  'Heavy-duty chassis',
  'Bobtail chassis',
  'Gen-set (reefer plug)',
  'Hazmat permit',
  'Overweight permit',
  'Oversized / OOG permit',
  'Dual-driver team',
] as const;

export const ACCESSORIALS = [
  'Prepull',
  'Yard storage',
  'Drop and pick',
  'Live unload / load',
  'Detention beyond free time',
  'Demurrage',
  'Per diem',
  'Chassis usage',
  'Fuel surcharge',
  'Inside delivery',
  'Liftgate',
  'Driver assist',
  'Appointment fee',
  'Hand pump / pallet jack',
  'Residential delivery',
  'Stop-off',
  'After-hours pickup/delivery',
  'Weekend / holiday',
] as const;
