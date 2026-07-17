import { describe, expect, it } from 'vitest';
import { chooseShipmentMatch, rankShipmentMatches } from './shipmentDocumentMatcher.js';

const rows = [
  { refId: 'S00011', bookingRef: 'MAEU-9032111', customerName: 'Access Air', shipperName: 'ABC Machinery', receiverName: 'Port Client', carrierPreference: 'Maersk', pol: 'Montreal', pod: 'Antwerp', containerType: '40HC' },
  { refId: 'S00012', bookingRef: 'MSC-218754', customerName: 'Other Customer', shipperName: 'ABC Machinery', receiverName: 'Port Client', carrierPreference: 'MSC', pol: 'Montreal', pod: 'Hamburg', containerType: '40HC' },
];

describe('shipment document matching', () => {
  it('uses an internal shipment reference as decisive evidence', () => {
    const result = chooseShipmentMatch({ internalRef: 'S00012' }, rows);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.match.shipment.refId).toBe('S00012');
  });

  it('uses an exact booking reference as decisive evidence', () => {
    const result = chooseShipmentMatch({ bookingRef: 'MAEU 9032111' }, rows);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.match.shipment.refId).toBe('S00011');
  });

  it('returns ambiguous candidates when evidence is shared', () => {
    const result = chooseShipmentMatch({ shipperName: 'ABC Machinery', containerType: '40HC' }, rows);
    expect(result.status).toBe('ambiguous');
  });

  it('ranks a matching route above a partial party match', () => {
    const ranked = rankShipmentMatches({ customerName: 'Access Air', pol: 'Montreal', pod: 'Antwerp' }, rows);
    expect(ranked[0]?.shipment.refId).toBe('S00011');
    expect(ranked[0]?.evidence).toContain('POD');
  });
});
