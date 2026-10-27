/** CSV helpers shared by exports and the contact import. */

/** One cell. Guards against CSV/formula injection: a leading = + - @ would run as a formula in Excel. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export const csvLine = (vals: unknown[]) => `${vals.map(csvCell).join(',')}\n`;

/** RFC 4180 parser (quotes, escaped quotes, CRLF). Undoes the export's injection guard. */
export function parseCsv(text: string, maxRows = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  const push = () => {
    row.push(/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);
    cell = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      push();
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`too many rows (max ${maxRows})`);
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    push();
    if (row.some((c) => c !== '')) rows.push(row);
  }
  if (rows.length > maxRows + 1) throw new Error(`too many rows (max ${maxRows})`);
  return rows;
}
