// @ts-check
// Commit window: unstaged / staged lists, diff preview and commit message, like Git Extensions' commit dialog.
const vscode = acquireVsCodeApi();
// @ts-ignore
const { el, fileTree, renderDiff, splitter } = window.DiffKit;
const $ = id => /** @type {any} */ (document.getElementById(id));
const saved = vscode.getState() || {};
const save = patch => vscode.setState(Object.assign(saved, patch));

let diffKey = 0;
/** @type {{ area: 'unstaged' | 'staged', path: string } | null} */
let current = null;
let state = null;

const unstaged = fileTree({
  tree: $('unstaged'),
  filter: $('unstagedFilter'),
  count: $('unstagedCount'),
  multi: true,
  empty: 'No unstaged changes',
  openHint: 'Double-click to stage',
  onSelect: (paths, p) => {
    if (!paths.length) return;
    staged.select(null);
    showDiff('unstaged', p);
  },
  onOpen: p => vscode.postMessage({ type: 'stage', paths: [p] })
});
const staged = fileTree({
  tree: $('staged'),
  count: $('stagedCount'),
  multi: true,
  empty: 'There are no staged changes',
  openHint: 'Double-click to unstage',
  onSelect: (paths, p) => {
    if (!paths.length) return;
    unstaged.select(null);
    showDiff('staged', p);
  },
  onOpen: p => vscode.postMessage({ type: 'unstage', paths: [p] })
});

function showDiff(area, path) {
  current = path ? { area, path } : null;
  const head = $('diffHead');
  head.replaceChildren();
  if (!path) {
    $('diff').replaceChildren();
    return;
  }
  const f = (area === 'staged' ? staged : unstaged).file(path);
  head.append(el('span', 'status st-' + (f?.status === '?' ? 'N' : f?.status), f?.status === '?' ? '+' : f?.status ?? ''), el('span', 'path', path), el('span', 'dim', area));
  if (f?.status !== 'D') {
    const open = el('button', 'mini', 'Open file');
    open.onclick = () => vscode.postMessage({ type: 'openFile', path });
    head.append(open);
  }
  $('diff').replaceChildren(el('div', 'empty', 'Loading\u2026'));
  vscode.postMessage({ type: 'diff', key: ++diffKey, area, path, untracked: !!f?.untracked });
}

// --- stage bar ---
$('stageBtn').onclick = () => {
  const paths = unstaged.selected();
  if (paths.length) vscode.postMessage({ type: 'stage', paths });
};
$('unstageBtn').onclick = () => {
  const paths = staged.selected();
  if (paths.length) vscode.postMessage({ type: 'unstage', paths });
};
$('stageAll').onclick = () => vscode.postMessage({ type: 'stageAll' });
$('unstageAll').onclick = () => vscode.postMessage({ type: 'unstageAll' });
$('unstaged').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') $('stageBtn').click();
});
$('staged').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Delete') $('unstageBtn').click();
});

// --- commit area ---
const msg = $('commitMsg');
const amend = $('amend');
msg.value = saved.message ?? '';
msg.addEventListener('input', () => save({ message: msg.value }));
const commit = andPush => vscode.postMessage({ type: 'commit', message: msg.value, amend: amend.checked, push: andPush });
$('commitBtn').onclick = () => commit(false);
$('commitPushBtn').onclick = () => commit(true);
msg.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commit(false);
  }
});
amend.onchange = () => {
  if (amend.checked && !msg.value.trim()) vscode.postMessage({ type: 'amendMessage' });
};
$('resetAll').onclick = () => vscode.postMessage({ type: 'resetAll' });
$('resetUnstaged').onclick = () => vscode.postMessage({ type: 'resetUnstaged' });
$('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });

// --- splitters ---
splitter($('splitter'), $('left'), { axis: 'x', min: 180, reserve: 240, initial: saved.leftW, onDone: w => save({ leftW: w }) });
splitter($('leftSplit'), $('unstagedBox'), { axis: 'y', min: 80, reserve: 160, initial: saved.unstagedH, onDone: h => save({ unstagedH: h }) });
splitter($('rightSplit'), $('commitArea'), { axis: 'y', min: 90, reserve: 120, invert: true, initial: saved.commitH, onDone: h => save({ commitH: h }) });

function renderStatus() {
  const { committer, head } = state;
  $('committer').textContent = committer.name ? `Committer ${committer.name} <${committer.email}>` : 'Committer not configured (git config user.name)';
  let branch = head.branch || '(detached HEAD)';
  if (head.upstream) branch += ` \u2192 ${head.upstream}`;
  if (head.ahead) branch += ` \u2191${head.ahead}`;
  if (head.behind) branch += ` \u2193${head.behind}`;
  $('branchInfo').textContent = branch;
  $('stagedInfo').textContent = `Staged ${state.staged.length}/${state.staged.length + state.unstaged.length}`;
  $('stageAll').disabled = !state.unstaged.length;
  $('unstageAll').disabled = !state.staged.length;
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    state = data;
    unstaged.setFiles(data.unstaged);
    staged.setFiles(data.staged);
    renderStatus();
    const list = current && (current.area === 'staged' ? staged : unstaged);
    if (current && list.file(current.path)) showDiff(current.area, current.path);
    else if (unstaged.first()) unstaged.select(unstaged.first());
    else if (staged.first()) staged.select(staged.first());
    else showDiff('unstaged', null);
  } else if (data.type === 'diff' && data.key === diffKey) {
    renderDiff($('diff'), data);
  } else if (data.type === 'amendMessage') {
    if (!msg.value.trim()) {
      msg.value = data.text;
      save({ message: msg.value });
    }
  } else if (data.type === 'committed') {
    msg.value = '';
    amend.checked = false;
    save({ message: '' });
  } else if (data.type === 'error') {
    $('diff').replaceChildren(el('div', 'empty', data.message));
  }
});

vscode.postMessage({ type: 'ready' });
