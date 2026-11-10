/**
 * Lecture des fichiers à importer, entièrement dans le navigateur : rien n'est envoyé tant que l'utilisateur n'a pas validé.
 * - Excel (.xlsx) : lu directement (archive ZIP + XML), dates Excel converties en AAAA-MM-JJ, nombres gardés tels quels ;
 * - CSV / texte : séparateur (; , tabulation) et encodage (UTF-8 ou Windows-1252, celui d'Excel en français) détectés ;
 * - PDF : texte des tableaux reconstitué ligne par ligne et colonne par colonne (PDF issus d'un logiciel, pas les scans).
 */
export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

export async function readFile(file: File): Promise<Sheet[]> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const buf = await file.arrayBuffer();
  if (ext === 'xls') throw new Error('Ancien format Excel (.xls) : ouvrez le fichier dans Excel et enregistrez-le en .xlsx ou en CSV.');
  if (ext === 'xlsx' || ext === 'xlsm' || isZip(buf)) return readXlsx(buf);
  if (ext === 'pdf' || isPdf(buf)) return readPdf(buf);
  return [{ name: file.name, rows: parseCsv(decodeText(buf)) }];
}

const isZip = (b: ArrayBuffer) => b.byteLength > 4 && new DataView(b).getUint32(0, true) === 0x04034b50;
const isPdf = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b, 0, Math.min(5, b.byteLength))) === '%PDF-';

/* ---------- CSV ---------- */

export function decodeText(buf: ArrayBuffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  return text.replace(/^﻿/, '');
}

export function parseCsv(text: string): Cell[][] {
  const nl = text.search(/\r?\n/);
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const counts = [';', ',', '\t', '|'].map((d) => [d, firstLine.split(d).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: Cell[][] = [];
  let row: Cell[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x ?? '').trim() !== ''));
}

/* ---------- Excel (.xlsx) ---------- */

