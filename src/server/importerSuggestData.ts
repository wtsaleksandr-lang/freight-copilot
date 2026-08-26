/**
 * Static reference data + matcher for the Importer-Leads filter autosuggest.
 *
 * Purely local lookup lists — no external calls. The suggest endpoint
 * (GET /api/importer-leads/suggest, registered in importerLeadsRoute.ts) filters
 * these in-process so a keystroke NEVER touches ImportYeti/Hunter/Anthropic.
 *
 * Four fields are covered:
 *   entryPort       → major US entry ports (name + state)
 *   supplierCountry → ISO country list (name + code)
 *   hsCode          → curated HS headings (code + description + keyword aliases)
 *   product         → common import commodity keywords
 */

export type SuggestField = 'entryPort' | 'supplierCountry' | 'hsCode' | 'product';

/** A single autosuggest row. `value` fills the input; `label` is the primary
 *  line; `hint` is the muted secondary line (state, ISO code, HS code). */
export interface Suggestion {
  value: string;
  label: string;
  hint?: string;
}

/* ── US entry ports (name + state) ──────────────────────────────────────────*/
export interface UsPort {
  name: string;
  state: string;
}

export const US_PORTS: UsPort[] = [
  { name: 'Los Angeles', state: 'CA' },
  { name: 'Long Beach', state: 'CA' },
  { name: 'Oakland', state: 'CA' },
  { name: 'San Francisco', state: 'CA' },
  { name: 'San Diego', state: 'CA' },
  { name: 'Port Hueneme', state: 'CA' },
  { name: 'Seattle', state: 'WA' },
  { name: 'Tacoma', state: 'WA' },
  { name: 'Newark', state: 'NJ' },
  { name: 'New York', state: 'NY' },
  { name: 'Elizabeth', state: 'NJ' },
  { name: 'Philadelphia', state: 'PA' },
  { name: 'Baltimore', state: 'MD' },
  { name: 'Norfolk', state: 'VA' },
  { name: 'Richmond', state: 'VA' },
  { name: 'Charleston', state: 'SC' },
  { name: 'Savannah', state: 'GA' },
  { name: 'Brunswick', state: 'GA' },
  { name: 'Jacksonville', state: 'FL' },
  { name: 'Miami', state: 'FL' },
  { name: 'Port Everglades', state: 'FL' },
  { name: 'Tampa', state: 'FL' },
  { name: 'Houston', state: 'TX' },
  { name: 'Galveston', state: 'TX' },
  { name: 'Freeport', state: 'TX' },
  { name: 'Corpus Christi', state: 'TX' },
  { name: 'New Orleans', state: 'LA' },
  { name: 'Baton Rouge', state: 'LA' },
  { name: 'Gulfport', state: 'MS' },
  { name: 'Mobile', state: 'AL' },
  { name: 'Boston', state: 'MA' },
  { name: 'Wilmington', state: 'DE' },
  { name: 'Wilmington', state: 'NC' },
  { name: 'Portland', state: 'OR' },
  { name: 'Portland', state: 'ME' },
  { name: 'Anchorage', state: 'AK' },
  { name: 'Honolulu', state: 'HI' },
  { name: 'Chicago', state: 'IL' },
  { name: 'Detroit', state: 'MI' },
  { name: 'Cleveland', state: 'OH' },
  { name: 'Duluth', state: 'MN' },
  { name: 'Laredo', state: 'TX' },
  { name: 'El Paso', state: 'TX' },
  { name: 'Nogales', state: 'AZ' },
  { name: 'Otay Mesa', state: 'CA' },
  { name: 'Buffalo', state: 'NY' },
  { name: 'Detroit', state: 'MI' },
];

/* ── ISO countries (name + alpha-2 code) — supplier origin ──────────────────*/
export interface IsoCountry {
  name: string;
  code: string;
}

