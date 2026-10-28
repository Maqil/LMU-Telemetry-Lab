/**
 * Brand identification for a car string.
 *
 * The sim hands us whatever it has: a real model ("Ferrari 296 LMGT3"), an ACC
 * short name ("720S GT3"), a raw id ("mclaren_720s_gt3_evo") -- or, for custom
 * liveries, a team/entry name with no car in it at all ("ORT by TF #25"). Only
 * the first three are identifiable, so an unmatched string returns null rather
 * than a guessed logo path that 404s.
 */
interface CarBrand { key: string; label: string; logo: string }

const BRAND_RULES: { brand: CarBrand; match: RegExp }[] = ([
    ['mclaren', 'McLaren', 'mclaren', /mclaren|720s|650s|570s/],
    ['ferrari', 'Ferrari', 'ferrari', /ferrari|499p|\b296\b|\b488\b|\b458\b|\b812\b/],
    ['porsche', 'Porsche', 'porsche', /porsche|\b911\b|\b99[12]\b|\b963\b|\b718\b|cayman/],
    ['lamborghini', 'Lamborghini', 'lamborghini', /lamborghini|huracan|sc63/],
    ['bmw', 'BMW', 'bmw', /\bbmw\b|m hybrid|\bm[2468]\b/],
    ['aston_martin', 'Aston Martin', 'aston_martin', /aston|vantage|\bamr\b|valkyrie/],
    ['mercedes', 'Mercedes-AMG', 'mercedes', /mercedes|\bamg\b/],
    ['corvette', 'Chevrolet', 'corvette', /corvette|chevrolet|camaro/],
    ['toyota', 'Toyota', 'toyota', /toyota|[gt]r010/],
    ['cadillac', 'Cadillac', 'cadillac', /cadillac|v-series/],
    ['peugeot', 'Peugeot', 'peugeot', /peugeot|9x8/],
    ['alpine', 'Alpine', 'alpine', /alpine|a110|a424/],
    ['lexus', 'Lexus', 'lexus', /lexus|\brc ?f\b/],
    ['genesis', 'Genesis', 'genesis', /genesis|gmr-001/],
    ['adess', 'Adess', 'adess', /adess/],
    ['ford', 'Ford', 'ford', /\bford\b|mustang/],
    ['isotta_fraschini', 'Isotta Fraschini', 'isotta_fraschini', /isotta/],
    ['glickenhaus', 'Glickenhaus', 'glickenhaus', /glickenhaus/],
    ['vanwall', 'Vanwall', 'vanwall', /vanwall/],
    ['oreca', 'ORECA', 'oreca', /oreca/],
    ['ginetta', 'Ginetta', 'ginetta', /ginetta|\bg\d{2}\b/],
    ['ligier', 'Ligier', 'ligier', /ligier|\bjs ?p3/],
    ['duqueine', 'Duqueine', 'duqueine', /duqueine|\bd09\b/],
    ['audi', 'Audi', 'audi', /audi|\br8\b/],
    ['honda', 'Honda', 'honda', /honda|acura|\bnsx\b/],
    ['nissan', 'Nissan', 'nissan', /nissan|gt-?r\b|nismo/],
    ['bentley', 'Bentley', 'bentley', /bentley|continental/],
    ['jaguar', 'Jaguar', 'jaguar', /jaguar|emil frey/],
    ['ktm', 'KTM', 'ktm', /ktm|x-?bow/],
    ['maserati', 'Maserati', 'maserati', /maserati|mc20/],
] as [string, string, string, RegExp][]).map(([key, label, logo, match]) => ({ brand: { key, label, logo }, match }));

const BRAND_BY_KEY = new Map(BRAND_RULES.map(r => [r.brand.key, r.brand]));

/**
 * Entry-name rules, for the custom liveries that name the team instead of the
 * car ("Garage 59 2026 #10", "Proton Competition #16"). Nothing in those
 * strings identifies a manufacturer, so the team has to, and a team's car
 * depends on the class it entered -- Proton runs a Ford in LMGT3 and a Porsche
 * in GTE -- and occasionally on the season. Rules are tried in order; the first
 * whose team matches, and whose class / year test passes when it has one, wins.
 */
