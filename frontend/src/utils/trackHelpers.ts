/**
 * Utility for resolving track-related assets
 */

/**
 * Returns the path to the national flag image for a given country name.
 * The country name is provided by the backend metadata.
 */
export const getCountryFlagPath = (country?: string): string => {
  if (!country) return '';
  // The user has organized flags in /country_flag/ with "Country Name.png" format
  return `/country_flag/${country}.png`;
};

/**
 * ACC track roster. `key` matches the SVG filename in /public/acc-tracks/.
 * `keywords` are normalised match hints so we can resolve a session's raw
 * track name (which varies between sims) to the right map + metadata.
 */
export interface TrackInfo {
  key: string;
  name: string;
  country: string;
  keywords: string[];
}

export const ACC_TRACK_ROSTER: TrackInfo[] = [
  { key: 'austria', name: 'Red Bull Ring', country: 'Austria', keywords: ['red bull ring', 'red bull', 'spielberg', 'zeltweg'] },
  { key: 'bahrain', name: 'Bahrain International Circuit', country: 'Bahrain', keywords: ['bahrain'] },
  { key: 'barcelona', name: 'Circuit de Barcelona-Catalunya', country: 'Spain', keywords: ['barcelona', 'catalunya', 'montmelo'] },
  { key: 'bathurst', name: 'Mount Panorama (Bathurst)', country: 'Australia', keywords: ['bathurst', 'mount panorama', 'panorama'] },
  { key: 'brands-hatch', name: 'Brands Hatch', country: 'United Kingdom', keywords: ['brands hatch', 'brands'] },
  { key: 'cota', name: 'Circuit of the Americas', country: 'United States', keywords: ['circuit of the americas', 'americas', 'cota'] },
  { key: 'donington', name: 'Donington Park', country: 'United Kingdom', keywords: ['donington'] },
  { key: 'fuji', name: 'Fuji Speedway', country: 'Japan', keywords: ['fuji'] },
  { key: 'hungaroring', name: 'Hungaroring', country: 'Hungary', keywords: ['hungaroring'] },
  { key: 'imola', name: 'Autodromo Enzo e Dino Ferrari (Imola)', country: 'Italy', keywords: ['imola', 'enzo e dino', 'dino ferrari'] },
  { key: 'indianapolis', name: 'Indianapolis Motor Speedway', country: 'United States', keywords: ['indianapolis', 'indy'] },
  { key: 'interlagos', name: 'Interlagos (José Carlos Pace)', country: 'Brazil', keywords: ['interlagos', 'carlos pace', 'jose carlos'] },
  { key: 'kyalami', name: 'Kyalami Circuit', country: 'South Africa', keywords: ['kyalami'] },
  { key: 'laguna-seca', name: 'Laguna Seca', country: 'United States', keywords: ['laguna seca', 'laguna'] },
  { key: 'lemans', name: 'Circuit de la Sarthe (Le Mans)', country: 'France', keywords: ['le mans', 'lemans', 'sarthe'] },
  { key: 'losail', name: 'Losail International Circuit', country: 'Qatar', keywords: ['losail', 'lusail', 'qatar'] },
  { key: 'misano', name: 'Misano World Circuit', country: 'Italy', keywords: ['misano'] },
  { key: 'monza', name: 'Autodromo Nazionale Monza', country: 'Italy', keywords: ['monza'] },
  { key: 'NBR24h', name: 'Nürburgring Nordschleife', country: 'Germany', keywords: ['nordschleife', '24h', 'nurburgring 24', 'nurburgring nordschleife'] },
  { key: 'nurburgring', name: 'Nürburgring GP', country: 'Germany', keywords: ['nurburgring', 'nurburgring gp'] },
  { key: 'oulton', name: 'Oulton Park', country: 'United Kingdom', keywords: ['oulton'] },
  { key: 'paul-ricard', name: 'Circuit Paul Ricard', country: 'France', keywords: ['paul ricard', 'ricard', 'castellet'] },
  { key: 'portimao', name: 'Algarve International Circuit (Portimão)', country: 'Portugal', keywords: ['portimao', 'algarve'] },
  { key: 'sebring', name: 'Sebring International Raceway', country: 'United States', keywords: ['sebring'] },
  { key: 'silverstone', name: 'Silverstone Circuit', country: 'United Kingdom', keywords: ['silverstone'] },
  { key: 'snetterton', name: 'Snetterton Circuit', country: 'United Kingdom', keywords: ['snetterton'] },
  { key: 'spa', name: 'Circuit de Spa-Francorchamps', country: 'Belgium', keywords: ['spa', 'francorchamps'] },
  { key: 'suzuka', name: 'Suzuka Circuit', country: 'Japan', keywords: ['suzuka'] },
  { key: 'valencia', name: 'Circuit Ricardo Tormo (Valencia)', country: 'Spain', keywords: ['valencia', 'ricardo tormo'] },
  { key: 'watkins', name: 'Watkins Glen', country: 'United States', keywords: ['watkins'] },
  { key: 'zandvoort', name: 'Circuit Zandvoort', country: 'Netherlands', keywords: ['zandvoort'] },
  { key: 'zolder', name: 'Circuit Zolder', country: 'Belgium', keywords: ['zolder'] },
];

const normalizeTrack = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Resolve a raw track name to a roster entry using longest-keyword-wins so
 * more specific names (e.g. Nordschleife) beat generic ones (Nürburgring).
 */
export const matchTrack = (trackName?: string): TrackInfo | null => {
  if (!trackName) return null;
  const n = normalizeTrack(trackName);
  if (!n) return null;
  const tokens = new Set(n.split(' '));

  let best: TrackInfo | null = null;
  let bestLen = 0;
  for (const t of ACC_TRACK_ROSTER) {
    for (const kw of t.keywords) {
      const hit = kw.includes(' ') ? n.includes(kw) : tokens.has(kw);
      if (hit && kw.length > bestLen) {
        best = t;
        bestLen = kw.length;
      }
    }
  }
  return best;
};

/**
 * Path to the track outline SVG (in /public/acc-tracks/) for a track name,
 * or '' if no confident match. The SVG uses fill="currentColor", so render it
 * via a CSS mask to control the colour on dark backgrounds.
 */
export const getTrackImagePath = (trackName?: string): string => {
  const t = matchTrack(trackName);
  return t ? `/acc-tracks/${t.key}.svg` : '';
};