export const ISO_COUNTRIES: IsoCountry[] = [
  { name: 'Afghanistan', code: 'AF' }, { name: 'Albania', code: 'AL' },
  { name: 'Algeria', code: 'DZ' }, { name: 'Argentina', code: 'AR' },
  { name: 'Armenia', code: 'AM' }, { name: 'Australia', code: 'AU' },
  { name: 'Austria', code: 'AT' }, { name: 'Azerbaijan', code: 'AZ' },
  { name: 'Bahrain', code: 'BH' }, { name: 'Bangladesh', code: 'BD' },
  { name: 'Belarus', code: 'BY' }, { name: 'Belgium', code: 'BE' },
  { name: 'Bolivia', code: 'BO' }, { name: 'Bosnia and Herzegovina', code: 'BA' },
  { name: 'Brazil', code: 'BR' }, { name: 'Bulgaria', code: 'BG' },
  { name: 'Cambodia', code: 'KH' }, { name: 'Cameroon', code: 'CM' },
  { name: 'Canada', code: 'CA' }, { name: 'Chile', code: 'CL' },
  { name: 'China', code: 'CN' }, { name: 'Colombia', code: 'CO' },
  { name: 'Costa Rica', code: 'CR' }, { name: 'Croatia', code: 'HR' },
  { name: 'Czech Republic', code: 'CZ' }, { name: 'Denmark', code: 'DK' },
  { name: 'Dominican Republic', code: 'DO' }, { name: 'Ecuador', code: 'EC' },
  { name: 'Egypt', code: 'EG' }, { name: 'El Salvador', code: 'SV' },
  { name: 'Estonia', code: 'EE' }, { name: 'Ethiopia', code: 'ET' },
  { name: 'Finland', code: 'FI' }, { name: 'France', code: 'FR' },
  { name: 'Georgia', code: 'GE' }, { name: 'Germany', code: 'DE' },
  { name: 'Ghana', code: 'GH' }, { name: 'Greece', code: 'GR' },
  { name: 'Guatemala', code: 'GT' }, { name: 'Honduras', code: 'HN' },
  { name: 'Hong Kong', code: 'HK' }, { name: 'Hungary', code: 'HU' },
  { name: 'Iceland', code: 'IS' }, { name: 'India', code: 'IN' },
  { name: 'Indonesia', code: 'ID' }, { name: 'Iran', code: 'IR' },
  { name: 'Iraq', code: 'IQ' }, { name: 'Ireland', code: 'IE' },
  { name: 'Israel', code: 'IL' }, { name: 'Italy', code: 'IT' },
  { name: 'Ivory Coast', code: 'CI' }, { name: 'Jamaica', code: 'JM' },
  { name: 'Japan', code: 'JP' }, { name: 'Jordan', code: 'JO' },
  { name: 'Kazakhstan', code: 'KZ' }, { name: 'Kenya', code: 'KE' },
  { name: 'Kuwait', code: 'KW' }, { name: 'Laos', code: 'LA' },
  { name: 'Latvia', code: 'LV' }, { name: 'Lebanon', code: 'LB' },
  { name: 'Lithuania', code: 'LT' }, { name: 'Luxembourg', code: 'LU' },
  { name: 'Malaysia', code: 'MY' }, { name: 'Malta', code: 'MT' },
  { name: 'Mexico', code: 'MX' }, { name: 'Moldova', code: 'MD' },
  { name: 'Mongolia', code: 'MN' }, { name: 'Morocco', code: 'MA' },
  { name: 'Myanmar', code: 'MM' }, { name: 'Nepal', code: 'NP' },
  { name: 'Netherlands', code: 'NL' }, { name: 'New Zealand', code: 'NZ' },
  { name: 'Nicaragua', code: 'NI' }, { name: 'Nigeria', code: 'NG' },
  { name: 'Norway', code: 'NO' }, { name: 'Oman', code: 'OM' },
  { name: 'Pakistan', code: 'PK' }, { name: 'Panama', code: 'PA' },
  { name: 'Paraguay', code: 'PY' }, { name: 'Peru', code: 'PE' },
  { name: 'Philippines', code: 'PH' }, { name: 'Poland', code: 'PL' },
  { name: 'Portugal', code: 'PT' }, { name: 'Qatar', code: 'QA' },
  { name: 'Romania', code: 'RO' }, { name: 'Russia', code: 'RU' },
  { name: 'Saudi Arabia', code: 'SA' }, { name: 'Serbia', code: 'RS' },
  { name: 'Singapore', code: 'SG' }, { name: 'Slovakia', code: 'SK' },
  { name: 'Slovenia', code: 'SI' }, { name: 'South Africa', code: 'ZA' },
  { name: 'South Korea', code: 'KR' }, { name: 'Spain', code: 'ES' },
  { name: 'Sri Lanka', code: 'LK' }, { name: 'Sweden', code: 'SE' },
  { name: 'Switzerland', code: 'CH' }, { name: 'Taiwan', code: 'TW' },
  { name: 'Tanzania', code: 'TZ' }, { name: 'Thailand', code: 'TH' },
  { name: 'Tunisia', code: 'TN' }, { name: 'Turkey', code: 'TR' },
  { name: 'Ukraine', code: 'UA' }, { name: 'United Arab Emirates', code: 'AE' },
  { name: 'United Kingdom', code: 'GB' }, { name: 'United States', code: 'US' },
  { name: 'Uruguay', code: 'UY' }, { name: 'Uzbekistan', code: 'UZ' },
  { name: 'Venezuela', code: 'VE' }, { name: 'Vietnam', code: 'VN' },
  { name: 'Yemen', code: 'YE' }, { name: 'Zambia', code: 'ZM' },
  { name: 'Zimbabwe', code: 'ZW' },
];

