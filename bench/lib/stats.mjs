// Statistics for benchmark comparison. Dependency-free.

export function sorted(xs) {
    return [...xs].sort((a, b) => a - b);
}

export function median(xs) {
    const s = sorted(xs);
    const n = s.length;
    if (n === 0) return NaN;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Linear-interpolated quantile over a pre-sorted array. */
export function quantileSorted(s, q) {
    const n = s.length;
    if (n === 0) return NaN;
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function iqr(xs) {
    const s = sorted(xs);
    return quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
}

// Abramowitz & Stegun 7.1.26, max abs error 1.5e-7
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
}

function normalCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Two-sided Mann-Whitney U test with midranks for ties, tie-corrected
 * variance, and continuity correction. Normal approximation — valid for
 * n >= ~8 per side; the harness mandates N >= 20.
 *
 * Returns { U, z, p } where U is computed for sample `a`.
 */
export function mannWhitneyU(a, b) {
    const n1 = a.length, n2 = b.length;
    const n = n1 + n2;
    if (n1 === 0 || n2 === 0) return { U: NaN, z: NaN, p: NaN };

    const all = [];
    for (const v of a) all.push({ v, g: 0 });
    for (const v of b) all.push({ v, g: 1 });
    all.sort((x, y) => x.v - y.v);

    // midranks + tie accumulator
    const ranks = new Array(n);
    let tieSum = 0;
    for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && all[j + 1].v === all[i].v) j++;
        const rank = (i + j + 2) / 2;
        for (let k = i; k <= j; k++) ranks[k] = rank;
        const t = j - i + 1;
        if (t > 1) tieSum += t * t * t - t;
        i = j + 1;
    }

    let r1 = 0;
    for (let k = 0; k < n; k++) if (all[k].g === 0) r1 += ranks[k];
    const U = r1 - (n1 * (n1 + 1)) / 2;

    const mu = (n1 * n2) / 2;
    const sigma2 = ((n1 * n2) / 12) * ((n + 1) - tieSum / (n * (n - 1)));
    if (sigma2 <= 0) return { U, z: 0, p: 1 }; // all values tied

    const diff = U - mu;
    const cc = diff === 0 ? 0 : Math.sign(diff) * 0.5; // continuity correction
    const z = (diff - cc) / Math.sqrt(sigma2);
    const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
    return { U, z, p };
}

/**
 * Hodges-Lehmann shift estimate: median of all pairwise differences (b - a).
 * Robust effect size; negative means B is lower than A.
 */
export function hlShift(a, b) {
    const diffs = [];
    for (const x of a) for (const y of b) diffs.push(y - x);
    return median(diffs);
}
