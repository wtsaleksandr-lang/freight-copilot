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
}

export interface RankedRateOption extends RateOption {
  rank: number;
  delta_from_lowest: number;
  delta_pct: number;
  close_to_lowest: boolean;
}
