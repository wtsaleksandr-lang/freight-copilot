/**
 * Major world container ports for typeahead. UN/LOCODE → display name.
 * Used as <datalist> suggestions, not a hard-coded restriction — user can type
 * any port name not on this list.
 */
export interface Port {
  code: string;
  name: string;
  country: string;
}

export const MAJOR_PORTS: Port[] = [
  // North America
  { code: 'USEWR', name: 'Newark, NJ', country: 'United States' },
  { code: 'USNYC', name: 'New York, NY', country: 'United States' },
  { code: 'USLAX', name: 'Los Angeles, CA', country: 'United States' },
  { code: 'USLGB', name: 'Long Beach, CA', country: 'United States' },
  { code: 'USOAK', name: 'Oakland, CA', country: 'United States' },
  { code: 'USSEA', name: 'Seattle, WA', country: 'United States' },
  { code: 'USTIW', name: 'Tacoma, WA', country: 'United States' },
  { code: 'USHOU', name: 'Houston, TX', country: 'United States' },
  { code: 'USCHS', name: 'Charleston, SC', country: 'United States' },
  { code: 'USSAV', name: 'Savannah, GA', country: 'United States' },
  { code: 'USMIA', name: 'Miami, FL', country: 'United States' },
  { code: 'USORF', name: 'Norfolk, VA', country: 'United States' },
  { code: 'USBAL', name: 'Baltimore, MD', country: 'United States' },
  { code: 'USBOS', name: 'Boston, MA', country: 'United States' },
  { code: 'USJAX', name: 'Jacksonville, FL', country: 'United States' },
  { code: 'CAVAN', name: 'Vancouver', country: 'Canada' },
  { code: 'CAMTR', name: 'Montreal', country: 'Canada' },
  { code: 'CAHAL', name: 'Halifax', country: 'Canada' },
  { code: 'MXVER', name: 'Veracruz', country: 'Mexico' },
  { code: 'MXLZC', name: 'Lazaro Cardenas', country: 'Mexico' },

  // Europe
  { code: 'NLRTM', name: 'Rotterdam', country: 'Netherlands' },
  { code: 'BEANR', name: 'Antwerp', country: 'Belgium' },
  { code: 'DEHAM', name: 'Hamburg', country: 'Germany' },
  { code: 'DEBRV', name: 'Bremerhaven', country: 'Germany' },
  { code: 'GBFXT', name: 'Felixstowe', country: 'United Kingdom' },
  { code: 'GBLGP', name: 'London Gateway', country: 'United Kingdom' },
  { code: 'GBSOU', name: 'Southampton', country: 'United Kingdom' },
  { code: 'FRLEH', name: 'Le Havre', country: 'France' },
  { code: 'FRFOS', name: 'Fos-sur-Mer (Marseille)', country: 'France' },
  { code: 'ESBCN', name: 'Barcelona', country: 'Spain' },
  { code: 'ESVLC', name: 'Valencia', country: 'Spain' },
  { code: 'ESALG', name: 'Algeciras', country: 'Spain' },
  { code: 'ITGOA', name: 'Genoa', country: 'Italy' },
  { code: 'GRPIR', name: 'Piraeus', country: 'Greece' },

  // Middle East / Africa
  { code: 'EGPSD', name: 'Port Said', country: 'Egypt' },
  { code: 'EGSOK', name: 'Sokhna', country: 'Egypt' },
  { code: 'AEDXB', name: 'Dubai (Jebel Ali)', country: 'UAE' },
  { code: 'AEAUH', name: 'Abu Dhabi', country: 'UAE' },
  { code: 'OMSOH', name: 'Salalah', country: 'Oman' },
  { code: 'ZADUR', name: 'Durban', country: 'South Africa' },
  { code: 'ZACPT', name: 'Cape Town', country: 'South Africa' },

  // Asia
  { code: 'CNSHA', name: 'Shanghai', country: 'China' },
  { code: 'CNNGB', name: 'Ningbo', country: 'China' },
  { code: 'CNYTN', name: 'Yantian', country: 'China' },
  { code: 'CNSZX', name: 'Shenzhen', country: 'China' },
  { code: 'CNTAO', name: 'Qingdao', country: 'China' },
  { code: 'CNTSN', name: 'Tianjin', country: 'China' },
  { code: 'CNXMG', name: 'Xiamen', country: 'China' },
  { code: 'HKHKG', name: 'Hong Kong', country: 'Hong Kong' },
  { code: 'TWKEL', name: 'Keelung', country: 'Taiwan' },
  { code: 'TWKHH', name: 'Kaohsiung', country: 'Taiwan' },
  { code: 'KRPUS', name: 'Busan', country: 'South Korea' },
  { code: 'JPYOK', name: 'Yokohama', country: 'Japan' },
  { code: 'JPTYO', name: 'Tokyo', country: 'Japan' },
  { code: 'SGSIN', name: 'Singapore', country: 'Singapore' },
  { code: 'MYPKG', name: 'Port Klang', country: 'Malaysia' },
  { code: 'MYTPP', name: 'Tanjung Pelepas', country: 'Malaysia' },
  { code: 'VNSGN', name: 'Ho Chi Minh City (Cat Lai)', country: 'Vietnam' },
  { code: 'VNHPH', name: 'Haiphong', country: 'Vietnam' },
  { code: 'THLCH', name: 'Laem Chabang', country: 'Thailand' },
  { code: 'IDJKT', name: 'Jakarta (Tanjung Priok)', country: 'Indonesia' },
  { code: 'PHMNL', name: 'Manila', country: 'Philippines' },
  { code: 'INNSA', name: 'Nhava Sheva (JNPT)', country: 'India' },
  { code: 'INMUN', name: 'Mundra', country: 'India' },
  { code: 'INMAA', name: 'Chennai', country: 'India' },

  // Oceania + South America
  { code: 'AUSYD', name: 'Sydney', country: 'Australia' },
  { code: 'AUMEL', name: 'Melbourne', country: 'Australia' },
  { code: 'AUBNE', name: 'Brisbane', country: 'Australia' },
  { code: 'BRSSZ', name: 'Santos', country: 'Brazil' },
  { code: 'CLVAP', name: 'Valparaiso', country: 'Chile' },
  { code: 'CLSAI', name: 'San Antonio', country: 'Chile' },
  { code: 'PECAL', name: 'Callao', country: 'Peru' },
  { code: 'ARBUE', name: 'Buenos Aires', country: 'Argentina' },
];