const TEAM_RULES: { team: RegExp; brand: string; cls?: RegExp; since?: number; before?: number }[] = [
    // Same team, different car per class.
    { team: /\bproton\b/, cls: /GT3/, brand: 'ford' },
    { team: /\bproton\b|\bdempsey\b/, brand: 'porsche' },
    { team: /\bort by tf\b/, brand: 'aston_martin' },
    { team: /\btf sport\b/, cls: /GTE/, brand: 'aston_martin' },
    { team: /\btf sport\b/, brand: 'corvette' },
    { team: /\biron lynx\b/, cls: /GT3/, since: 2025, brand: 'mercedes' },
    { team: /\biron lynx\b/, cls: /GT3/, brand: 'lamborghini' },
    { team: /\bvector sport\b/, cls: /HYPER|LMH|LMDH/, brand: 'isotta_fraschini' },
    { team: /\bjota\b/, cls: /HYPER|LMH|LMDH/, since: 2025, brand: 'cadillac' },
    { team: /\bjota\b/, cls: /HYPER|LMH|LMDH/, brand: 'porsche' },

    // McLaren
    { team: /\bgarage 59\b|\bunited autosports\b|\binception\b|\bpfaff\b/, brand: 'mclaren' },
    // BMW
    { team: /\bwrt\b|\bwalkenhorst\b|\browe\b|\bteam rll\b|\bst racing\b/, brand: 'bmw' },
    // Ferrari
    { team: /\baf cors[ae]\b|\bkessel\b|\bspirit of race\b|\bjmw\b|\bwtm\b|\bformula racing\b|\brichard mille\b/, brand: 'ferrari' },
    // Porsche
    { team: /\bmanthey\b|\bpurerxcing\b|\bproject 1\b|\bao racing\b|\biron dames\b|\bgr racing\b|\bherberth\b|\bdinamic\b|\bpenske\b|\bg-drive\b/, brand: 'porsche' },
    // Aston Martin
    { team: /\bd'?station\b|\bnorthwest\b|\bheart of racing\b|\bracing spirit of l[ée]man\b|\bbeechdean\b|\bthor\b|\bprodrive\b/, brand: 'aston_martin' },
    // Mercedes-AMG
    { team: /\bwinward\b|\bal manar\b|\bgetspeed\b/, brand: 'mercedes' },
    // Lamborghini
    { team: /\bgrasser\b|\bvsr\b|\bleipert\b/, brand: 'lamborghini' },
    // Lexus / Chevrolet / Cadillac / Alpine
    { team: /\bakkodis\b/, brand: 'lexus' },
    { team: /\bpratt\b|\bcorvette racing\b/, brand: 'corvette' },
    { team: /\bwhelen\b|\baction express\b/, brand: 'cadillac' },
    { team: /\bsignatech\b/, brand: 'alpine' },
];

/** The season in an entry name ("Team WRT 2025 #46" -> 2025), when it carries one. */
const entryYear = (text: string): number | null => {
    const hit = text.match(/\b(20\d{2})\b/);
    return hit ? Number(hit[1]) : null;
};

/**
 * The brand behind a car string. Tried in order: a manufacturer named in the
 * string itself, then the team that entered it, then the class when the class
 * only ever runs one car (LMU's LMP2 field is ORECA 07 throughout -- and that
 * check comes first, so "Duqueine Team" in LMP2 isn't read as an LMP3 Duqueine).
 */
export const getCarBrand = (modelName: string = '', carClass: string = ''): CarBrand | null => {
    const lower = (modelName || '').toLowerCase().replace(/_/g, ' ');
    if (!lower.trim()) return null;
    const cls = (carClass || '').toUpperCase();

    if (/LMP2/.test(cls)) return BRAND_BY_KEY.get('oreca') ?? null;

    const named = BRAND_RULES.find(r => r.match.test(lower))?.brand;
    if (named) return named;

    const year = entryYear(lower);
    const team = TEAM_RULES.find(r =>
        r.team.test(lower)
        && (!r.cls || r.cls.test(cls))
        && (r.since === undefined || (year !== null && year >= r.since))
        && (r.before === undefined || (year !== null && year < r.before)));
    return team ? BRAND_BY_KEY.get(team.brand) ?? null : null;
};

/** Logo path for a car string, or null when no brand could be identified. */
export const getBrandLogoPath = (modelName: string = '', carClass: string = ''): string | null => {
    const brand = getCarBrand(modelName, carClass);
    return brand ? `/logos/${brand.logo}.png` : null;
};

/**
 * Class silhouette, the last-resort mark for an entry no rule can pin to a
 * manufacturer (one-make challenge liveries, say): the row still reads as a car
 * of the right class instead of an empty slot.
 */
export const getClassGlyphPath = (carClass: string = ''): string | null => {
    const c = (carClass || '').toUpperCase();
    if (/HYPER|LMDH|LMH/.test(c)) return '/hyper.png';
    if (/LMP/.test(c)) return '/lmp.png';
    if (/GTE/.test(c)) return '/gte.png';
    if (/GT3|GT4/.test(c)) return '/gt3.png';
    return null;
};

/** Display name for a car string, trimmed to the brand ("Ferrari 296 LMGT3" -> "Ferrari"). */
export const getCarBrandLabel = (modelName: string = '', carClass: string = ''): string | null =>
    getCarBrand(modelName, carClass)?.label ?? null;

/**
 * Shortest useful name for a car: the brand when we can identify one, otherwise
 * the entry name with the livery noise (year, car number) stripped out.
 */
export const getCompactCarName = (modelName: string = '', carClass: string = ''): string | null => {
    const brand = getCarBrandLabel(modelName, carClass);
    if (brand) return brand;
    const cleaned = (modelName || '')
        .replace(/#\s*\d+/g, '')
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || null;
};

export const getClassColor = (cls: string = '') => {
    const c = (cls || "").toUpperCase();
    if (c.includes('HYPER')) return 'border-amber-500/20 text-amber-400 bg-amber-500/10 shadow-[0_0_10px_rgba(251,191,36,0.1)]';
    if (c.includes('LMP2')) return 'border-sky-500/20 text-sky-400 bg-sky-500/10 shadow-[0_0_10px_rgba(56,189,248,0.1)]';
    if (c.includes('LMP3')) return 'border-violet-500/20 text-violet-400 bg-violet-500/10 shadow-[0_0_10px_rgba(167,139,250,0.1)]';
    // GTE keeps its own hue -- sharing emerald with GT3 made the two classes
    // indistinguishable wherever they sit side by side.
    if (c.includes('GTE')) return 'border-rose-500/20 text-rose-400 bg-rose-500/10 shadow-[0_0_10px_rgba(251,113,133,0.1)]';
    if (c.includes('GT4')) return 'border-cyan-500/20 text-cyan-400 bg-cyan-500/10 shadow-[0_0_10px_rgba(34,211,238,0.1)]';
    if (c.includes('GT3')) return 'border-emerald-500/20 text-emerald-400 bg-emerald-500/10 shadow-[0_0_10px_rgba(52,211,153,0.1)]';
    return 'border-gray-500/50 text-gray-400 bg-gray-500/10';
};

/**
 * The same class palette as a raw hex, for places that need to tint a border,
 * a rule or a glow rather than apply a utility class.
 */
export const getClassAccent = (cls: string = ''): string => {
    const c = (cls || '').toUpperCase();
    if (c.includes('HYPER') || c.includes('LMDH') || c.includes('LMH')) return '#fbbf24';
    if (c.includes('LMP2')) return '#38bdf8';
    if (c.includes('LMP3')) return '#a78bfa';
    if (c.includes('GTE')) return '#fb7185';
    if (c.includes('GT4')) return '#22d3ee';
    if (c.includes('GT3')) return '#34d399';
    return '#94a3b8';
};

export const CLASS_MODEL_NAMES: Record<string, string[]> = {
    'HYPERCAR': [
        'Genesis GMR-001',
        'Alpine A424',
        'Aston Martin Valkyrie LMH',
        'BMW M Hybrid V8',
        'BMW M Hybrid V8 Evo',
        'Cadillac V-Series.R',
        'Ferrari 499P',
        'Glickenhaus SCG 007',
        'Isotta Fraschini Tipo6',
        'Lamborghini SC63',
        'Peugeot 9X8',
        'Porsche 963',
        'Toyota GR010-Hybrid',
        'Toyota GR010',
        'Toyota TR010',
        'Vanwall Vandervell 680'
    ],
    'LMP2': [
        'ORECA 07'
    ],
    'LMP3': [
        'Adess AD25',
        'Duqueine D09 P3',
        'Ginetta G61-LT-P325 Evo',
        'Ligier JS P325'
    ],
    'LMGT3': [
        'Ford Mustang LMGT3',
        'Ford Mustang LMGT3 Evo',
        'McLaren 720S LMGT3 Evo',
        'Mercedes-AMG LMGT3',
        'BMW M4 LMGT3',
        'Aston Martin Vantage AMR LMGT3',
        'Chevrolet Corvette Z06 LMGT3.R',
        'Ferrari 296 LMGT3',
        'Ferrari 296 LMGT3 Evo',
        'Lamborghini Huracan LMGT3 Evo2',
        'Lexus RCF LMGT3',
        'Porsche 911 GT3 R LMGT3',
        'Porsche 911 GT3 R LMGT3 Evo'
    ],
    'GTE': [
        'Aston Martin Vantage AMR',
        'Corvette C8.R GTE',
        'Ferrari 488 GTE Evo',
        'Porsche 911 RSR-19'
    ]
};

/**
 * Buckets a raw sim class tag into a filterable category.
 *
 * The sims spell these differently -- LMU reports "Hyper", "LMP2_ELMS",
 * "LMP3", "GT3", "GTE"; ACC reports "GT3"/"GT4". Anything we don't recognise
 * keeps its own raw tag as a bucket rather than being folded into a wrong one,
 * so no session ever disappears from a class filter.
 *
 * Note: LMU's "Hyper" class is the WEC top class, which mixes LMDh and LMH
 * machinery -- the sim does not distinguish them, so neither do we.
 */
export interface CarClassBucket {
    key: string;
    label: string;
}

const CLASS_BUCKETS: { match: (c: string) => boolean; key: string; label: string }[] = [
    { match: c => c.includes('HYPER') || c.includes('LMDH') || c.includes('LMH'), key: 'HYPERCAR', label: 'Hypercar' },
    { match: c => c.includes('LMP2'), key: 'LMP2', label: 'LMP2' },
    { match: c => c.includes('LMP3'), key: 'LMP3', label: 'LMP3' },
    { match: c => c.includes('GTE'), key: 'GTE', label: 'GTE' },
    { match: c => c.includes('GT3'), key: 'GT3', label: 'GT3' },
    { match: c => c.includes('GT4'), key: 'GT4', label: 'GT4' },
];

/** Display order for the class filter; unknown tags sort after these, A-Z. */
export const CAR_CLASS_ORDER = ['HYPERCAR', 'LMP2', 'LMP3', 'GT3', 'GTE', 'GT4'];

/**
 * Column order for the record board, slowest class first: the GT columns lead,
 * then the prototypes, with Hypercar last. Unknown tags sort after these, A-Z.
 */
export const RECORD_CLASS_ORDER = ['GT3', 'GTE', 'GT4', 'LMP3', 'LMP2', 'HYPERCAR'];

export const getCarClassBucket = (cls?: string): CarClassBucket | null => {
    const c = (cls || '').toUpperCase();
    if (!c) return null;
    const hit = CLASS_BUCKETS.find(b => b.match(c));
    return hit ? { key: hit.key, label: hit.label } : { key: c, label: cls as string };
};

export const normalizeCarClass = (cls: string = ''): string => {
    const c = (cls || "").toUpperCase();
    if (c.includes('HYPER') || c.includes('LMDH') || c.includes('LMH')) return 'HYPERCAR';
    if (c.includes('LMP2')) return 'LMP2';
    if (c.includes('LMP3')) return 'LMP3';
    if (c.includes('GT3')) return 'LMGT3';
    if (c.includes('GTE')) return 'GTE';
    return 'HYPERCAR'; // default fallback
};
