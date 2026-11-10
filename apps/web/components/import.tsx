'use client';
import { useMemo, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { Cell, downloadCsv, readFile, Sheet, simplify, toDate, toNumber } from '@/lib/import-files';
import { Alert } from './ui';

/**
 * Assistant d'import commun aux modules : fichier Excel, CSV ou PDF → colonnes associées aux champs de Kora → aperçu ligne à ligne
 * (vérifications du module, doublons) → enregistrement par les mêmes routes que la saisie à l'écran, puis rapport des erreurs.
 */
export interface ImportField {
  key: string; label: string; required?: boolean;
  type?: 'text' | 'number' | 'date' | 'choice';
  choices?: { value: string; label: string; match?: string[] }[];
  /** Autres intitulés de colonne reconnus automatiquement. */
  aliases?: string[];
  /** Lecture particulière : renvoie la valeur ou lève une erreur au message lisible. */
  parse?: (raw: Cell) => unknown;
  /** Valeur proposée quand la colonne est absente ou la cellule vide. */
  default?: string;
}
export interface ImportSetting { key: string; label: string; options: { value: string; label: string }[]; default?: string }
export type Rec = Record<string, any> & { _line: number };
type Verdict = { error?: string; skip?: string } | void;

export interface ImportConfig<C = any> {
  title: string;
  /** Nom de l'objet importé, au pluriel (« articles », « écritures »). */
  what: string;
  /** Le même au singulier (« article », « bon d'entrée »). */
  one: string;
  /** Accord au féminin (« écritures importées »). */
  feminine?: boolean;
  intro: React.ReactNode;
  fields: ImportField[];
  load?: () => Promise<C>;
  settings?: (ctx: C) => ImportSetting[];
  /** Vérifie une ligne ; seen sert à repérer les doublons à l'intérieur du fichier. */
  check?: (r: Rec, ctx: C, seen: Set<string>) => Verdict;
  /** Regroupe les lignes en documents (une facture, une écriture…) ; une ligne = un enregistrement sinon. */
  group?: (rows: Rec[]) => Rec[][];
  /** Le document reprend les seules lignes valides (bon de stock) au lieu d'être bloqué par une ligne en erreur (écriture, facture). */
  partial?: boolean;
  checkGroup?: (g: Rec[], ctx: C) => string | void;
  /** Enregistre une ligne ou un groupe ; renvoie le libellé de ce qui a été créé (code, numéro…). */
  save: (g: Rec[], ctx: C, settings: Record<string, string>) => Promise<string>;
  /** Message affiché une fois l'import terminé. */
  after?: React.ReactNode;
  template: { file: string; rows: Cell[][] };
}

const ACCEPT = '.xlsx,.xlsm,.xls,.csv,.txt,.pdf,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const show = (v: unknown, f?: ImportField) => (v === undefined || v === null ? '' : f?.type === 'date' && typeof v === 'string' ? v.split('-').reverse().join('/') : f?.choices ? f.choices.find((c) => c.value === v)?.label ?? String(v) : typeof v === 'number' ? v.toLocaleString('fr-FR') : String(v));

function matchScore(header: Cell, f: ImportField) {
  const h = simplify(header);
  if (!h) return 0;
  const names = [f.label, f.key, ...(f.aliases ?? [])].map(simplify);
  if (names.includes(h)) return 3;
  if (names.some((n) => n.length >= 3 && (h.startsWith(n) || n.startsWith(h)))) return 2;
  if (names.some((n) => n.length >= 4 && h.includes(n))) return 1;
  return 0;
}

/** Ligne des titres : parmi les 15 premières, celle dont le plus de cellules ressemblent aux champs attendus. */
function findHeader(rows: Cell[][], fields: ImportField[]) {
  let best = 0, score = 0;
  rows.slice(0, 15).forEach((r, i) => {
    const s = r.filter((c) => fields.some((f) => matchScore(c, f) >= 2)).length;
    if (s > score) { score = s; best = i; }
  });
  return best;
}

function autoMap(header: Cell[], fields: ImportField[]) {
  const used = new Set<number>();
  const map: Record<string, number> = {};
  for (const level of [3, 2, 1]) {
    for (const f of fields) {
      if (map[f.key] !== undefined) continue;
      const col = header.findIndex((h, i) => !used.has(i) && matchScore(h, f) === level);
      if (col >= 0) { map[f.key] = col; used.add(col); }
    }
  }
  for (const f of fields) if (map[f.key] === undefined) map[f.key] = -1;
  return map;
}

function readValue(f: ImportField, raw: Cell): { value?: unknown; error?: string } {
  const empty = raw === null || raw === undefined || String(raw).trim() === '';
  if (empty) return f.required ? { error: `${f.label} manquant` } : {};
  try {
    if (f.parse) return { value: f.parse(raw) };
    if (f.type === 'number') {
      const n = toNumber(raw);
      return Number.isNaN(n) ? { error: `${f.label} : nombre attendu (« ${raw} »)` } : { value: n };
    }
    if (f.type === 'date') {
      const d = toDate(raw);
      return d ? { value: d } : { error: `${f.label} : date attendue au format JJ/MM/AAAA (« ${raw} »)` };
    }
    if (f.type === 'choice') {
      const s = simplify(raw);
      const c = f.choices!.find((x) => [x.value, x.label, ...(x.match ?? [])].some((m) => simplify(m) === s));
      return c ? { value: c.value } : { error: `${f.label} : « ${raw} » non reconnu (${f.choices!.map((x) => x.label).join(', ')})` };
    }
    return { value: typeof raw === 'number' ? String(raw) : String(raw).trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

type Row = { rec: Rec; cells: Cell[]; status: 'ok' | 'skip' | 'error' | 'done'; message?: string };

export function ImportButton<C>({ config, onDone, label = 'Importer' }: { config: ImportConfig<C>; onDone?: () => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn" onClick={() => setOpen(true)} title="Importer depuis un fichier Excel, CSV ou PDF">{label}</button>
    {open && <ImportDialog config={config} onClose={(changed) => { setOpen(false); if (changed) onDone?.(); }} />}
  </>;
}

function ImportDialog<C>({ config, onClose }: { config: ImportConfig<C>; onClose: (changed: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<Record<string, number>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>(() => Object.fromEntries(config.fields.map((f) => [f.key, f.default ?? ''])));
  const [ctx, setCtx] = useState<C | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [results, setResults] = useState<Row[] | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);

  const choose = async (f: File) => {
    setError(''); setBusy(true); setSheets(null); setResults(null);
    try {
      const [s, c] = await Promise.all([readFile(f), ctx ? Promise.resolve(ctx) : config.load ? config.load() : Promise.resolve(null as C)]);
      if (!s.some((x) => x.rows.length)) throw new Error('Le fichier est vide.');
      const idx = Math.max(0, s.findIndex((x) => x.rows.length > 1));
      const h = findHeader(s[idx].rows, config.fields);
      setCtx(c as C); setFile(f); setSheets(s); setSheetIdx(idx); setHeaderRow(h); setMap(autoMap(s[idx].rows[h] ?? [], config.fields));
      const st = config.settings?.(c as C) ?? [];
      setSettings(Object.fromEntries(st.map((x) => [x.key, x.default ?? x.options[0]?.value ?? ''])));
    } catch (e) {
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally { setBusy(false); }
  };
  const pickSheet = (i: number) => {
    const h = findHeader(sheets![i].rows, config.fields);
    setSheetIdx(i); setHeaderRow(h); setMap(autoMap(sheets![i].rows[h] ?? [], config.fields));
  };
  const pickHeader = (i: number) => { setHeaderRow(i); setMap(autoMap(sheets![sheetIdx].rows[i] ?? [], config.fields)); };

  const sheet = sheets?.[sheetIdx];
  const header = sheet?.rows[headerRow] ?? [];
  const width = Math.max(header.length, ...(sheet?.rows.slice(headerRow, headerRow + 50).map((r) => r.length) ?? [0]));
  const colName = (i: number) => (header[i] !== null && header[i] !== undefined && String(header[i]).trim() ? String(header[i]) : `Colonne ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`);

  /** Lignes lues, vérifiées et regroupées : recalculé à chaque changement d'association. */
  const rows = useMemo<Row[]>(() => {
    if (!sheet || !ctx && config.load) return [];
    const headKey = header.map(simplify).join('|');
    const out: Row[] = [];
    const seen = new Set<string>();
    sheet.rows.forEach((cells, i) => {
      if (i <= headerRow) return;
      if (cells.map(simplify).join('|') === headKey) return; // en-tête répété (PDF de plusieurs pages)
      const rec: Rec = { _line: i + 1 };
      const errors: string[] = [];
      let filled = false;
      for (const f of config.fields) {
        const col = map[f.key] ?? -1;
        let raw: Cell = col >= 0 ? cells[col] ?? null : null;
        if (raw !== null && String(raw).trim() !== '') filled = true;
        if ((raw === null || String(raw).trim() === '') && defaults[f.key]) raw = defaults[f.key];
        const v = readValue(f, raw);
        if (v.error) errors.push(v.error); else if (v.value !== undefined) rec[f.key] = v.value;
      }
      if (!filled) return;
      if (errors.length) { out.push({ rec, cells, status: 'error', message: errors.join(' · ') }); return; }
      const verdict = config.check?.(rec, ctx as C, seen);
      if (verdict?.error) out.push({ rec, cells, status: 'error', message: verdict.error });
      else if (verdict?.skip) out.push({ rec, cells, status: 'skip', message: verdict.skip });
      else out.push({ rec, cells, status: 'ok' });
    });
    return out;
  }, [sheet, headerRow, map, defaults, ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Documents à créer : une ligne en erreur bloque tout son document. */
  const groups = useMemo(() => {
    const active = rows.filter((r) => (config.partial ? r.status === 'ok' : r.status !== 'skip'));
    const byRec = new Map(active.map((r) => [r.rec, r]));
    const recs = active.map((r) => r.rec);
    const gs = config.group ? config.group(recs) : recs.map((r) => [r]);
    return gs.map((g) => {
      const members = g.map((r) => byRec.get(r)!);
      const bad = members.find((m) => m.status === 'error');
      let message: string | void = bad ? `Non importée avec son document : la ligne ${bad.rec._line} est en erreur` : undefined;
      if (!message && config.checkGroup) message = config.checkGroup(g, ctx as C);
      if (message) for (const m of members) if (m.status === 'ok') { m.status = 'error'; m.message = message as string; }
      return { members, ok: !message };
    });
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = groups.filter((g) => g.ok);
  const counts = { ok: rows.filter((r) => r.status === 'ok').length, skip: rows.filter((r) => r.status === 'skip').length, error: rows.filter((r) => r.status === 'error').length };
  const missingRequired = config.fields.filter((f) => f.required && (map[f.key] ?? -1) < 0 && !defaults[f.key]);

  const start = async () => {
    setBusy(true); setError('');
    const done: Row[] = rows.map((r) => ({ ...r }));
    const find = (rec: Rec) => done.find((d) => d.rec === rec)!;
    let next = 0, finished = 0;
    setProgress([0, ready.length]);
    const worker = async () => {
      while (next < ready.length) {
        const g = ready[next++];
        try {
          const label = await config.save(g.members.map((m) => m.rec), ctx as C, settings);
          for (const m of g.members) Object.assign(find(m.rec), { status: 'done', message: label });
        } catch (e) {
          for (const m of g.members) Object.assign(find(m.rec), { status: 'error', message: errorMessage(e) });
        }
        setProgress([++finished, ready.length]);
      }
    };
    // Un enregistrement après l'autre : les codes et numéros attribués suivent l'ordre du fichier.
    await worker();
    setResults(done); setBusy(false); setProgress(null);
  };

  const exportErrors = () => {
    const list = (results ?? rows).filter((r) => r.status === 'error');
    downloadCsv(`erreurs-import-${new Date().toISOString().slice(0, 10)}.csv`, [[...Array.from({ length: width }, (_, i) => colName(i)), 'Ligne', 'Erreur'],
      ...list.map((r) => [...Array.from({ length: width }, (_, i) => r.cells[i] ?? null), r.rec._line, r.message ?? ''])]);
  };

  const shown = (results ?? rows).filter((r) => !onlyIssues || r.status === 'error' || r.status === 'skip');
  const settingList = ctx !== null || !config.load ? config.settings?.(ctx as C) ?? [] : [];
  const created = results?.filter((r) => r.status === 'done') ?? [];
  const createdDocs = new Set(created.map((r) => r.message)).size;
  const e = config.feminine ? 'e' : '';
  const noun = (n: number) => (n > 1 ? config.what : config.one);

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={config.title} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(!!results); }}>
      <div className="modal import-modal">
        <header className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{config.title}</h2>
          <button className="btn sm" disabled={busy} onClick={() => onClose(!!results)}>Fermer</button>
        </header>

        {!results && <>
          <div className="import-intro small">{config.intro}</div>
          <div className="row">
            <label className={`btn primary${busy ? ' disabled' : ''}`}>{file ? 'Choisir un autre fichier' : 'Choisir un fichier'}
              <input type="file" accept={ACCEPT} hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
            </label>
            <button type="button" className="btn" onClick={() => downloadCsv(config.template.file, config.template.rows)}>Télécharger un modèle</button>
            {file && <span className="small muted">{file.name}</span>}
          </div>
          <p className="small muted" style={{ margin: 0 }}>Formats acceptés : Excel (.xlsx), CSV et PDF. Pour un PDF, seuls les documents produits par un logiciel sont lisibles (pas les scans) ; vérifiez bien l'aperçu.</p>
        </>}
        <Alert>{error}</Alert>
        {busy && !progress && <p className="muted small">Lecture du fichier…</p>}

        {sheet && !results && <>
          <div className="row import-source">
            {sheets!.length > 1 && <label className="field">Feuille
              <select className="input" value={sheetIdx} onChange={(e) => pickSheet(Number(e.target.value))}>{sheets!.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} lignes)</option>)}</select></label>}
            <label className="field">Ligne des titres
              <select className="input" value={headerRow} onChange={(e) => pickHeader(Number(e.target.value))}>
                {sheet.rows.slice(0, 20).map((r, i) => <option key={i} value={i}>{i + 1} : {r.filter((c) => c !== null && String(c).trim()).slice(0, 4).map(String).join(' | ').slice(0, 60)}</option>)}
              </select></label>
            {settingList.map((s) => <label key={s.key} className="field">{s.label}
              <select className="input" value={settings[s.key] ?? ''} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>{s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>)}
          </div>

          <h3>Colonnes</h3>
          <div className="table-wrap"><table className="import-map">
            <thead><tr><th>Champ de Kora</th><th>Colonne du fichier</th><th>Valeur si vide</th></tr></thead>
            <tbody>{config.fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label}{f.required && <b className="req"> *</b>}</td>
                <td><select className="input" value={map[f.key] ?? -1} onChange={(e) => setMap({ ...map, [f.key]: Number(e.target.value) })}>
                  <option value={-1}>— Aucune —</option>{Array.from({ length: width }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}</select></td>
                <td>{f.type === 'choice'
                  ? <select className="input" value={defaults[f.key]} onChange={(e) => setDefaults({ ...defaults, [f.key]: e.target.value })}><option value="">—</option>{f.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
                  : <input className="input" value={defaults[f.key]} placeholder={f.type === 'date' ? 'JJ/MM/AAAA' : ''} onChange={(e) => setDefaults({ ...defaults, [f.key]: e.target.value })} />}</td>
              </tr>))}</tbody>
          </table></div>
          {missingRequired.length > 0 && <Alert kind="warn">Associez une colonne (ou une valeur) aux champs obligatoires : {missingRequired.map((f) => f.label).join(', ')}.</Alert>}
        </>}

        {sheet && <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>{results ? 'Résultat' : 'Aperçu'}</h3>
            <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />Lignes à revoir seulement</label>
          </div>
          {results
            ? <Alert kind={created.length ? 'ok' : 'warn'}>
                {created.length ? <><b>{createdDocs} {noun(createdDocs)}</b> importé{e}{createdDocs > 1 ? 's' : ''} ({created.length} ligne{created.length > 1 ? 's' : ''}).</> : `Aucun${e} ${config.one} importé${e}.`}
                {results.some((r) => r.status === 'skip') && <> {results.filter((r) => r.status === 'skip').length} ligne(s) ignorée(s).</>}
                {results.some((r) => r.status === 'error') && <> {results.filter((r) => r.status === 'error').length} ligne(s) en erreur, non importée(s).</>}
                {created.length > 0 && config.after && <div style={{ marginTop: 6 }}>{config.after}</div>}
              </Alert>
            : <p className="small" style={{ margin: 0 }}>
                <span className="pill ok">{counts.ok} prête{counts.ok > 1 ? 's' : ''}</span>{' '}
                {counts.skip > 0 && <span className="pill">{counts.skip} ignorée{counts.skip > 1 ? 's' : ''}</span>}{' '}
                {counts.error > 0 && <span className="pill crit">{counts.error} en erreur</span>}
                {config.group && <> — {ready.length} {noun(ready.length)} à créer</>}
              </p>}
          {progress && <div className="import-progress" role="progressbar" aria-valuenow={progress[0]} aria-valuemax={progress[1]}><span style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} /><b>{progress[0]} / {progress[1]}</b></div>}
          <div className="table-wrap import-preview"><table>
            <thead><tr><th>Ligne</th>{config.fields.filter((f) => (map[f.key] ?? -1) >= 0 || defaults[f.key]).map((f) => <th key={f.key}>{f.label}</th>)}<th>État</th></tr></thead>
            <tbody>
              {shown.slice(0, 300).map((r) => (
                <tr key={r.rec._line} className={`imp-${r.status}`}>
                  <td className="n">{r.rec._line}</td>
                  {config.fields.filter((f) => (map[f.key] ?? -1) >= 0 || defaults[f.key]).map((f) => <td key={f.key}>{show(r.rec[f.key], f)}</td>)}
                  <td className="imp-state">{r.status === 'ok' ? <span className="pill ok">Prête</span> : r.status === 'done' ? <span className="pill ok">Importée{r.message ? ` · ${r.message}` : ''}</span>
                    : r.status === 'skip' ? <span className="small muted">{r.message}</span> : <span className="small imp-err">{r.message}</span>}</td>
                </tr>))}
              {!shown.length && <tr><td colSpan={99} className="muted">Aucune ligne.</td></tr>}
            </tbody>
          </table></div>
          {shown.length > 300 && <p className="small muted" style={{ margin: 0 }}>300 premières lignes affichées sur {shown.length}.</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {(results ?? rows).some((r) => r.status === 'error') && <button className="btn" onClick={exportErrors}>Télécharger les lignes en erreur</button>}
            {results
              ? <button className="btn primary" onClick={() => onClose(true)}>Terminer</button>
              : <button className="btn primary" disabled={busy || !ready.length || missingRequired.length > 0} onClick={start}>
                  {busy ? 'Import en cours…' : `Importer ${ready.length} ${noun(ready.length)}`}</button>}
          </div>
        </>}
      </div>
    </div>
  );
}