/* ── HS headings (4-digit code + description + keyword aliases) ──────────────
 * Curated to the headings that dominate US consumer/industrial imports. The
 * aliases let a user type a plain-English commodity ("sneakers", "sofa") and
 * land on the right heading. */
export interface HsHeading {
  code: string;
  description: string;
  aliases?: string[];
}

export const HS_HEADINGS: HsHeading[] = [
  { code: '0901', description: 'Coffee', aliases: ['coffee', 'espresso', 'coffee beans'] },
  { code: '0902', description: 'Tea', aliases: ['tea', 'green tea', 'black tea'] },
  { code: '0904', description: 'Pepper & spices', aliases: ['pepper', 'spices', 'chili'] },
  { code: '0805', description: 'Citrus fruit', aliases: ['oranges', 'lemons', 'citrus'] },
  { code: '0806', description: 'Grapes', aliases: ['grapes', 'raisins'] },
  { code: '0813', description: 'Dried fruit', aliases: ['dried fruit', 'dates', 'figs'] },
  { code: '0802', description: 'Nuts', aliases: ['almonds', 'cashews', 'walnuts', 'nuts'] },
  { code: '1006', description: 'Rice', aliases: ['rice', 'basmati', 'jasmine rice'] },
  { code: '1509', description: 'Olive oil', aliases: ['olive oil'] },
  { code: '1704', description: 'Sugar confectionery', aliases: ['candy', 'confectionery', 'gummies'] },
  { code: '1806', description: 'Chocolate', aliases: ['chocolate', 'cocoa'] },
  { code: '1905', description: 'Baked goods', aliases: ['biscuits', 'cookies', 'crackers', 'bread'] },
  { code: '2009', description: 'Fruit juices', aliases: ['juice', 'fruit juice'] },
  { code: '2103', description: 'Sauces & condiments', aliases: ['sauce', 'ketchup', 'soy sauce'] },
  { code: '2106', description: 'Food preparations', aliases: ['supplements', 'protein powder', 'food prep'] },
  { code: '2202', description: 'Beverages, soft drinks', aliases: ['soda', 'energy drink', 'soft drinks'] },
  { code: '2204', description: 'Wine', aliases: ['wine', 'red wine', 'white wine'] },
  { code: '2208', description: 'Spirits & liquor', aliases: ['vodka', 'whiskey', 'tequila', 'liquor', 'spirits'] },
  { code: '2401', description: 'Tobacco', aliases: ['tobacco', 'cigar'] },
  { code: '2523', description: 'Cement', aliases: ['cement', 'portland cement'] },
  { code: '2710', description: 'Petroleum oils', aliases: ['petroleum', 'lubricants', 'motor oil'] },
  { code: '2818', description: 'Aluminum oxide / abrasives', aliases: ['abrasives', 'alumina'] },
  { code: '2836', description: 'Carbonates', aliases: ['baking soda', 'soda ash', 'carbonate'] },
  { code: '2915', description: 'Organic acids', aliases: ['acetic acid', 'organic acid'] },
  { code: '3004', description: 'Medicaments', aliases: ['medicine', 'pharma', 'pharmaceuticals', 'tablets'] },
  { code: '3208', description: 'Paints & varnishes', aliases: ['paint', 'coating', 'varnish'] },
  { code: '3304', description: 'Cosmetics & makeup', aliases: ['cosmetics', 'makeup', 'skincare', 'lipstick'] },
  { code: '3305', description: 'Hair preparations', aliases: ['shampoo', 'hair care'] },
  { code: '3306', description: 'Oral / dental hygiene', aliases: ['toothpaste', 'dental'] },
  { code: '3401', description: 'Soap', aliases: ['soap', 'bar soap'] },
  { code: '3402', description: 'Detergents & cleaners', aliases: ['detergent', 'cleaner', 'surfactant'] },
  { code: '3506', description: 'Adhesives & glue', aliases: ['glue', 'adhesive'] },
  { code: '3808', description: 'Pesticides', aliases: ['pesticide', 'insecticide', 'herbicide'] },
  { code: '3824', description: 'Chemical preparations', aliases: ['chemicals', 'chemical prep'] },
  { code: '3901', description: 'Polyethylene / polymers', aliases: ['polyethylene', 'plastic resin', 'polymer'] },
  { code: '3920', description: 'Plastic sheets & film', aliases: ['plastic film', 'plastic sheet'] },
  { code: '3923', description: 'Plastic packaging', aliases: ['plastic bags', 'plastic packaging', 'bottles'] },
  { code: '3924', description: 'Plastic tableware & kitchenware', aliases: ['plastic tableware', 'plastic kitchenware'] },
  { code: '3926', description: 'Other plastic articles', aliases: ['plastic articles', 'plastic parts'] },
  { code: '4011', description: 'New rubber tires', aliases: ['tires', 'tyres', 'car tires'] },
  { code: '4016', description: 'Rubber articles', aliases: ['rubber parts', 'rubber gaskets'] },
  { code: '4202', description: 'Bags, luggage & cases', aliases: ['handbags', 'luggage', 'backpacks', 'wallets', 'suitcase'] },
  { code: '4203', description: 'Leather apparel & accessories', aliases: ['leather jacket', 'leather gloves', 'belt'] },
  { code: '4407', description: 'Sawn wood / lumber', aliases: ['lumber', 'sawn wood', 'timber'] },
  { code: '4412', description: 'Plywood', aliases: ['plywood', 'veneer'] },
  { code: '4418', description: 'Builders joinery / wood', aliases: ['doors', 'wood flooring', 'joinery'] },
  { code: '4419', description: 'Wood tableware & kitchenware', aliases: ['cutting board', 'wood kitchenware'] },
  { code: '4421', description: 'Other wood articles', aliases: ['wood articles', 'hangers'] },
  { code: '4802', description: 'Paper & paperboard', aliases: ['paper', 'printing paper'] },
  { code: '4819', description: 'Cartons & boxes', aliases: ['cartons', 'boxes', 'paper packaging'] },
  { code: '4820', description: 'Registers, notebooks & stationery', aliases: ['notebooks', 'stationery'] },
  { code: '4901', description: 'Printed books', aliases: ['books', 'printed books'] },
  { code: '5007', description: 'Silk fabric', aliases: ['silk'] },
  { code: '5208', description: 'Cotton fabric', aliases: ['cotton fabric', 'cotton textile'] },
  { code: '5407', description: 'Synthetic woven fabric', aliases: ['polyester fabric', 'synthetic fabric'] },
  { code: '5703', description: 'Carpets & rugs', aliases: ['rugs', 'carpet', 'area rug'] },
  { code: '6104', description: "Women's suits & dresses (knit)", aliases: ['dresses', 'womens apparel'] },
  { code: '6105', description: "Men's shirts (knit)", aliases: ['mens shirts', 'polo shirts'] },
  { code: '6109', description: 'T-shirts', aliases: ['t-shirts', 'tshirts', 'tees'] },
  { code: '6110', description: 'Sweaters & pullovers', aliases: ['sweaters', 'hoodies', 'pullovers'] },
  { code: '6203', description: "Men's suits & trousers (woven)", aliases: ['mens suits', 'trousers', 'pants'] },
  { code: '6204', description: "Women's suits & trousers (woven)", aliases: ['womens suits', 'blouses'] },
  { code: '6205', description: "Men's shirts (woven)", aliases: ['dress shirts'] },
  { code: '6403', description: 'Leather footwear', aliases: ['leather shoes', 'dress shoes', 'boots'] },
  { code: '6404', description: 'Textile footwear / sneakers', aliases: ['sneakers', 'trainers', 'canvas shoes', 'sport shoes'] },
  { code: '6506', description: 'Headgear / hats', aliases: ['hats', 'caps', 'helmets'] },
  { code: '6802', description: 'Worked stone (granite, marble)', aliases: ['granite', 'marble', 'stone', 'countertops'] },
  { code: '6907', description: 'Ceramic tiles', aliases: ['tiles', 'ceramic tile', 'porcelain tile'] },
  { code: '6911', description: 'Porcelain tableware', aliases: ['porcelain', 'dinnerware', 'china'] },
  { code: '6912', description: 'Ceramic tableware', aliases: ['ceramic tableware', 'mugs', 'plates'] },
  { code: '7010', description: 'Glass bottles & jars', aliases: ['glass bottles', 'jars'] },
  { code: '7013', description: 'Glassware', aliases: ['glassware', 'drinking glasses', 'vases'] },
  { code: '7113', description: 'Jewelry (precious metal)', aliases: ['jewelry', 'gold jewelry', 'rings'] },
  { code: '7117', description: 'Imitation jewelry', aliases: ['costume jewelry', 'fashion jewelry'] },
  { code: '7210', description: 'Flat-rolled steel, coated', aliases: ['galvanized steel', 'coated steel'] },
  { code: '7308', description: 'Steel structures', aliases: ['steel structures', 'steel frames'] },
  { code: '7318', description: 'Screws, bolts & fasteners', aliases: ['screws', 'bolts', 'nuts', 'fasteners'] },
  { code: '7323', description: 'Steel kitchen / household articles', aliases: ['cookware', 'stainless steel pots'] },
  { code: '7326', description: 'Other steel articles', aliases: ['steel parts', 'metal brackets'] },
  { code: '7419', description: 'Copper articles', aliases: ['copper', 'copper fittings'] },
  { code: '7616', description: 'Aluminum articles', aliases: ['aluminum parts', 'aluminium'] },
  { code: '8215', description: 'Cutlery / flatware', aliases: ['cutlery', 'flatware', 'knives forks'] },
  { code: '8302', description: 'Base metal mountings & fittings', aliases: ['hinges', 'hardware fittings', 'brackets'] },
  { code: '8407', description: 'Spark-ignition engines', aliases: ['engines', 'gasoline engine'] },
  { code: '8409', description: 'Engine parts', aliases: ['engine parts', 'pistons'] },
  { code: '8413', description: 'Pumps', aliases: ['pumps', 'water pump'] },
  { code: '8414', description: 'Air / vacuum pumps, compressors, fans', aliases: ['compressor', 'fans', 'air pump'] },
  { code: '8415', description: 'Air conditioning machines', aliases: ['air conditioner', 'hvac', 'ac unit'] },
  { code: '8418', description: 'Refrigerators & freezers', aliases: ['refrigerator', 'fridge', 'freezer'] },
  { code: '8421', description: 'Filters / centrifuges', aliases: ['filters', 'water filter'] },
  { code: '8422', description: 'Dishwashing / packing machines', aliases: ['dishwasher', 'packing machine'] },
  { code: '8443', description: 'Printers & printing machinery', aliases: ['printer', 'printing machine'] },
  { code: '8450', description: 'Washing machines', aliases: ['washing machine', 'washer'] },
  { code: '8467', description: 'Power tools', aliases: ['power tools', 'drills', 'grinder'] },
  { code: '8471', description: 'Computers & data-processing', aliases: ['laptops', 'computers', 'servers'] },
  { code: '8473', description: 'Computer parts & accessories', aliases: ['computer parts', 'keyboard', 'mouse'] },
  { code: '8481', description: 'Valves & taps', aliases: ['valves', 'faucets', 'taps'] },
  { code: '8482', description: 'Ball & roller bearings', aliases: ['bearings', 'ball bearings'] },
  { code: '8501', description: 'Electric motors & generators', aliases: ['electric motor', 'generator'] },
  { code: '8504', description: 'Transformers & power supplies', aliases: ['transformer', 'power supply', 'adapter', 'charger'] },
  { code: '8506', description: 'Primary cells & batteries', aliases: ['batteries', 'aa battery'] },
  { code: '8507', description: 'Rechargeable batteries', aliases: ['lithium battery', 'rechargeable battery'] },
  { code: '8508', description: 'Vacuum cleaners', aliases: ['vacuum cleaner'] },
  { code: '8516', description: 'Electric heaters & appliances', aliases: ['heater', 'toaster', 'kettle', 'hair dryer'] },
  { code: '8517', description: 'Phones & networking gear', aliases: ['cell phones', 'smartphones', 'routers', 'telephone'] },
  { code: '8518', description: 'Microphones, speakers & headphones', aliases: ['speakers', 'headphones', 'earbuds', 'microphone'] },
  { code: '8523', description: 'Media / storage discs', aliases: ['usb drives', 'memory cards', 'ssd'] },
  { code: '8528', description: 'Monitors, TVs & projectors', aliases: ['tv', 'television', 'monitor', 'projector'] },
  { code: '8536', description: 'Electrical switches & connectors', aliases: ['switches', 'connectors', 'plugs', 'sockets'] },
  { code: '8539', description: 'Lamps & lighting bulbs', aliases: ['bulbs', 'led bulbs', 'light bulbs'] },
  { code: '8544', description: 'Insulated wire & cable', aliases: ['wire', 'cable', 'usb cable', 'wiring'] },
  { code: '8703', description: 'Passenger vehicles', aliases: ['cars', 'passenger cars', 'automobiles'] },
  { code: '8708', description: 'Auto parts & accessories', aliases: ['auto parts', 'car parts', 'brake pads'] },
  { code: '8711', description: 'Motorcycles', aliases: ['motorcycles', 'scooters', 'mopeds'] },
  { code: '8712', description: 'Bicycles', aliases: ['bicycles', 'bikes'] },
  { code: '8714', description: 'Bicycle / motorcycle parts', aliases: ['bike parts', 'bicycle parts'] },
  { code: '9018', description: 'Medical instruments', aliases: ['medical devices', 'medical instruments', 'syringes'] },
  { code: '9021', description: 'Orthopedic / medical appliances', aliases: ['orthopedic', 'hearing aids', 'braces'] },
  { code: '9027', description: 'Lab / analysis instruments', aliases: ['lab instruments', 'analyzers'] },
  { code: '9031', description: 'Measuring instruments', aliases: ['measuring instruments', 'gauges'] },
  { code: '9101', description: 'Watches (precious metal)', aliases: ['luxury watches'] },
  { code: '9102', description: 'Watches', aliases: ['watches', 'wristwatch'] },
  { code: '9401', description: 'Seats & chairs', aliases: ['chairs', 'office chair', 'seats', 'sofa', 'couch'] },
  { code: '9403', description: 'Furniture & home furnishings', aliases: ['furniture', 'tables', 'desk', 'cabinets', 'shelving', 'home decor', 'furnishings'] },
  { code: '9404', description: 'Mattresses & bedding', aliases: ['mattress', 'bedding', 'pillows', 'comforter'] },
  { code: '9405', description: 'Lamps & lighting fixtures', aliases: ['lighting', 'lamps', 'led lighting', 'light fixtures', 'chandelier'] },
  { code: '9503', description: 'Toys', aliases: ['toys', 'dolls', 'action figures', 'puzzles'] },
  { code: '9504', description: 'Games & game consoles', aliases: ['games', 'game console', 'board games'] },
  { code: '9506', description: 'Sports & fitness equipment', aliases: ['sports equipment', 'gym equipment', 'fitness', 'dumbbells'] },
  { code: '9603', description: 'Brooms & brushes', aliases: ['brooms', 'brushes', 'toothbrush'] },
  { code: '9608', description: 'Pens & writing instruments', aliases: ['pens', 'markers', 'writing'] },
  { code: '9613', description: 'Lighters', aliases: ['lighters'] },
  { code: '9617', description: 'Vacuum flasks / thermos', aliases: ['thermos', 'vacuum flask', 'water bottle'] },
];

