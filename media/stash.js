// @ts-check
// Stash window: browse stashes or the working directory, stash all / selected changes, apply / pop / drop.
const vscode = acquireVsCodeApi();
// @ts-ignore
const { el, fileTree, renderDiff, splitter } = window.DiffKit;
const $ = id => /** @type {any} */ (document.getElementById(id));
const saved = vscode.getState() || {};
const save = patch => vscode.setState(Object.assign(saved, patch));

let filesKey = 0;
let diffKey = 0;
let sel = null; // 'wd' or a stash hash
let state = null;
let draft = saved.draft ?? '';

const tree = fileTree({
  tree: $('tree'),
  filter: $('filter'),
  count: $('fileCount'),
  multi: true,
  empty: 'No changes',
  onSelect: (_paths, p) => {
    showDiff(p);
    updateButtons();
  }
});

function showDiff(path) {
  const head = $('diffHead');
  head.replaceChildren();
  if (!path) {
    $('diff').replaceChildren();
    return;
  }
  const f = tree.file(path);
  head.append(el('span', 'status st-' + (f?.status === '?' ? 'N' : f?.status), f?.status === '?' ? '+' : f?.status ?? ''), el('span', 'path', path));
  $('diff').replaceChildren(el('div', 'empty', 'Loading\u2026'));
  vscode.postMessage({ type: 'diff', key: ++diffKey, sel, path, untracked: !!f?.untracked });
}

function setSelection(value) {
  sel = value;
  $('stashSelect').value = value;
  const stash = state.stashes.find(s => s.hash === value);
  const msg = $('stashMsg');
  msg.readOnly = !!stash;
  msg.value = stash ? stash.subject : draft;
  msg.placeholder = stash ? '' : 'Stash message (optional)';
  updateButtons();
  vscode.postMessage({ type: 'files', key: ++filesKey, sel });
}

function updateButtons() {
  const wd = sel === 'wd';
  const canStash = wd && state && state.changes > 0;
  $('stashAll').disabled = !canStash;
  $('stashSelected').disabled = !canStash || !tree.selected().length;
  $('keepIndex').disabled = $('includeUntracked').disabled = !wd;
  $('dropBtn').disabled = $('applyBtn').disabled = $('popBtn').disabled = wd;
}

$('stashSelect').onchange = () => setSelection($('stashSelect').value);
$('stashMsg').addEventListener('input', () => {
  if (sel !== 'wd') return;
  draft = $('stashMsg').value;
  save({ draft });
});
const stash = paths => vscode.postMessage({
  type: 'stash',
  message: draft,
  keepIndex: $('keepIndex').checked,
  untracked: $('includeUntracked').checked,
  paths
});
$('stashAll').onclick = () => stash(undefined);
$('stashSelected').onclick = () => {
  const paths = tree.selected();
  if (paths.length) stash(paths);
};
for (const [id, type] of [['dropBtn', 'drop'], ['applyBtn', 'apply'], ['popBtn', 'pop']]) {
  $(id).onclick = () => sel !== 'wd' && vscode.postMessage({ type, sel });
}
$('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });

splitter($('splitter'), $('left'), { axis: 'x', min: 220, reserve: 240, initial: saved.leftW, onDone: w => save({ leftW: w }) });
splitter($('leftSplit'), $('stashArea'), { axis: 'y', min: 120, reserve: 160, invert: true, initial: saved.areaH, onDone: h => save({ areaH: h }) });

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    state = data;
    const select = $('stashSelect');
    select.replaceChildren(el('option', '', `Working directory changes (${data.changes})`));
    select.lastChild.value = 'wd';
    for (const s of data.stashes) {
      const o = el('option', '', `${s.ref}: ${s.subject}`);
      o.value = s.hash;
      select.append(o);
    }
    const keep = sel && (sel === 'wd' || data.stashes.some(s => s.hash === sel));
    setSelection(keep ? sel : data.changes || !data.stashes.length ? 'wd' : data.stashes[0].hash);
  } else if (data.type === 'files' && data.key === filesKey) {
    tree.setFiles(data.files);
    const p = tree.primary() ?? tree.first();
    if (p) tree.select(p);
    else showDiff(null);
    updateButtons();
  } else if (data.type === 'diff' && data.key === diffKey) {
    renderDiff($('diff'), data);
  } else if (data.type === 'stashed') {
    draft = '';
    save({ draft });
    if (sel === 'wd') $('stashMsg').value = '';
  } else if (data.type === 'error') {
    $('diff').replaceChildren(el('div', 'empty', data.message));
  }
});

vscode.postMessage({ type: 'ready' });
