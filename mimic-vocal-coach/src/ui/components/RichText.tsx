// Renders the AI coach's reply. Claude answers in light Markdown; this handles paragraphs,
// headings, bullet/numbered lists and **bold**/*italic* as React elements (no HTML injection).

import type { ReactNode } from 'react';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', text: heading[1] });
    } else if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const text = (bullet ?? numbered)![1];
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(text);
      else blocks.push({ kind, items: [text] });
    } else {
      const last = blocks[blocks.length - 1];
      // A wrapped continuation line of a list item.
      if (!para.length && last && (last.kind === 'ul' || last.kind === 'ol') && raw.startsWith(' ')) {
        last.items[last.items.length - 1] += ` ${line}`;
      } else para.push(line);
    }
  }
  flush();
  return blocks;
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText(props: { text: string }) {
  return (
    <div className="rich-text">
      {parseBlocks(props.text).map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{inline(b.text)}</p>;
        if (b.kind === 'h') return <h4 key={i}>{inline(b.text)}</h4>;
        const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>);
        return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}