/* ── Common commodity keywords (product-name field) ─────────────────────────
 * A broad, plain-English list drawn from the HS descriptions above plus common
 * trade terms — so the "Product / keywords" field also gets typeahead. */
export const COMMODITY_KEYWORDS: string[] = [
  'apparel', 'auto parts', 'automotive', 'backpacks', 'bags', 'bamboo products',
  'batteries', 'bearings', 'bicycles', 'bluetooth speakers', 'candles', 'candy',
  'cast iron', 'ceramics', 'chargers', 'chemicals', 'coffee', 'consumer electronics',
  'cookware', 'copper', 'cosmetics', 'cotton', 'cutlery', 'detergent', 'dinnerware',
  'doors', 'electronics', 'fasteners', 'flooring', 'footwear', 'furniture',
  'garden tools', 'glassware', 'gloves', 'granite', 'handbags', 'hand tools',
  'hardware', 'headphones', 'home decor', 'houseware', 'jewelry', 'kitchenware',
  'lamps', 'led lighting', 'leather goods', 'lighting', 'luggage', 'machinery',
  'marble', 'mattresses', 'medical devices', 'motorcycle parts', 'notebooks',
  'office furniture', 'packaging', 'paint', 'paper products', 'patio furniture',
  'pet supplies', 'pharmaceuticals', 'plastic products', 'plumbing fixtures',
  'plywood', 'power tools', 'pumps', 'rubber products', 'rugs', 'seafood',
  'shoes', 'skincare', 'solar panels', 'spices', 'sporting goods', 'stainless steel',
  'stationery', 'steel products', 'stone', 'sunglasses', 'tableware', 'textiles',
  'tiles', 'tires', 'tools', 'toys', 'valves', 'wine', 'wire and cable', 'wood products',
];

