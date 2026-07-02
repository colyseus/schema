// Table + number formatting for the benchmark runner.

export function fmtNum(v, digits = 4) {
    if (v === null || v === undefined || Number.isNaN(v)) return "-";
    if (v === 0) return "0";
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    return v.toPrecision(digits);
}

export function fmtDelta(pct) {
    if (pct === null || Number.isNaN(pct)) return "-";
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function fmtP(p) {
    if (p === null || p === undefined || Number.isNaN(p)) return "-";
    if (p < 0.001) return "<.001";
    return p.toFixed(3);
}

/** rows: array of arrays (first row = header). Right-aligns numeric-ish columns. */
export function printTable(rows, out = process.stdout) {
    if (rows.length === 0) return;
    const cols = rows[0].length;
    const widths = new Array(cols).fill(0);
    for (const row of rows) {
        for (let c = 0; c < cols; c++) widths[c] = Math.max(widths[c], String(row[c]).length);
    }
    const numeric = new Array(cols).fill(true);
    for (const row of rows.slice(1)) {
        for (let c = 1; c < cols; c++) {
            const s = String(row[c]);
            if (s !== "-" && !/^[+\-<>≈]?[\d.]/.test(s)) numeric[c] = false;
        }
    }
    rows.forEach((row, i) => {
        const line = row.map((cell, c) => {
            const s = String(cell);
            return c > 0 && numeric[c] ? s.padStart(widths[c]) : s.padEnd(widths[c]);
        }).join("  ");
        out.write(line.trimEnd() + "\n");
        if (i === 0) out.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
    });
}
