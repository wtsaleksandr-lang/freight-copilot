import type { CarrierAdapter } from './types.js';
import * as maersk from './maersk/index.js';
import * as msc from './msc/index.js';
import * as cma from './cma/index.js';
import * as hlc from './hlc/index.js';
import * as one from './one/index.js';
import * as oocl from './oocl/index.js';
import * as zim from './zim/index.js';

export const CARRIERS: Record<string, CarrierAdapter> = {
  MSK: maersk,
  MSC: msc,
  CMA: cma,
  HLC: hlc,
  ONE: one,
  OOC: oocl,
  ZIM: zim,
};

export function getCarrier(code: string): CarrierAdapter {
  const c = CARRIERS[code.toUpperCase()];
  if (!c) {
    throw new Error(
      `Unknown carrier code "${code}". Known: ${Object.keys(CARRIERS).join(', ')}`
    );
  }
  return c;
}

export function listCarriers(): CarrierAdapter[] {
  return Object.values(CARRIERS);
}

export function listActiveCarriers(): CarrierAdapter[] {
  return listCarriers().filter((c) => c.isActive);
}
