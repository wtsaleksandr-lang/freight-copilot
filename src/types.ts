export interface RateCharge {
  /** e.g. "Basic Ocean Freight", "Emergency Bunker Fee", "Terminal Handling Service - Destination" */
  name: string;
  /** e.g. "Container", "Bill of Lading". null if not shown. */
  basis: string | null;
  quantity: number | null;
  unit_price: number | null;
  /** The "Total price" cell — what we sum. */
  total: number;
  /** ISO currency code. */
  currency: string;
}

export interface RateOption {
  service_name: string;
  sailing_date: string | null;
  departure_datetime: string | null;
  arrival_datetime: string | null;
  gate_in_deadline: string | null;
  transit_days: number | null;
  transit_hours: number | null;
  vessel_voyage: string | null;
  headline_price_amount: number | null;
  headline_price_currency: string | null;
  rollable: boolean;
  detention_freetime_days: number | null;
  demurrage_freetime_days: number | null;
  /** Itemized "Freight charges" rows from the breakdown panel. Sum = our cost. */
  freight_charges: RateCharge[];
  /** Itemized "Destination charges" rows. On collect (paid by receiver). Informational only. */
  destination_charges: RateCharge[];
}

export interface RankedRateOption extends RateOption {
  rank: number;
  delta_from_lowest: number;
  delta_pct: number;
  close_to_lowest: boolean;
  /** Sum of freight_charges (our cost). Falls back to headline_price_amount if charges weren't extracted. */
  freight_total: number;
  freight_currency: string;
  /** Sum of destination_charges per currency (since they may be in EUR while freight is USD). */
  destination_total: number;
  destination_currency: string | null;
  /** True when freight_total differs from headline by >2% — indicates parse drift worth a manual look. */
  headline_mismatch: boolean;
}
