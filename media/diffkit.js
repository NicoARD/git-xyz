// @ts-check
// Shared by the commit view, commit-changes and stash windows: directory-style file tree, unified diff and splitters.
(() => {
  const MAX_LINES = 20000;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function relativeTime(ms) {
    const s = (Date.now() - ms) / 1000;
    const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [sec, name] of units) {
      if (s >= sec) {
        const v = Math.floor(s / Number(sec));
        return `${v} ${name}${v === 1 ? '' : 's'} ago`;
      }
    }
    return 'just now';
  }

  const statusEl = s => el('span', 'status st-' + (s === '?' ? 'N' : s), s === '?' ? '+' : s);

  function buildTree(list) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of list) {
      const parts = f.path.split('/');
      let node = root;
      for (let k = 0; k < parts.length - 1; k++) {
        const p = parts[k];
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path: parts.slice(0, k + 1).join('/'), dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      }
      node.files.push({ ...f, name: parts[parts.length - 1] });
    }
    // merge single-child folder chains into one row, e.g. "services/Api/src"
    const compress = node => {
      for (const d of node.dirs.values()) {
        while (d.dirs.size === 1 && !d.files.length) {
          const [c] = d.dirs.values();
          d.name += '/' + c.name;
          d.path = c.path;
          d.dirs = c.dirs;
          d.files = c.files;
        }
        compress(d);
      }
    };
    compress(root);
    return root;
  }

  const countFiles = d => d.files.length + [...d.dirs.values()].reduce((s, c) => s + countFiles(c), 0);

  /**
   * @param {{ tree: HTMLElement, filter?: HTMLInputElement, count?: HTMLElement, multi?: boolean, empty?: string,
   *   onSelect?: (paths: string[], primary: string | null) => void, onOpen?: (path: string) => void, openHint?: string }} opts
   */
  function fileTree(opts) {
    let files = [];
    const collapsed = new Set();
    /** @type {{ row: HTMLElement, path: string }[]} */
    let rows = [];
    let selection = new Set();
    let primary = null;
    let anchor = null;

    function render() {
      const { tree } = opts;
      tree.replaceChildren();
      rows = [];
      const q = opts.filter ? opts.filter.value.trim().toLowerCase() : '';
      const shown = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
      if (opts.count) {
        const add = shown.reduce((s, f) => s + (f.add || 0), 0);
        const del = shown.reduce((s, f) => s + (f.del || 0), 0);
        opts.count.replaceChildren(`${shown.length} file${shown.length === 1 ? '' : 's'} `, el('span', 'add', `+${add}`), ' ', el('span', 'del', `\u2212${del}`));
      }
      const walk = (node, depth) => {
        const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirs) {
          const open = q || !collapsed.has(d.path);
          const row = el('div', 'row dir');
          row.style.paddingLeft = `${6 + depth * 14}px`;
          row.append(el('span', 'twisty', open ? '\u25BE' : '\u25B8'), el('span', 'icon folder'), el('span', 'name', d.name), el('span', 'count', String(countFiles(d))));
          row.title = d.path;
          row.onclick = () => {
            if (collapsed.has(d.path)) collapsed.delete(d.path);
            else collapsed.add(d.path);
            render();
          };
          tree.append(row);
          if (open) walk(d, depth + 1);
        }
        for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
          const row = el('div', 'row file' + (selection.has(f.path) ? ' selected' : ''));
          row.style.paddingLeft = `${6 + depth * 14 + 14}px`;
          const counts = el('span', 'counts');
          if (f.binary) counts.append('bin');
          else if (f.add || f.del) counts.append(el('span', 'add', `+${f.add}`), ' ', el('span', 'del', `\u2212${f.del}`));
          row.append(statusEl(f.status), el('span', 'name', f.name), counts);
          row.title = f.path + (opts.openHint ? `\n${opts.openHint}` : '');
          row.onclick = e => select(f.path, e);
          if (opts.onOpen) row.ondblclick = () => opts.onOpen?.(f.path);
          tree.append(row);
          rows.push({ row, path: f.path });
        }
      };
      walk(buildTree(shown), 0);
      if (!shown.length) tree.append(el('div', 'empty', q ? 'No matching files' : opts.empty ?? 'No file changes'));
    }

    function paint() {
      for (const { row, path } of rows) row.classList.toggle('selected', selection.has(path));
      rows.find(r => r.path === primary)?.row.scrollIntoView({ block: 'nearest' });
    }

    function select(path, e) {
      if (path == null) {
        selection = new Set();
        primary = anchor = null;
      } else if (opts.multi && e && (e.ctrlKey || e.metaKey)) {
        if (selection.has(path)) selection.delete(path);
        else selection.add(path);
        anchor = path;
      } else if (opts.multi && e && e.shiftKey && anchor) {
        const a = rows.findIndex(r => r.path === anchor);
        const b = rows.findIndex(r => r.path === path);
        selection = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.path));
      } else {
        selection = new Set([path]);
        anchor = path;
      }
      primary = path != null && selection.has(path) ? path : [...selection][0] ?? null;
      paint();
      opts.onSelect?.([...selection], primary);
    }

    opts.tree.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (!rows.length) return;
      const k = rows.findIndex(r => r.path === primary);
      const next = k < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)));
      select(rows[next].path, e.shiftKey ? e : undefined);
    });
    opts.filter?.addEventListener('input', render);

    return {
      /** Replace the file list; keeps the selection for paths that still exist. */
      setFiles(list) {
        files = list;
        const paths = new Set(list.map(f => f.path));
        selection = new Set([...selection].filter(p => paths.has(p)));
        if (primary && !paths.has(primary)) primary = [...selection][0] ?? null;
        render();
      },
      select,
      selected: () => [...selection],
      primary: () => primary,
      file: path => files.find(f => f.path === path),
      files: () => files,
      first: () => rows[0]?.path ?? null,
      collapseAll: () => collapsed.clear()
    };
  }

  /** @param {HTMLElement} container */
  function renderDiff(container, { text = '', truncated = false, error = '', note = '' } = {}) {
    container.replaceChildren();
    container.scrollTop = 0;
    if (error || note) {
      container.append(el('div', 'empty', error || note));
      return;
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const frag = document.createDocumentFragment();
    let oldN = 0;
    let newN = 0;
    let inHunk = false;
    const limit = Math.min(lines.length, MAX_LINES);
    for (let k = 0; k < limit; k++) {
      const line = lines[k];
      let cls;
      let a = '';
      let b = '';
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldN = Number(hunk[1]);
        newN = Number(hunk[2]);
        inHunk = true;
        cls = 'hunk';
      } else if (!inHunk) cls = line.startsWith('---') ? 'meta del-file' : line.startsWith('+++') ? 'meta add-file' : 'meta';
      else if (line[0] === '+') { cls = 'add'; b = String(newN++); }
      else if (line[0] === '-') { cls = 'del'; a = String(oldN++); }
      else if (line[0] === '\\') cls = 'meta';
      else if (line.startsWith('diff --git')) { cls = 'meta'; inHunk = false; }
      else { cls = 'ctx'; a = String(oldN++); b = String(newN++); }
      const row = el('div', 'line ' + cls);
      row.append(el('span', 'ln', a), el('span', 'ln', b), el('span', 'code', line || ' '));
      frag.append(row);
    }
    if (!lines.length) frag.append(el('div', 'empty', 'No textual changes (mode change, rename or empty file)'));
    if (lines.length > MAX_LINES || truncated) frag.append(el('div', 'empty', 'Diff too large; showing the beginning only.'));
    container.append(frag);
  }

  /**
   * Drag handle that resizes `pane` along one axis; `invert` grows the pane when dragging up/left.
   * @param {HTMLElement} handle @param {HTMLElement} pane
   * @param {{ axis: 'x' | 'y', min?: number, reserve?: number, invert?: boolean, initial?: number, onDone?: (size: number) => void }} o
   */
  function splitter(handle, pane, o) {
    const prop = o.axis === 'x' ? 'width' : 'height';
    if (o.initial) pane.style[prop] = o.initial + 'px';
    handle.addEventListener('pointerdown', e => {
      handle.setPointerCapture(e.pointerId);
      const start = o.axis === 'x' ? e.clientX : e.clientY;
      const startSize = pane.getBoundingClientRect()[prop];
      const limit = (o.axis === 'x' ? window.innerWidth : window.innerHeight) - (o.reserve ?? 120);
      const move = ev => {
        const d = (o.axis === 'x' ? ev.clientX : ev.clientY) - start;
        pane.style[prop] = Math.max(o.min ?? 80, Math.min(limit, startSize + (o.invert ? -d : d))) + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        o.onDone?.(pane.getBoundingClientRect()[prop]);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  // @ts-ignore
  window.DiffKit = { el, relativeTime, fileTree, renderDiff, splitter };
})();