/* ── Matcher ────────────────────────────────────────────────────────────────*/
const norm = (s: string): string => s.toLowerCase().trim();

/** Filter the reference list for `field` against query `q`. Case-insensitive,
 *  substring/prefix matching; capped at `limit` rows. Empty query returns the
 *  first `limit` rows so a focus with no text still shows options. */
export function suggestImporterField(field: SuggestField, q: string, limit = 8): Suggestion[] {
  const query = norm(q);
  const cap = Math.max(1, Math.min(limit, 25));

  if (field === 'entryPort') {
    const rows = query
      ? US_PORTS.filter((p) => norm(p.name).includes(query) || norm(p.state) === query)
      : US_PORTS;
    // Prefix matches first (a leading-letter query should surface "Los Angeles"
    // ahead of "New Orleans").
    const ranked = query
      ? [...rows].sort((a, b) => Number(norm(b.name).startsWith(query)) - Number(norm(a.name).startsWith(query)))
      : rows;
    return ranked.slice(0, cap).map((p) => ({ value: p.name, label: p.name, hint: p.state }));
  }

  if (field === 'supplierCountry') {
    const rows = query
      ? ISO_COUNTRIES.filter((c) => norm(c.name).includes(query) || norm(c.code) === query)
      : ISO_COUNTRIES;
    const ranked = query
      ? [...rows].sort((a, b) => Number(norm(b.name).startsWith(query)) - Number(norm(a.name).startsWith(query)))
      : rows;
    return ranked.slice(0, cap).map((c) => ({ value: c.name, label: c.name, hint: c.code }));
  }

  if (field === 'hsCode') {
    if (!query) return HS_HEADINGS.slice(0, cap).map((h) => ({ value: h.code, label: h.description, hint: h.code }));
    const scored: { h: HsHeading; score: number }[] = [];
    for (const h of HS_HEADINGS) {
      const desc = norm(h.description);
      let score = -1;
      if (h.code.startsWith(query)) score = 100; // typing a code
      else if (desc.startsWith(query)) score = 60;
      else if (desc.includes(query)) score = 40;
      else if (h.aliases?.some((a) => norm(a).startsWith(query))) score = 30;
      else if (h.aliases?.some((a) => norm(a).includes(query))) score = 20;
      if (score >= 0) scored.push({ h, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, cap).map(({ h }) => ({ value: h.code, label: h.description, hint: h.code }));
  }

  // product
  const rows = query ? COMMODITY_KEYWORDS.filter((k) => norm(k).includes(query)) : COMMODITY_KEYWORDS;
  const ranked = query
    ? [...rows].sort((a, b) => Number(norm(b).startsWith(query)) - Number(norm(a).startsWith(query)))
    : rows;
  return ranked.slice(0, cap).map((k) => ({ value: k, label: k }));
}

export const SUGGEST_FIELDS: readonly SuggestField[] = ['entryPort', 'supplierCountry', 'hsCode', 'product'];

export function isSuggestField(v: unknown): v is SuggestField {
  return typeof v === 'string' && (SUGGEST_FIELDS as readonly string[]).includes(v);
}
