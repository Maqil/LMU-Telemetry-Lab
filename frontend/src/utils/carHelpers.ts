export const getBrandLogoPath = (modelName: string) => {
    const lower = (modelName || "").toLowerCase();
    // Heuristic Brand Mapping
    if (lower.includes('mclaren')) return '/logos/mclaren.png';
    if (lower.includes('ferrari')) return '/logos/ferrari.png';
    if (lower.includes('porsche')) return '/logos/porsche.png';
    if (lower.includes('lamborghini')) return '/logos/lamborghini.png';
    if (lower.includes('bmw')) return '/logos/bmw.png';
    if (lower.includes('aston')) return '/logos/aston_martin.png';
    if (lower.includes('mercedes') || lower.includes('amg')) return '/logos/mercedes.png';
    if (lower.includes('corvette')) return '/logos/corvette.png';
    if (lower.includes('toyota')) return '/logos/toyota.png';
    if (lower.includes('cadillac')) return '/logos/cadillac.png';
    if (lower.includes('peugeot')) return '/logos/peugeot.png';
    if (lower.includes('alpine')) return '/logos/alpine.png';
    if (lower.includes('lexus')) return '/logos/lexus.png';
    if (lower.includes('genesis')) return '/logos/genesis.png';
    if (lower.includes('adess')) return '/logos/adess.png';
    if (lower.includes('ford') || lower.includes('mustang')) return '/logos/ford.png';
    if (lower.includes('isotta')) return '/logos/isotta_fraschini.png';
    if (lower.includes('glickenhaus')) return '/logos/glickenhaus.png';
    if (lower.includes('vanwall')) return '/logos/vanwall.png';
    if (lower.includes('chevrolet')) return '/logos/corvette.png';
    if (lower.includes('oreca')) return '/logos/oreca.png';
    if (lower.includes('ginetta')) return '/logos/ginetta.png';
    if (lower.includes('ligier')) return '/logos/ligier.png';

    // ACC short model names (no brand word in the string) -> brand logo
    // BMW: M2 CS, M4 GT3/GT4, M6 GT3
    if (/\bm[2468]\b/.test(lower)) return '/logos/bmw.png';
    // McLaren: 720S, 650S, 570S
    if (lower.includes('720s') || lower.includes('650s') || lower.includes('570s')) return '/logos/mclaren.png';
    // Ferrari: 296, 488, 458, 812
    if (lower.includes('296') || lower.includes('488') || lower.includes('458') || lower.includes('812')) return '/logos/ferrari.png';
    // Lamborghini
    if (lower.includes('huracan')) return '/logos/lamborghini.png';
    // Porsche: 911, 992, 991, Cayman, 718, 963
    if (lower.includes('911') || lower.includes('992') || lower.includes('991') || lower.includes('cayman') || lower.includes('718') || lower.includes('963')) return '/logos/porsche.png';
    // Aston Martin
    if (lower.includes('vantage') || lower.includes('amr') || lower.includes('valkyrie')) return '/logos/aston_martin.png';
    // Mercedes-AMG (AMG already handled above, keep GT variants)
    if (lower.includes('amg')) return '/logos/mercedes.png';
    // Lexus RC F
    if (lower.includes('rc f') || lower.includes('rcf')) return '/logos/lexus.png';
    // Chevrolet Camaro -> corvette bowtie logo (only Chevy logo available)
    if (lower.includes('camaro')) return '/logos/corvette.png';
    // Alpine A110
    if (lower.includes('a110') || lower.includes('a424')) return '/logos/alpine.png';
    // Ginetta G55/G61
    if (/\bg\d{2}\b/.test(lower)) return '/logos/ginetta.png';
    // Audi R8 LMS
    if (lower.includes('audi') || /\br8\b/.test(lower)) return '/logos/audi.png';
    // Honda / Acura NSX
    if (lower.includes('honda') || lower.includes('acura') || lower.includes('nsx')) return '/logos/honda.png';
    // Nissan GT-R Nismo
    if (lower.includes('nissan') || lower.includes('gt-r') || lower.includes('nismo')) return '/logos/nissan.png';
    // Bentley Continental
    if (lower.includes('bentley') || lower.includes('continental')) return '/logos/bentley.png';
    // Jaguar (Emil Frey G3)
    if (lower.includes('jaguar')) return '/logos/jaguar.png';
    // KTM X-Bow
    if (lower.includes('ktm') || lower.includes('x-bow') || lower.includes('xbow')) return '/logos/ktm.png';
    // Maserati MC20
    if (lower.includes('maserati') || lower.includes('mc20')) return '/logos/maserati.png';

    // Fallback: use first word
    const brand = lower.split(' ')[0];
    return `/logos/${brand}.png`;
};

export const getClassColor = (cls: string = '') => {
    const c = (cls || "").toUpperCase();
    if (c.includes('HYPER')) return 'border-amber-500/20 text-amber-400 bg-amber-500/10 shadow-[0_0_10px_rgba(251,191,36,0.1)]';
    if (c.includes('LMP2')) return 'border-sky-500/20 text-sky-400 bg-sky-500/10 shadow-[0_0_10px_rgba(56,189,248,0.1)]';
    if (c.includes('LMP3')) return 'border-indigo-500/20 text-indigo-400 bg-indigo-500/10 shadow-[0_0_10px_rgba(99,102,241,0.1)]';
    if (c.includes('GT3') || c.includes('GTE')) return 'border-emerald-500/20 text-emerald-400 bg-emerald-500/10 shadow-[0_0_10px_rgba(52,211,153,0.1)]';
    return 'border-gray-500/50 text-gray-400 bg-gray-500/10';
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

export const normalizeCarClass = (cls: string = ''): string => {
    const c = (cls || "").toUpperCase();
    if (c.includes('HYPER') || c.includes('LMDH') || c.includes('LMH')) return 'HYPERCAR';
    if (c.includes('LMP2')) return 'LMP2';
    if (c.includes('LMP3')) return 'LMP3';
    if (c.includes('GT3')) return 'LMGT3';
    if (c.includes('GTE')) return 'GTE';
    return 'HYPERCAR'; // default fallback
};
