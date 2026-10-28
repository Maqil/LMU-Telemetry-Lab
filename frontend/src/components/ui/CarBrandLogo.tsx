import { useEffect, useState } from 'react';
import { Car } from 'lucide-react';
import { getBrandLogoPath, getClassGlyphPath } from '../../utils/carHelpers';

/**
 * Brand mark for a car string, with a guaranteed fallback.
 *
 * Custom liveries come through as team names ("ORT by TF #25") with no brand in
 * them; the class is what lets those resolve (a team's car differs per class),
 * and what backs the slot when nothing resolves at all -- the class silhouette,
 * then a plain car glyph if even that is missing. The slot always renders.
 */
export const CarBrandLogo = ({ name, carClass, size = 28, className = '' }: {
    name?: string;
    /** Raw class tag from the sim ("GT3", "LMP2_ELMS", "Hyper"). */
    carClass?: string;
    size?: number;
    className?: string;
}) => {
    const brand = getBrandLogoPath(name || '', carClass || '');
    const glyph = getClassGlyphPath(carClass || '');
    const src = brand || glyph;
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [src]);

    if (!src || failed) {
        return (
            <div
                className={`flex items-center justify-center rounded-md bg-white/5 border border-white/5 ${className}`}
                style={{ width: size, height: size }}
                title={name || undefined}
            >
                <Car size={Math.max(10, Math.round(size * 0.5))} className="text-gray-500" />
            </div>
        );
    }
    return (
        <img
            src={src}
            alt=""
            title={name || undefined}
            // The class silhouettes are flat white art; dimmed a little so they
            // read as a fallback next to a real brand mark.
            className={`object-contain ${brand ? '' : 'opacity-50'} ${className}`}
            style={{ width: size, height: size }}
            onError={() => setFailed(true)}
        />
    );
};
