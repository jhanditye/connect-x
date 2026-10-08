// A small reader/writer for XML property lists (Info.plist), so the scripts need no dependencies and run the
// same on Linux and macOS. It supports the types an Info.plist uses: dict, array, string, true/false,
// integer, real. Anything else (data, date) throws instead of being silently dropped.
//
// Values map to JavaScript like this: dict -> Map (key order is kept), array -> Array, string -> string,
// true/false -> boolean, integer/real -> number.

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function unescapeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parse the text of an XML plist into a Map (the top-level dict). */
export function parsePlist(text) {
  // Drop the XML declaration, DOCTYPE and comments, then tokenise into tags and text.
  const body = text.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!DOCTYPE[\s\S]*?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [];
  const re = /<(\/?)([A-Za-z]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[2]) tokens.push({ type: m[1] ? 'close' : m[4] ? 'empty' : 'open', name: m[2] });
    else if (m[5].trim() !== '') tokens.push({ type: 'text', text: m[5] });
  }
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (type, name) => {
    const t = next();
    if (!t || t.type !== type || (name && t.name !== name)) throw new Error(`plist: expected <${type === 'close' ? '/' : ''}${name ?? ''}> near token ${i}`);
    return t;
  };

  function parseValue() {
    const t = next();
    if (!t) throw new Error('plist: unexpected end of file');
    if (t.type === 'empty') {
      if (t.name === 'true') return true;
      if (t.name === 'false') return false;
      if (t.name === 'dict') return new Map();
      if (t.name === 'array') return [];
      if (t.name === 'string') return '';
      throw new Error(`plist: unsupported empty element <${t.name}/>`);
    }
    if (t.type !== 'open') throw new Error(`plist: unexpected ${t.type} ${t.name ?? t.text}`);
    switch (t.name) {
      case 'dict': {
        const map = new Map();
        while (peek() && !(peek().type === 'close' && peek().name === 'dict')) {
          expect('open', 'key');
          const keyTok = peek().type === 'text' ? next() : { text: '' };
          expect('close', 'key');
          map.set(unescapeXml(keyTok.text), parseValue());
        }
        expect('close', 'dict');
        return map;
      }
      case 'array': {
        const arr = [];
        while (peek() && !(peek().type === 'close' && peek().name === 'array')) arr.push(parseValue());
        expect('close', 'array');
        return arr;
      }
      case 'string':
      case 'integer':
      case 'real': {
        const text = peek().type === 'text' ? next().text : '';
        expect('close', t.name);
        if (t.name === 'string') return unescapeXml(text);
        const n = Number(text.trim());
        if (Number.isNaN(n)) throw new Error(`plist: bad number "${text}"`);
        return n;
      }
      default:
        throw new Error(`plist: unsupported element <${t.name}>`);
    }
  }

  expect('open', 'plist');
  const root = parseValue();
  expect('close', 'plist');
  if (!(root instanceof Map)) throw new Error('plist: the top-level value must be a dict');
  return root;
}

function serializeValue(v, depth) {
  const pad = '\t'.repeat(depth);
  if (v === true) return `${pad}<true/>`;
  if (v === false) return `${pad}<false/>`;
  if (typeof v === 'string') return `${pad}<string>${escapeXml(v)}</string>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}<array/>`;
    return [`${pad}<array>`, ...v.map((x) => serializeValue(x, depth + 1)), `${pad}</array>`].join('\n');
  }
  if (v instanceof Map) {
    if (v.size === 0) return `${pad}<dict/>`;
    const lines = [`${pad}<dict>`];
    for (const [k, val] of v) {
      lines.push(`${pad}\t<key>${escapeXml(k)}</key>`);
      lines.push(serializeValue(val, depth + 1));
    }
    lines.push(`${pad}</dict>`);
    return lines.join('\n');
  }
  throw new Error(`plist: cannot serialise ${typeof v}`);
}

/** Serialise a Map back to a canonical, tab-indented XML plist. */
export function serializePlist(map) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    serializeValue(map, 0) +
    '\n</plist>\n'
  );
}