async function unzip(buf: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Fichier Excel illisible (archive incomplète).');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<string>>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name.replace(/^\//, ''), async () => {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = bytes.slice(start, start + size);
      if (method === 0) return dec.decode(data);
      if (method !== 8) throw new Error('Fichier Excel compressé dans un format non pris en charge.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    });
  }
  return files;
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const byTag = (n: Document | Element, tag: string) => Array.from(n.getElementsByTagNameNS('*', tag));
const textOf = (n: Element) => byTag(n, 't').filter((t) => !t.closest('rPh')).map((t) => t.textContent ?? '').join('');
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Numéro de série Excel (jours depuis le 30/12/1899) → AAAA-MM-JJ. */
export const excelDate = (serial: number) => new Date(Math.round((serial - 25569) * 86400) * 1000).toISOString().slice(0, 10);

async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const files = await unzip(buf);
  const get = async (name: string) => (files.has(name) ? xml(await files.get(name)!()) : null);
  const wb = await get('xl/workbook.xml');
  if (!wb) throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx).");
  const rels = await get('xl/_rels/workbook.xml.rels');
  const target = new Map(rels ? byTag(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target') ?? '']) : []);
  const shared = await get('xl/sharedStrings.xml');
  const strings = shared ? byTag(shared, 'si').map(textOf) : [];
  // Styles : un style de cellule (attribut s) au format date fait d'un nombre une date.
  const styles = await get('xl/styles.xml');
  const custom = new Map(styles ? byTag(styles, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '']) : []);
  const isDateFmt = (id: number) => DATE_FORMATS.has(id) || (custom.has(id) && /[dy]/i.test(custom.get(id)!.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
  const xfs = styles ? byTag(byTag(styles, 'cellXfs')[0] ?? styles.documentElement, 'xf').map((x) => isDateFmt(Number(x.getAttribute('numFmtId') ?? 0))) : [];

  const sheets: Sheet[] = [];
  for (const s of byTag(wb, 'sheet')) {
    const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let path = target.get(rid) ?? '';
    path = path.startsWith('/') ? path.slice(1) : `xl/${path}`;
    const doc = await get(path);
    if (!doc) continue;
    const rows: Cell[][] = [];
    for (const r of byTag(doc, 'row')) {
      const ri = Number(r.getAttribute('r') ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      for (const c of byTag(r, 'c')) {
        const ref = c.getAttribute('r') ?? '';
        const letters = ref.replace(/\d+/g, '');
        const col = letters ? [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : row.length;
        const t = c.getAttribute('t'), raw = byTag(c, 'v')[0]?.textContent ?? null;
        let val: Cell = null;
        if (t === 's') val = raw === null ? null : strings[Number(raw)] ?? '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'str' || t === 'e') val = raw;
        else if (t === 'b') val = raw === '1' ? 'VRAI' : 'FAUX';
        else if (raw !== null && raw !== '') {
          const n = Number(raw);
          val = xfs[Number(c.getAttribute('s') ?? 0)] && n > 0 && n < 2958466 ? excelDate(n) : n;
        }
        row[col] = val;
      }
      rows[ri] = Array.from(row, (x) => x ?? null);
    }
    sheets.push({ name: s.getAttribute('name') ?? `Feuille ${sheets.length + 1}`, rows: Array.from(rows, (r) => r ?? []).filter((r) => r.some((x) => x !== null && String(x).trim() !== '')) });
  }
  if (!sheets.length) throw new Error('Aucune feuille lisible dans ce classeur.');
  return sheets;
}

/* ---------- PDF ---------- */

interface Piece { x: number; end: number; y: number; h: number; s: string }

async function readPdf(buf: ArrayBuffer): Promise<Sheet[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const lines: Piece[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const pieces: Piece[] = [];
    for (const it of content.items as any[]) {
      if (!it.str?.trim()) continue;
      const h = Math.abs(it.transform[3]) || it.height || 10;
      pieces.push({ x: it.transform[4], end: it.transform[4] + it.width, y: it.transform[5], h, s: it.str });
    }
    // Même ligne : écart vertical inférieur à la moitié de la hauteur du texte ; de haut en bas, puis de gauche à droite.
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    const pageLines: Piece[][] = [];
    for (const pc of pieces) {
      const last = pageLines[pageLines.length - 1];
      if (last && Math.abs(last[0].y - pc.y) < Math.max(2, pc.h * 0.5)) last.push(pc); else pageLines.push([pc]);
    }
    for (const l of pageLines) {
      l.sort((a, b) => a.x - b.x);
      // Morceaux proches fusionnés en une cellule ; un blanc d'au moins une largeur de caractère sépare deux colonnes.
      const cells: Piece[] = [];
      for (const pc of l) {
        const c = cells[cells.length - 1];
        if (c && pc.x - c.end < pc.h * 0.6) { c.s += (pc.x - c.end > pc.h * 0.15 ? ' ' : '') + pc.s; c.end = Math.max(c.end, pc.end); } else cells.push({ ...pc });
      }
      lines.push(cells);
    }
  }
  if (!lines.length) throw new Error("Ce PDF ne contient pas de texte lisible (document scanné ?) : importez plutôt le fichier Excel ou CSV d'origine.");
  // Colonnes : intervalles des lignes les plus remplies (en-têtes et lignes de détail), fusionnés quand ils se chevauchent.
  const widest = Math.max(...lines.map((l) => l.length));
  const ref = lines.filter((l) => l.length >= Math.max(2, widest - 1));
  const cols: { x: number; end: number }[] = [];
  for (const c of ref.flat().sort((a, b) => a.x - b.x)) {
    const hit = cols.find((k) => c.x < k.end && c.end > k.x);
    if (hit) { hit.x = Math.min(hit.x, c.x); hit.end = Math.max(hit.end, c.end); } else cols.push({ x: c.x, end: c.end });
  }
  cols.sort((a, b) => a.x - b.x);
  const rows: Cell[][] = lines.map((l) => {
    const row: Cell[] = cols.map(() => null);
    for (const c of l) {
      let best = 0, score = -Infinity;
      cols.forEach((k, i) => {
        const overlap = Math.min(k.end, c.end) - Math.max(k.x, c.x);
        const s = overlap > 0 ? overlap : -Math.min(Math.abs(c.x - k.end), Math.abs(k.x - c.end));
        if (s > score) { score = s; best = i; }
      });
      row[best] = row[best] ? `${row[best]} ${c.s}` : c.s;
    }
    return row;
  });
  return [{ name: 'PDF', rows }];
}

/* ---------- Valeurs ---------- */

/** Texte sans accents ni ponctuation, en minuscules : sert à reconnaître les en-têtes et les valeurs. */
export const simplify = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** « 1 234 567,50 », « 1,234.50 », « 15 000 FCFA », « 18 % » → nombre ; NaN si ce n'est pas un nombre. */
export function toNumber(v: Cell): number {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[\s  ]/g, '').replace(/(fcfa|xof|cfa|f|€|\$|%)$/i, '');
  const neg = /^\(.*\)$/.test(s) || /-$/.test(s);
  s = s.replace(/[()]/g, '').replace(/-$/, '');
  if (!s) return NaN;
  const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma >= 0) s = /^-?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s) && s.split('.').length > 2) s = s.replace(/\./g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return neg ? -Number(s) : Number(s);
}

/** « 31/01/2026 », « 31-01-26 », « 2026-01-31 », numéro de série Excel → « 2026-01-31 » ; null si ce n'est pas une date. */
export function toDate(v: Cell): string | null {
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelDate(v) : null;
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  else if (/^\d{5}$/.test(s)) return toDate(Number(s));
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Fichier CSV (point-virgule, UTF-8 avec BOM : Excel l'ouvre correctement) à télécharger. */
export function downloadCsv(name: string, rows: Cell[][]) {
  const esc = (v: Cell) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([`﻿${rows.map((r) => r.map(esc).join(';')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
