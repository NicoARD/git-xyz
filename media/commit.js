// @ts-check
const vscode = acquireVsCodeApi();
// @ts-ignore
const { el, relativeTime, fileTree, renderDiff, splitter } = window.DiffKit;
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {any} */
let commit = null;
const diffCache = new Map(); // path -> message

function hashLink(hash) {
  const a = el('a', 'link mono', hash.slice(0, 10));
  a.title = `Open ${hash}`;
  a.onclick = () => vscode.postMessage({ type: 'open', hash });
  return a;
}

// --- header ---
function renderHeader() {
  const c = commit;
  const initials = c.author.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0;
  for (const ch of c.email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const avatar = $('avatar');
  avatar.textContent = initials;
  avatar.style.background = `hsl(${h % 360}, 45%, 42%)`;

  const meta = $('meta');
  meta.replaceChildren();
  const row = (label, value) => {
    meta.append(el('span', 'label', label));
    const v = el('span', 'value');
    v.append(...(Array.isArray(value) ? value : [value]));
    meta.append(v);
  };
  row('Author:', `${c.author} <${c.email}>`);
  row('Date:', `${relativeTime(c.date)} (${new Date(c.date).toLocaleString()})`);
  if (c.committer !== c.author || Math.abs(c.cdate - c.date) > 60000) {
    row('Committer:', `${c.committer} <${c.cemail}>, ${new Date(c.cdate).toLocaleString()}`);
  }
  const hash = el('span', 'mono', c.hash);
  const copy = el('button', 'mini', 'Copy');
  copy.onclick = () => vscode.postMessage({ type: 'copy', text: c.hash });
  row('Commit hash:', [hash, ' ', copy]);
  if (c.parents.length) {
    const parts = [];
    c.parents.forEach((p, k) => parts.push(...(k ? [' ', hashLink(p)] : [hashLink(p)])));
    row(c.parents.length > 1 ? 'Parents:' : 'Parent:', parts);
  }
  $('message').textContent = c.body;
  $('branches').textContent = 'Contained in branches: \u2026';
  $('tags').textContent = '';
  $('derives').textContent = '';
}

function renderRefs({ branches, tags, derives }) {
  const list = (id, label, items, none) => {
    const e = $(id);
    e.replaceChildren();
    if (!items.length) {
      e.textContent = none;
      return;
    }
    e.append(`${label} `);
    const MAX = 12;
    items.slice(0, MAX).forEach((name, k) => e.append(k ? ', ' : '', el('span', 'ref', name)));
    if (items.length > MAX) e.append(el('span', 'dim', ` and ${items.length - MAX} more`));
  };
  list('branches', 'Contained in branches:', branches, 'Contained in no branch');
  list('tags', 'Contained in tags:', tags, 'Contained in no tag');
  $('derives').textContent = derives ? `Derives from tag: ${derives.tag} + ${derives.count} commit${derives.count === 1 ? '' : 's'}` : '';
}

// --- file tree + diff ---
const tree = fileTree({
  tree: $('tree'),
  filter: /** @type {HTMLInputElement} */ ($('treeFilter')),
  count: $('fileCount'),
  openHint: 'Double-click to open in VS Code\'s diff editor',
  onSelect: (_paths, path) => showDiff(path),
  onOpen: path => vscode.postMessage({ type: 'openDiff', path })
});

function showDiff(path) {
  const f = path && tree.file(path);
  const head = $('diffHead');
  head.replaceChildren();
  if (!f) {
    $('diff').replaceChildren();
    return;
  }
  const open = el('button', 'mini', 'Open in VS Code');
  open.title = 'Open this file in VS Code\'s side-by-side diff editor';
  open.onclick = () => vscode.postMessage({ type: 'openDiff', path });
  head.append(el('span', 'status st-' + f.status, f.status), el('span', 'path', path), open);
  const cached = diffCache.get(path);
  if (cached) renderDiff($('diff'), cached);
  else {
    $('diff').replaceChildren(el('div', 'empty', 'Loading\u2026'));
    vscode.postMessage({ type: 'fileDiff', path });
  }
  vscode.setState({ ...vscode.getState(), selected: { hash: commit.hash, path } });
}

splitter($('splitter'), $('treePane'), {
  axis: 'x',
  min: 160,
  reserve: 200,
  initial: vscode.getState()?.treeWidth,
  onDone: w => vscode.setState({ ...vscode.getState(), treeWidth: w })
});
$('openAll').onclick = () => vscode.postMessage({ type: 'openChanges', subject: commit?.body.split('\n')[0] });

const topH = vscode.getState()?.topHeight;
if (topH) $('top').classList.add('sized');
// the default max-height would cap the drag, so lift it once the user takes over
$('topSplit').addEventListener('pointerdown', () => $('top').classList.add('sized'));
splitter($('topSplit'), $('top'), {
  axis: 'y',
  min: 40,
  reserve: 120,
  initial: topH,
  onDone: h => vscode.setState({ ...vscode.getState(), topHeight: h })
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'commit') {
    commit = data.commit;
    diffCache.clear();
    tree.collapseAll();
    tree.select(null);
    tree.setFiles(data.files);
    renderHeader();
    const saved = vscode.getState()?.selected;
    const has = p => p && data.files.some(f => f.path === p);
    const initial = has(data.select) ? data.select : saved?.hash === commit.hash && has(saved.path) ? saved.path : tree.first();
    tree.select(initial);
  } else if (data.type === 'refs' && commit && data.hash === commit.hash) {
    renderRefs(data);
  } else if (data.type === 'fileDiff' && commit && data.hash === commit.hash) {
    diffCache.set(data.path, data);
    if (data.path === tree.primary()) renderDiff($('diff'), data);
  } else if (data.type === 'error') {
    $('message').textContent = data.message;
  }
});

vscode.postMessage({ type: 'ready' });
