/** Offline cells use the product's public width function, never claim native CPR. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*(?:\x1b\\)|\x1b./g;

export function colorModes(text) {
  const found = new Set();
  for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const codes = match[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 38 || code === 48) {
        found.add(codes[i + 1] === 2 ? 'truecolor' : codes[i + 1] === 5 ? '256color' : 'unknown');
        i += codes[i + 1] === 2 ? 4 : 2;
      } else if (code >= 30 && code <= 37 || code >= 40 && code <= 47 || code >= 90 && code <= 107) found.add('basic');
    }
  }
  return [...found];
}

export function characterGrid(lines, width, height, tier, theme, visibleWidth) {
  const names = new Map();
  for (const token of Object.keys(theme.TOKENS)) {
    const key = (token.startsWith('bg.') ? theme.bgSgr : theme.fgSgr)(token, tier);
    if (key && tier !== 'none') names.set(key, [...(names.get(key) ?? []), token]);
  }
  const label = (codes, kind) => {
    const sgr = `\x1b[${codes.join(';')}m`, aliases = names.get(sgr);
    return aliases?.join('|') ?? `${kind}:${codes.join(';')}`;
  };
  const rows = lines.map(line => {
    const row = []; let state = {}, position = 0;
    const text = value => {
      for (const { segment } of segmenter.segment(value)) {
        if (/[\x00-\x1f\x7f]/.test(segment)) throw Error('GRID_CONTROL_CHARACTER');
        const size = visibleWidth(segment);
        if (size === 0) { if (row.length) row[row.length - 1].char += segment; continue; }
        if (row.length + size > width) throw Error('GRID_WIDTH_OVERFLOW');
        row.push({ char: segment, ...state });
        for (let i = 1; i < size; i++) row.push({ char: '', continuation: true, ...state });
      }
    };
    for (const match of line.matchAll(escapes)) {
      text(line.slice(position, match.index)); position = match.index + match[0].length;
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(match[0]); if (!sgr) continue;
      const codes = (sgr[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) state = {};
        else if (code === 1) state.bold = true;
        else if (code === 2) state.dim = true;
        else if (code === 7) state.reverse = true;
        else if (code === 22) { delete state.bold; delete state.dim; }
        else if (code === 27) delete state.reverse;
        else if (code === 39) delete state.fg;
        else if (code === 49) delete state.bg;
        else if (code === 38 || code === 48) {
          const count = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 0;
          if (!count || i + count > codes.length) throw Error('GRID_UNKNOWN_COLOR');
          state[code === 38 ? 'fg' : 'bg'] = label(codes.slice(i, i + count), code === 38 ? 'fg' : 'bg'); i += count - 1;
        } else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) state.fg = `sgr:${code}`;
        else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) state.bg = `sgr:${code}`;
      }
    }
    text(line.slice(position));
    while (row.length < width) row.push({ char: ' ' });
    return row;
  });
  if (rows.length !== height) throw Error('GRID_HEIGHT_MISMATCH');
  return { width, height, tier, widthBasis: 'offline-public-visibleWidth; native CPR NOT_RUN', rows };
}
