import { Fragment } from 'react';

/** Mise en forme dans une ligne : **gras** et *italique*. */
function inline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b>
      : part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <i key={i}>{part.slice(1, -1)}</i>
        : <Fragment key={i}>{part}</Fragment>);
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Markdown simple (### titres, paragraphes, listes à puces ou numérotées, tableaux) pour les textes rédigés dans Kora.
 * idPrefix : préfixe des ancres des titres, pour le sommaire.
 */
export function Markdown({ text, idPrefix }: { text: string; idPrefix?: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return <>{blocks.map((b, i) => {
    const lines = b.split('\n');
    if (b.startsWith('### ')) {
      const title = b.slice(4).trim();
      const num = /^([0-9A-Z]+(\.[0-9]+)?)[ .]/.exec(title)?.[1];
      return <h3 key={i} id={idPrefix && num ? `${idPrefix}-${num.replace('.', '-')}` : undefined}>{inline(title)}</h3>;
    }
    if (lines.every((l) => l.trim().startsWith('|'))) {
      const [head, , ...rows] = lines;
      return <div key={i} className="table-wrap"><table>
        <thead><tr>{cells(head).map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.map((r, j) => <tr key={j}>{cells(r).map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
      </table></div>;
    }
    if (lines.every((l) => /^\d+\. /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+\. /, ''))}</li>)}</ol>;
    if (lines.every((l) => l.startsWith('- '))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
    return <p key={i}>{inline(b.replace(/\n/g, ' '))}</p>;
  })}</>;
}
