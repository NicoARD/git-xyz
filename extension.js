const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PAGE_SIZE = 800;
const STATE_KEY = 'gitxyz.viewState'; // settings, pins, filters, camera; lives in VS Code's global storage
const FS = '\x1f';
const RS = '\x1e';

let panel;
let currentRoot;
let extContext;
let repoListener;
let maxCount = PAGE_SIZE;
let statsCache = new Map(); // hash -> { changes, files, folder }; commits are immutable so this never goes stale

function activate(context) {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('gitxyz.open', () => openPanel(context)),
    vscode.commands.registerCommand('gitxyz.refresh', () => {
      refresh();
      if (commitPanel && commitView.ready) loadCommitView();
    })
  );
}

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    // execFile with an args array: no shell, so user input can't inject commands.
    // no TTY here, so a credential prompt would hang forever
    // optional locks off: read-only commands like status must not rewrite the index, or the repo watcher refreshes in a loop
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    const child = execFile('git', args, { cwd, env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function getGitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

// Scoped to the folder VS Code has open, not the active editor.
async function resolveRepo() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  let root;
  try {
    root = path.normalize((await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return undefined;
  }
  const api = await getGitApi();
  return { root, repo: api?.getRepository(vscode.Uri.file(root)) ?? undefined };
}

function parseRefs(decoration) {
  const refs = [];
  if (!decoration) return refs;
  for (let part of decoration.split(', ')) {
    part = part.trim();
    if (part.startsWith('HEAD -> ')) {
      refs.push({ type: 'head', name: 'HEAD' });
      part = part.slice('HEAD -> '.length);
    }
    if (part === 'HEAD') refs.push({ type: 'head', name: 'HEAD' });
    else if (part.startsWith('tag: refs/tags/')) refs.push({ type: 'tag', name: part.slice(15) });
    else if (part.startsWith('refs/heads/')) refs.push({ type: 'branch', name: part.slice(11) });
    else if (part.startsWith('refs/remotes/')) {
      const name = part.slice(13);
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name });
    }
  }
  return refs;
}

async function loadGraph(root) {
  const format = ['%H', '%P', '%an', '%ae', '%at', '%ct', '%D', '%s'].join('%x1f') + '%x1e';
  const out = await git(root, [
    'log', '--all', '--date-order', '--decorate=full',
    `--max-count=${maxCount}`, `--format=${format}`
  ]);
  const commits = out.split(RS).map(r => r.replace(/^\n/, '')).filter(Boolean).map(rec => {
    const [hash, parents, author, email, time, ctime, refs, subject] = rec.split(FS);
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(time) * 1000,
      cdate: Number(ctime) * 1000,
      refs: parseRefs(refs),
      subject,
      ...statsCache.get(hash)
    };
  });
  let currentBranch = '';
  try {
    currentBranch = (await git(root, ['branch', '--show-current'])).trim();
  } catch { /* detached or empty repo */ }
  return { root, name: path.basename(root), commits, currentBranch, hasMore: commits.length >= maxCount };
}

// Line counts are slow on big repos, so they're computed after the graph is shown.
async function loadStats(root, hashes) {
  // RS leads each record so the numstat lines that follow a hash stay in the same record.
  const out = await git(root, ['log', '--no-walk=unsorted', '--stdin', '--numstat', '--no-renames', '--format=%x1e%H'], hashes.join('\n') + '\n');
  const stats = {};
  for (const rec of out.split(RS)) {
    const [hash, ...lines] = rec.split('\n');
    if (!hash) continue;
    let changes = 0;
    let files = 0;
    const byFolder = new Map();
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t"?(.*)$/.exec(line);
      if (!m) continue;
      const n = (Number(m[1]) || 0) + (Number(m[2]) || 0);
      const slash = m[3].indexOf('/');
      const folder = slash === -1 ? '(root)' : m[3].slice(0, slash);
      byFolder.set(folder, (byFolder.get(folder) || 0) + n);
      changes += n;
      files++;
    }
    let folder = null;
    let best = -1;
    for (const [f, l] of byFolder) if (l > best) [folder, best] = [f, l];
    stats[hash] = { changes, files, folder };
    statsCache.set(hash, stats[hash]);
  }
  return stats;
}

async function refresh() {
  for (const t of toolPanels.values()) t.refresh();
  if (!panel) return;
  const resolved = await resolveRepo();
  if (!resolved) {
    panel.webview.postMessage({ type: 'error', message: 'No git repository found in the workspace.' });
    return;
  }
  if (resolved.root !== currentRoot) {
    currentRoot = resolved.root;
    maxCount = PAGE_SIZE;
    statsCache = new Map();
    repoListener?.dispose();
    repoListener = undefined;
  }
  // the git extension may discover the repo after the first refresh
  if (!repoListener && resolved.repo) repoListener = resolved.repo.state.onDidChange(debounce(refresh, 300));
  let graph;
  try {
    graph = await loadGraph(resolved.root);
    panel.webview.postMessage({ type: 'graph', graph });
  } catch (e) {
    panel.webview.postMessage({ type: 'error', message: e.message });
    return;
  }
  postGitStatus(resolved.root).catch(() => {});
  const missing = graph.commits.filter(c => !statsCache.has(c.hash)).map(c => c.hash);
  if (!missing.length) return;
  try {
    const stats = await loadStats(resolved.root, missing);
    panel?.webview.postMessage({ type: 'stats', stats });
  } catch { /* stats are optional */ }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const isHash = h => typeof h === 'string' && /^[0-9a-f]{7,40}$/i.test(h);

// Changes are against the first parent (or the empty tree for a root commit).
async function commitDetails(root, hash, parent) {
  const range = parent ? [parent, hash] : ['--root', hash];
  const diff = mode => git(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--no-commit-id', '--no-renames', mode, ...range]);
  const [body, numstat, status] = await Promise.all([git(root, ['show', '-s', '--format=%B', hash]), diff('--numstat'), diff('--name-status')]);
  return { body: body.trim(), files: parseChanges(status, numstat) };
}

function parseChanges(status, numstat) {
  const files = new Map();
  for (const line of status.split('\n')) {
    const [s, p] = line.split('\t');
    if (p) files.set(p, { path: p, status: s[0], add: 0, del: 0 });
  }
  for (const line of numstat.split('\n')) {
    const [a, d, p] = line.split('\t');
    const f = files.get(p);
    if (f) Object.assign(f, { add: Number(a) || 0, del: Number(d) || 0, binary: a === '-' });
  }
  return [...files.values()];
}

async function diffUris(root, hash, parent, file) {
  const api = await getGitApi();
  if (!api) throw new Error('The built-in Git extension is not available.');
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), file);
  return [uri, api.toGitUri(uri, parent || EMPTY_TREE), api.toGitUri(uri, hash)];
}

async function openDiff(root, { hash, parent, path: file }) {
  const [, left, right] = await diffUris(root, hash, parent, file);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (${hash.slice(0, 7)})`, { preview: true });
}

async function openChanges(root, { hash, parent, subject, files }) {
  files ??= (await commitDetails(root, hash, parent)).files.map(f => f.path);
  const entries = await Promise.all(files.map(f => diffUris(root, hash, parent, f)));
  const title = `${hash.slice(0, 7)} ${subject ?? ''}`.trim();
  try {
    await vscode.commands.executeCommand('vscode.changes', title, entries);
  } catch {
    // multi-file diff editor needs VS Code 1.86+; fall back to the first file
    if (entries.length) await vscode.commands.executeCommand('vscode.diff', entries[0][1], entries[0][2], title);
  }
}

async function handleCommitMessage(msg) {
  const root = currentRoot;
  if (!root || !isHash(msg.hash) || (msg.parent && !isHash(msg.parent))) return;
  try {
    if (msg.type === 'commitDetails') {
      const details = await commitDetails(root, msg.hash, msg.parent);
      panel?.webview.postMessage({ type: 'commitDetails', hash: msg.hash, ...details });
    } else if (msg.type === 'openDiff') await openDiff(root, msg);
    else if (msg.type === 'openChanges') await openChanges(root, msg);
  } catch (e) {
    if (msg.type === 'commitDetails') panel?.webview.postMessage({ type: 'commitDetails', hash: msg.hash, error: e.message });
    vscode.window.showErrorMessage(`GitXYZ: ${e.message}`);
  }
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function validBranchName(root, name) {
  try {
    await git(root, ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}

async function confirm(message) {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Yes');
  return choice === 'Yes';
}

async function runAction(msg) {
  const root = currentRoot;
  if (!root) return;
  const { action, hash, branch } = msg;
  const short = hash ? hash.slice(0, 8) : '';
  let args;

  switch (action) {
    case 'copyHash':
      await vscode.env.clipboard.writeText(hash);
      vscode.window.showInformationMessage(`Copied ${short}`);
      return;
    case 'checkoutCommit':
      args = ['checkout', hash];
      break;
    case 'createBranch': {
      const name = await vscode.window.showInputBox({
        prompt: `New branch at ${short}`,
        validateInput: async v => (v && (await validBranchName(root, v)) ? null : 'Invalid branch name')
      });
      if (!name) return;
      const checkout = await vscode.window.showQuickPick(['Create and checkout', 'Create only'], { placeHolder: 'Checkout?' });
      if (!checkout) return;
      args = checkout === 'Create only' ? ['branch', name, hash] : ['checkout', '-b', name, hash];
      break;
    }
    case 'createTag': {
      const name = await vscode.window.showInputBox({ prompt: `New tag at ${short}` });
      if (!name) return;
      args = ['tag', name, hash];
      break;
    }
    case 'cherryPick':
      args = ['cherry-pick', hash];
      break;
    case 'revert':
      args = ['revert', '--no-edit', hash];
      break;
    case 'reset': {
      const mode = await vscode.window.showQuickPick(['--soft', '--mixed', '--hard'], { placeHolder: `Reset current branch to ${short}` });
      if (!mode) return;
      if (mode === '--hard' && !(await confirm(`Hard reset to ${short}? Uncommitted changes will be lost.`))) return;
      args = ['reset', mode, hash];
      break;
    }
    case 'checkoutBranch':
      args = ['checkout', branch];
      break;
    case 'checkoutRemote': {
      const local = branch.split('/').slice(1).join('/');
      args = ['checkout', '-b', local, '--track', branch];
      break;
    }
    case 'mergeBranch':
      args = ['merge', '--no-edit', branch];
      break;
    case 'rebaseOnto':
      if (!(await confirm(`Rebase current branch onto ${branch}?`))) return;
      args = ['rebase', branch];
      break;
    case 'renameBranch': {
      const name = await vscode.window.showInputBox({
        prompt: `Rename ${branch}`,
        value: branch,
        validateInput: async v => (v && (await validBranchName(root, v)) ? null : 'Invalid branch name')
      });
      if (!name || name === branch) return;
      args = ['branch', '-m', branch, name];
      break;
    }
    case 'deleteBranch':
      if (!(await confirm(`Delete branch ${branch}?`))) return;
      args = ['branch', '-d', branch];
      break;
    case 'deleteTag':
      if (!(await confirm(`Delete tag ${branch}?`))) return;
      args = ['tag', '-d', branch];
      break;
    default:
      return;
  }

  try {
    await git(root, args);
    vscode.window.setStatusBarMessage(`GitXYZ: git ${args.join(' ')}`, 4000);
  } catch (e) {
    if (action === 'deleteBranch' && /not fully merged/.test(e.message) &&
        (await confirm(`${branch} is not fully merged. Force delete?`))) {
      await git(root, ['branch', '-D', branch]).catch(err => vscode.window.showErrorMessage(err.message));
    } else {
      vscode.window.showErrorMessage(`git ${args[0]} failed: ${e.message}`);
    }
  }
  refresh();
}

// --- git toolbar ---
async function postGitStatus(root) {
  const [status, stashes] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-b']),
    git(root, ['stash', 'list']).catch(() => '')
  ]);
  const [head, ...lines] = status.split('\n');
  const info = parseBranchHead(head);
  panel?.webview.postMessage({
    type: 'gitStatus',
    branch: info.branch,
    upstream: !!info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    changes: lines.filter(Boolean).length,
    stashes: stashes.split('\n').filter(Boolean).length
  });
}

// "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main" or "## HEAD (no branch)"
function parseBranchHead(head) {
  const [local, rest = ''] = head.replace(/^## (No commits yet on |Initial commit on )?/, '').split('...');
  return {
    branch: head.startsWith('## HEAD (no branch)') ? '' : local.split(' ')[0],
    upstream: rest.split(' ')[0],
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  };
}

async function apiRepo(root) {
  const api = await getGitApi();
  return api?.getRepository(vscode.Uri.file(root)) ?? undefined;
}

const lines = s => s.split('\n').filter(Boolean);
const gitPathExists = async (root, name) => fs.existsSync(path.resolve(root, (await git(root, ['rev-parse', '--git-path', name])).trim()));
const headHash = async root => (await git(root, ['rev-parse', 'HEAD'])).trim();

async function pickRef(root, placeHolder, { heads = true, remotes = false, tags = false, excludeCurrent = false } = {}) {
  const current = (await git(root, ['branch', '--show-current'])).trim();
  const out = await git(root, ['for-each-ref', '--format=%(refname)', ...(heads ? ['refs/heads'] : []), ...(remotes ? ['refs/remotes'] : []), ...(tags ? ['refs/tags'] : [])]);
  const items = lines(out).filter(r => !r.endsWith('/HEAD')).map(r => {
    const [, kind, name] = /^refs\/(heads|remotes|tags)\/(.*)$/.exec(r);
    const icon = { heads: 'git-branch', remotes: 'cloud', tags: 'tag' }[kind];
    return { label: `$(${icon}) ${name}`, description: name === current && kind === 'heads' ? 'current' : '', name };
  }).filter(i => !(excludeCurrent && i.description === 'current'));
  if (!items.length) return void vscode.window.showInformationMessage('Nothing to choose from.');
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.name;
}

async function pickCommit(root, placeHolder, prefer) {
  const out = await git(root, ['log', '--all', '--date-order', '-n', '500', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr']);
  const items = lines(out).map(l => {
    const [hash, short, subject, author, age] = l.split(FS);
    return { label: subject, description: `${short}  ${author}, ${age}`, hash };
  });
  const i = items.findIndex(it => it.hash === prefer);
  if (i > 0) items.unshift(...items.splice(i, 1));
  if (i >= 0) items[0].label = `$(target) ${items[0].label}`;
  return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.hash;
}

async function pickOne(placeHolder, items) {
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.id;
}

async function pickBranch(root) {
  const out = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const refs = out.split('\n').filter(Boolean);
  const locals = refs.filter(r => r.startsWith('refs/heads/')).map(r => r.slice(11));
  const remotes = refs.filter(r => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).map(r => r.slice(13))
    .filter(r => !locals.includes(r.split('/').slice(1).join('/')));
  const items = [
    { label: '$(add) Create new branch...', id: 'new' },
    { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
    ...locals.map(b => ({ label: `$(git-branch) ${b}`, branch: b, action: 'checkoutBranch' })),
    { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
    ...remotes.map(b => ({ label: `$(cloud) ${b}`, branch: b, action: 'checkoutRemote' }))
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Checkout branch' });
  if (!pick) return;
  if (pick.id === 'new') {
    const hash = (await git(root, ['rev-parse', 'HEAD'])).trim();
    return runAction({ action: 'createBranch', hash });
  }
  return runAction({ action: pick.action, branch: pick.branch });
}

async function remoteOp(root, title, viaApi, args) {
  const repo = await apiRepo(root);
  // the git extension's API supplies credentials (askpass); plain git is the fallback
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `GitXYZ: ${title}...` },
    () => (repo && viaApi ? viaApi(repo) : git(root, args)));
}

// Each case returns true when the repo changed and the graph should refresh.
const GIT_TOOLS = {
  async checkout(root) { await pickBranch(root); },
  async fetch(root) { await remoteOp(root, 'Fetching', r => r.fetch(), ['fetch']); return true; },
  async fetchAll(root) { await remoteOp(root, 'Fetching all remotes', r => r.fetch({ all: true, prune: true }), ['fetch', '--all', '--prune']); return true; },
  async pull(root) { await remoteOp(root, 'Pulling', r => r.pull(), ['pull']); return true; },
  async pullRebase(root) { await remoteOp(root, 'Pulling (rebase)', null, ['pull', '--rebase']); return true; },
  async pullFetch(root) {
    const id = await pickOne('Pull / Fetch', [
      { label: '$(arrow-down) Pull (merge)', id: 'pull' },
      { label: '$(arrow-down) Pull (rebase)', id: 'pullRebase' },
      { label: '$(sync) Fetch', id: 'fetch' },
      { label: '$(sync) Fetch all remotes & prune', id: 'fetchAll' }
    ]);
    return id && GIT_TOOLS[id](root);
  },
  push: root => push(root, {}),
  pushForce: root => push(root, { force: true }),
  async pushMenu(root) {
    const id = await pickOne('Push', [
      { label: '$(arrow-up) Push', id: 'push' },
      { label: '$(tag) Push with tags', id: 'tags' },
      { label: '$(warning) Force push (with lease)', id: 'force' }
    ]);
    return id && push(root, { force: id === 'force', tags: id === 'tags' });
  },
  async commit(root) { openWorktreeWindow(root); },
  async undoCommit(root) {
    if (!(await confirm('Undo the last commit? Its changes stay staged.'))) return;
    await git(root, ['reset', '--soft', 'HEAD~1']);
    return true;
  },
  stashPush: (root) => stash(root, []),
  stashKeepIndex: (root) => stash(root, ['--keep-index']),
  stashPushU: (root) => stash(root, ['--include-untracked']),
  async stashPop(root) { await git(root, ['stash', 'pop']); return true; },
  async manageStashes(root) { openStashWindow(root); },
  async resetChanges(root) {
    const id = await pickOne('Reset changes', [
      { label: 'Discard tracked changes', description: 'git reset --hard HEAD', id: 'hard' },
      { label: 'Discard all changes, including untracked files', description: 'reset --hard + clean -fd', id: 'all' }
    ]);
    if (!id || !(await confirm('Discard your uncommitted changes? This cannot be undone.'))) return;
    await git(root, ['reset', '--hard', 'HEAD']);
    if (id === 'all') await git(root, ['clean', '-fd']);
    return true;
  },
  async clean(root) {
    const flag = await pickOne('Clean working directory', [
      { label: 'Remove untracked files and folders', description: 'git clean -fd', id: '-fd' },
      { label: 'Also remove ignored files', description: 'git clean -fdx', id: '-fdx' },
      { label: 'Remove only ignored files', description: 'git clean -fdX', id: '-fdX' }
    ]);
    if (!flag) return;
    const files = lines(await git(root, ['clean', flag.replace('f', 'n')])).map(l => l.replace(/^Would remove /, ''));
    if (!files.length) return void vscode.window.showInformationMessage('Nothing to clean.');
    const preview = files.slice(0, 10).join('\n') + (files.length > 10 ? `\n...and ${files.length - 10} more` : '');
    if (!(await confirm(`Delete ${files.length} item(s)?\n\n${preview}`))) return;
    await git(root, ['clean', flag]);
    return true;
  },
  async createBranch(root, msg) { await runAction({ action: 'createBranch', hash: msg.hash || (await headHash(root)) }); },
  async deleteBranch(root) {
    const branch = await pickRef(root, 'Delete branch', { excludeCurrent: true });
    if (branch) await runAction({ action: 'deleteBranch', branch });
  },
  async merge(root) {
    const branch = await pickRef(root, 'Merge into the current branch', { remotes: true, excludeCurrent: true });
    if (branch) await runAction({ action: 'mergeBranch', branch });
  },
  async rebase(root) {
    if ((await gitPathExists(root, 'rebase-merge')) || (await gitPathExists(root, 'rebase-apply'))) {
      const id = await pickOne('A rebase is in progress', [
        { label: '$(debug-continue) Continue', id: 'continue' },
        { label: '$(debug-step-over) Skip this commit', id: 'skip' },
        { label: '$(close) Abort', id: 'abort' }
      ]);
      if (!id) return;
      // core.editor=true accepts the commit message without opening an editor
      await git(root, ['-c', 'core.editor=true', 'rebase', `--${id}`]);
      return true;
    }
    const branch = await pickRef(root, 'Rebase the current branch onto', { remotes: true, excludeCurrent: true });
    if (branch) await runAction({ action: 'rebaseOnto', branch });
  },
  async conflicts(root) {
    const files = lines(await git(root, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']));
    if (!files.length) return void vscode.window.showInformationMessage('No merge conflicts.');
    const file = await vscode.window.showQuickPick(files, { placeHolder: 'Open a conflicted file' });
    if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(vscode.Uri.file(root), file));
  },
  async createTag(root, msg) { await runAction({ action: 'createTag', hash: msg.hash || (await headHash(root)) }); },
  async deleteTag(root) {
    const tag = await pickRef(root, 'Delete tag', { heads: false, tags: true });
    if (tag) await runAction({ action: 'deleteTag', branch: tag });
  },
  async cherryPick(root, msg) {
    const hash = await pickCommit(root, 'Cherry-pick commit onto the current branch', msg.hash);
    if (hash) await runAction({ action: 'cherryPick', hash });
  },
  async checkoutRevision(root, msg) {
    const hash = await pickCommit(root, 'Checkout revision (detached HEAD)', msg.hash);
    if (hash) await runAction({ action: 'checkoutCommit', hash });
  },
  async archive(root, msg) {
    const hash = await pickCommit(root, 'Archive revision', msg.hash);
    if (!hash) return;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(root, '..', `${path.basename(root)}-${hash.slice(0, 8)}.zip`)),
      filters: { 'Zip archive': ['zip'], 'Tar archive': ['tar'] }
    });
    if (!target) return;
    const format = target.fsPath.toLowerCase().endsWith('.tar') ? 'tar' : 'zip';
    await git(root, ['archive', `--format=${format}`, '-o', target.fsPath, hash]);
    vscode.window.showInformationMessage(`Archived ${hash.slice(0, 8)} to ${target.fsPath}`);
  },
  async bisect(root, msg) {
    const active = await gitPathExists(root, 'BISECT_LOG');
    const target = isHash(msg.hash) ? msg.hash : undefined;
    const on = target ? ` (selected ${target.slice(0, 8)})` : ' (HEAD)';
    const id = await pickOne(active ? 'Bisect in progress' : 'Bisect', active
      ? [
          { label: `$(pass) Mark good${on}`, id: 'good' },
          { label: `$(error) Mark bad${on}`, id: 'bad' },
          { label: `$(debug-step-over) Skip${on}`, id: 'skip' },
          { label: '$(close) Stop bisecting', id: 'reset' }
        ]
      : [{ label: '$(play) Start bisect: current HEAD is bad, then pick a good commit', id: 'start' }]);
    if (!id) return;
    let out;
    if (id === 'start') {
      const good = await pickCommit(root, 'Pick a known good commit', msg.hash);
      if (!good) return;
      await git(root, ['bisect', 'start']);
      await git(root, ['bisect', 'bad']);
      out = await git(root, ['bisect', 'good', good]);
    } else out = await git(root, ['bisect', id, ...(target && id !== 'reset' ? [target] : [])]);
    const first = lines(out)[0];
    if (first) vscode.window.showInformationMessage(`Bisect: ${first}`);
    return true;
  },
  async reflog(root) {
    const out = await git(root, ['reflog', '-n', '300', '--format=%H%x1f%gd%x1f%gs%x1f%cr']);
    const items = lines(out).map(l => {
      const [hash, ref, subject, age] = l.split(FS);
      return { label: subject, description: `${ref}  ${hash.slice(0, 8)}, ${age}`, hash };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Reflog', matchOnDescription: true });
    if (!pick) return;
    const action = await pickOne(pick.hash.slice(0, 8), [
      { label: '$(eye) Open commit view', id: 'view' },
      { label: '$(git-branch) Create branch here...', id: 'createBranch' },
      { label: '$(debug-disconnect) Checkout (detached)', id: 'checkoutCommit' },
      { label: '$(discard) Reset current branch to here...', id: 'reset' }
    ]);
    if (action === 'view') openCommitView(extContext, root, pick.hash);
    else if (action) await runAction({ action, hash: pick.hash });
  },
  async formatPatch(root, msg) {
    const hash = await pickCommit(root, 'Create a patch file from commit', msg.hash);
    if (!hash) return;
    const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Save patch here' });
    if (!dir) return;
    const file = lines(await git(root, ['format-patch', '-1', hash, '-o', dir[0].fsPath]))[0];
    if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(root, file)));
  },
  async applyPatch(root) {
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Patches: ['patch', 'diff'], 'All files': ['*'] }, openLabel: 'Apply' });
    if (!files) return;
    const id = await pickOne('Apply patch', [
      { label: 'Apply to the working tree', description: 'git apply', id: 'apply' },
      { label: 'Apply as commits', description: 'git am -3', id: 'am' }
    ]);
    if (!id) return;
    await git(root, id === 'am' ? ['am', '-3', ...files.map(f => f.fsPath)] : ['apply', ...files.map(f => f.fsPath)]);
    return true;
  },
  async viewPatch() {
    const files = await vscode.window.showOpenDialog({ filters: { Patches: ['patch', 'diff'], 'All files': ['*'] }, openLabel: 'View' });
    if (files) await vscode.commands.executeCommand('vscode.open', files[0]);
  },
  async explorer(root) { await vscode.env.openExternal(vscode.Uri.file(root)); },
  async terminal(root) { vscode.window.createTerminal({ name: `git: ${path.basename(root)}`, cwd: root }).show(); }
};

async function stash(root, flags) {
  const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
  if (message === undefined) return;
  await git(root, ['stash', 'push', ...flags, ...(message ? ['-m', message] : [])]);
  return true;
}

async function push(root, { force, tags }) {
  if (force && !(await confirm('Force push (with lease) the current branch?'))) return;
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  if (!branch) throw new Error('Cannot push a detached HEAD.');
  const hasUpstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}']).then(() => true, () => false);
  const remote = hasUpstream ? undefined : lines(await git(root, ['remote']))[0];
  if (!hasUpstream && !remote) throw new Error('No remote configured.');
  const args = ['push', ...(force ? ['--force-with-lease'] : []), ...(tags ? ['--follow-tags'] : []), ...(hasUpstream ? [] : ['-u', remote, branch])];
  // the API has no tags option; ForcePushMode.ForceWithLease = 1
  const viaApi = tags ? null : r => r.push(remote, hasUpstream ? undefined : branch, !hasUpstream, force ? 1 : undefined);
  await remoteOp(root, 'Pushing', viaApi, args);
  return true;
}

async function gitTool(msg) {
  const root = currentRoot;
  const fn = Object.hasOwn(GIT_TOOLS, msg.tool) && GIT_TOOLS[msg.tool];
  if (!root || !fn) return;
  if (msg.hash !== undefined && !isHash(msg.hash)) delete msg.hash;
  try {
    if (await fn(root, msg)) refresh();
  } catch (e) {
    vscode.window.showErrorMessage(`GitXYZ: ${e.message}`);
    refresh();
  }
}

function openPanel(context) {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('gitxyz', 'GitXYZ', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'three')
    ]
  });
  panel.webview.html = getHtml(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'ready') {
      panel.webview.postMessage({ type: 'restore', data: context.globalState.get(STATE_KEY) });
      refresh();
    } else if (msg.type === 'persist') context.globalState.update(STATE_KEY, msg.data);
    else if (msg.type === 'refresh') refresh();
    else if (msg.type === 'loadMore') {
      maxCount += PAGE_SIZE;
      refresh();
    } else if (msg.type === 'action') runAction(msg);
    else if (msg.type === 'gitTool') gitTool(msg);
    else if (msg.type === 'commitDetails' || msg.type === 'openDiff' || msg.type === 'openChanges') handleCommitMessage(msg);
    else if (msg.type === 'openCommitView' && isHash(msg.hash) && currentRoot) {
      openCommitView(context, currentRoot, msg.hash, typeof msg.path === 'string' ? msg.path : undefined);
    }
  });
  panel.onDidDispose(() => {
    panel = undefined;
    currentRoot = undefined;
    repoListener?.dispose();
    repoListener = undefined;
  });
}

function getHtml(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, ...p));
  const threeUri = uri('node_modules', 'three', 'build', 'three.module.js');
  const addonsUri = uri('node_modules', 'three', 'examples', 'jsm') + '/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<link rel="stylesheet" href="${uri('media', 'style.css')}">
<script type="importmap" nonce="${nonce}">
{ "imports": { "three": "${threeUri}", "three/addons/": "${addonsUri}" } }
</script>
</head>
<body>
<div id="header">
  <div class="hdr-left">
  <span id="repoName">Loading...</span>
  <button id="branchBtn" class="mode" title="Current branch: click to checkout another"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 6.6c0 3.2-7 1.8-7 4.3"/></svg><span id="branchName">...</span><span class="caret">&#9662;</span></button>
  <button class="menu-btn" id="commandsMenu">Commands</button>
  <button class="menu-btn" id="viewMenu">View</button>
  </div>
  <div class="hdr-center">
  <div class="btn-group">
    <button data-tool="fetch" title="git fetch">&#10227; Fetch</button>
    <button data-tool="pull" title="git pull">&#8595; Pull<span id="behindCount" class="count"></span></button>
    <button data-tool="push" title="git push">&#8593; Push<span id="aheadCount" class="count"></span></button>
    <button id="remoteMore" title="More remote actions">&#9662;</button>
  </div>
  <button data-tool="commit" id="commitBtn" title="Commit changes">&#10003; Commit (<span id="changeCount">0</span>)</button>
  <button id="stashBtn" title="Stash">Stash<span id="stashCount" class="count"></span> &#9662;</button>
  </div>
  <div class="hdr-right">
  <button class="icon-btn" data-tool="explorer" title="Open the repository folder"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/></svg></button>
  <button class="icon-btn" data-tool="terminal" title="Open a terminal in the repository"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4 6l2.5 2L4 10M8 10.5h4"/></svg></button>
  <div id="view">
    <button id="viewBtn">Options &#9662;</button>
    <div id="viewPanel" class="hidden">
      <div class="section">Display</div>
      <div class="prop"><span>Colour</span>
        <select id="colorMode">
          <option value="branch">Branch</option>
          <option value="author">Author</option>
          <option value="age">Age</option>
          <option value="folder">Top-level Folder</option>
        </select>
      </div>
      <div class="prop"><span>Render Distance</span><input type="range" id="renderDist" min="100" max="2000" step="10"></div>
      <label class="check"><input type="checkbox" id="sizeByChanges" checked> Size by Lines Changed</label>
      <label class="check" title="Collapse long linear runs of commits into a tube when far away"><input type="checkbox" id="collapseChains" checked> Collapse Distant Chains</label>
      <div class="section">Layout</div>
      <div class="prop"><span>Layout</span>
        <select id="layout">
          <option value="map" selected>Map (flat lanes)</option>
          <option value="spiral">Spiral (3D)</option>
        </select>
      </div>
      <div class="prop"><span>Branch Spacing</span><input type="range" id="branchSpacing" min="2" max="12" step="0.5"></div>
      <div class="prop" title="Map layout: how far branches are pushed in and out of the plane"><span>Depth Variation</span><input type="range" id="depthVariation" min="0" max="12" step="0.5"></div>
      <label class="check" title="Branches cluster organically; time stays on the X axis"><input type="checkbox" id="organic"> Organic Layout</label>
      <div class="section">Labels</div>
      <div class="prop"><span>Label Distance</span><input type="range" id="labelDist" min="5" step="1"></div>
      <label class="check" title="Dim branch labels and make them click-through"><input type="checkbox" id="dimLabels"> Dim Labels</label>
      <label class="check" title="Show one label per commit with a count of the other refs"><input type="checkbox" id="groupRefLabels" checked> One Label per Commit</label>
      <label class="check" title="Subject, author, age and hash next to each commit when zoomed in"><input type="checkbox" id="details" checked> Commit Details</label>
      <label class="check" title="Hide labels that overlap more important ones on screen"><input type="checkbox" id="declutter" checked> Hide Overlapping Labels</label>
    </div>
  </div>
  </div>
</div>
<div id="finder">
  <div id="search">
    <input id="searchInput" type="text" placeholder="Search branches, commits, authors (Ctrl+F)" autocomplete="off" spellcheck="false">
    <div id="searchResults" class="hidden"></div>
  </div>
  <div id="filter" title="Filter by branch or author; multiple filters combine (any branch AND any author)">
    <div id="filterChips"></div>
    <input id="filterInput" type="text" placeholder="Filter branch / author" autocomplete="off" spellcheck="false">
    <div id="filterResults" class="hidden"></div>
    <span id="filterCount"></span>
  </div>
</div>
<button id="sideToggle" title="Collapse / expand the sidebar (N)"></button>
<div id="sidebar">
  <div id="sideResize" title="Drag to resize"></div>
  <div class="panel" id="itemPanel">
    <div class="panel-head">Item</div>
    <div id="info" class="panel-body"></div>
  </div>
  <div id="sideSplit" title="Drag to resize"></div>
  <div class="panel" id="actionsPanel">
    <div class="panel-head">Actions</div>
    <div id="actions" class="panel-body"></div>
  </div>
</div>
<button id="eyeBtn" class="icon-btn" title="Hide / show the interface (H)"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 8s2.6-4.8 7-4.8S15 8 15 8s-2.6 4.8-7 4.8S1 8 1 8z"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path class="slash" d="M2.5 13.5l11-11"/></svg></button>
<div id="legend" class="hidden"></div>
<canvas id="gizmo" title="Click an axis to view from that side"></canvas>
<div id="pins" class="hidden"></div>
<div id="hint"><span><b>Scroll</b> Zoom</span><span><b>LMB drag</b> Pan / move node</span><span><b>RMB drag</b> Tilt &amp; orbit</span><span><b>Dbl-click</b> Commit view</span><span><b>RMB</b> Actions</span><span><b>P</b> Pin branch</span><span><b>N</b> Sidebar</span><span><b>H</b> Hide UI</span><span><b>Esc</b> Deselect</span></div>
<div id="menu" class="hidden"></div>
<div id="tooltip" class="hidden"></div>
<script type="module" nonce="${nonce}" src="${uri('media', 'main.js')}"></script>
</body>
</html>`;
}

function deactivate() {
  repoListener?.dispose();
}

// --- commit view: header, message, file tree and unified diff in its own tab ---
let commitPanel;
let commitView = { root: undefined, hash: undefined, parent: undefined, select: undefined, ready: false };
const MAX_DIFF_CHARS = 4 * 1024 * 1024;

function openCommitView(context, root, hash, select) {
  commitView.root = root;
  commitView.hash = hash;
  commitView.select = select;
  if (commitPanel) {
    commitPanel.reveal(vscode.ViewColumn.Active, false);
    if (commitView.ready) loadCommitView();
    return;
  }
  commitView.ready = false;
  commitPanel = vscode.window.createWebviewPanel('gitxyz.commit', `Commit ${hash.slice(0, 8)}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
  });
  commitPanel.webview.html = getCommitHtml(commitPanel.webview, context.extensionUri);
  commitPanel.webview.onDidReceiveMessage(handleCommitViewMessage);
  commitPanel.onDidDispose(() => { commitPanel = undefined; });
}

async function loadCommitView() {
  const { root, hash } = commitView;
  const post = m => commitPanel?.webview.postMessage(m);
  const stale = () => commitView.hash !== hash || !commitPanel;
  try {
    const out = await git(root, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', hash]);
    const [full, parents, author, email, at, committer, cemail, ct, body] = out.split(FS);
    const parentList = parents.trim().split(' ').filter(Boolean);
    const { files } = await commitDetails(root, full, parentList[0]);
    if (stale()) return;
    commitView.parent = parentList[0];
    commitPanel.title = `Diff - ${full.slice(0, 8)}`;
    const select = commitView.select;
    commitView.select = undefined;
    post({
      type: 'commit',
      select,
      commit: { hash: full, parents: parentList, author, email, date: Number(at) * 1000, committer, cemail, cdate: Number(ct) * 1000, body: body.trim() },
      files
    });
    // these can be slow on big repos, so they follow separately
    const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean);
    const [branches, tags, describe] = await Promise.all([
      git(root, ['branch', '-a', '--contains', full, '--format=%(refname:short)']).catch(() => ''),
      git(root, ['tag', '--contains', full]).catch(() => ''),
      git(root, ['describe', '--tags', '--long', full]).catch(() => '')
    ]);
    if (stale()) return;
    const m = /^(.*)-(\d+)-g[0-9a-f]+$/.exec(describe.trim());
    post({ type: 'refs', hash: full, branches: lines(branches), tags: lines(tags), derives: m ? { tag: m[1], count: Number(m[2]) } : null });
  } catch (e) {
    post({ type: 'error', message: e.message });
  }
}

async function handleCommitViewMessage(msg) {
  const { root, hash, parent } = commitView;
  if (msg.type === 'ready') {
    commitView.ready = true;
    if (hash) loadCommitView();
  } else if (msg.type === 'open' && isHash(msg.hash)) {
    commitView.hash = msg.hash;
    loadCommitView();
  } else if (msg.type === 'fileDiff' && typeof msg.path === 'string') {
    try {
      let text = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', parent || EMPTY_TREE, hash, '--', msg.path]);
      const truncated = text.length > MAX_DIFF_CHARS;
      if (truncated) text = text.slice(0, MAX_DIFF_CHARS);
      commitPanel?.webview.postMessage({ type: 'fileDiff', hash, path: msg.path, text, truncated });
    } catch (e) {
      commitPanel?.webview.postMessage({ type: 'fileDiff', hash, path: msg.path, text: '', error: e.message });
    }
  } else if (msg.type === 'openDiff' && typeof msg.path === 'string') {
    openDiff(root, { hash, parent, path: msg.path }).catch(e => vscode.window.showErrorMessage(`GitXYZ: ${e.message}`));
  } else if (msg.type === 'openChanges') {
    openChanges(root, { hash, parent, subject: msg.subject }).catch(e => vscode.window.showErrorMessage(`GitXYZ: ${e.message}`));
  } else if (msg.type === 'copy' && typeof msg.text === 'string') {
    vscode.env.clipboard.writeText(msg.text);
  }
}

function getCommitHtml(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, ...p));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('media', 'commit.css')}">
</head>
<body>
<div id="top">
<div id="header">
  <div id="avatar"></div>
  <div id="meta"></div>
  <div id="actions"><button id="openAll" title="Open every changed file in VS Code's multi-file diff editor">Open in VS Code</button></div>
</div>
<div id="message"></div>
<div id="refs"><div id="branches">Contained in branches: \u2026</div><div id="tags"></div><div id="derives"></div></div>
</div>
<div id="topSplit" class="hsplit" title="Drag to resize"></div>
<div id="panes">
  <div id="treePane">
    <div id="treeHead"><span id="fileCount"></span><input id="treeFilter" class="filter" type="text" placeholder="Filter files" spellcheck="false"></div>
    <div id="tree" class="tree" tabindex="0"></div>
  </div>
  <div id="splitter"></div>
  <div id="diffPane">
    <div id="diffHead" class="diff-head"></div>
    <div id="diff" class="diff"></div>
  </div>
</div>
<script nonce="${nonce}" src="${uri('media', 'diffkit.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'commit.js')}"></script>
</body>
</html>`;
}

// --- tool windows: Git Extensions style "Commit" and "Stash" dialogs in editor tabs ---
const toolPanels = new Map(); // key -> { panel, root, post, refresh }
const Q = ['-c', 'core.quotePath=false'];
const isPathList = p => Array.isArray(p) && p.length > 0 && p.every(x => typeof x === 'string' && x.length > 0);

function toolPanel(root, key, title, script, body, handler) {
  let entry = toolPanels.get(key);
  if (entry) {
    entry.root = root;
    entry.panel.reveal(vscode.ViewColumn.Active);
    entry.refresh();
    return entry;
  }
  const extUri = extContext.extensionUri;
  const p = vscode.window.createWebviewPanel(`gitxyz.${key}`, title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')]
  });
  entry = { panel: p, root, ready: false, post: m => p.webview.postMessage(m), refresh: () => {} };
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...f) => p.webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', ...f));
  p.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('commit.css')}">
<link rel="stylesheet" href="${uri('tools.css')}">
</head>
<body>
${body}
<script nonce="${nonce}" src="${uri('diffkit.js')}"></script>
<script nonce="${nonce}" src="${uri(script)}"></script>
</body>
</html>`;
  const current = entry;
  p.webview.onDidReceiveMessage(async msg => {
    try {
      if (msg.type === 'ready') current.ready = true;
      await handler(current, msg);
    } catch (e) {
      vscode.window.showErrorMessage(`GitXYZ: ${e.message}`);
      refresh();
    }
  });
  p.onDidDispose(() => toolPanels.delete(key));
  toolPanels.set(key, entry);
  return entry;
}

async function diffFiles(root, args) {
  const run = mode => git(root, [...Q, 'diff', '--no-renames', mode, ...args]);
  const [status, numstat] = await Promise.all([run('--name-status'), run('--numstat')]);
  return parseChanges(status, numstat);
}

async function untrackedFiles(root) {
  return lines(await git(root, [...Q, 'ls-files', '--others', '--exclude-standard']))
    .map(p => ({ path: p, status: '?', add: 0, del: 0, untracked: true }));
}

async function diffText(root, args) {
  const text = await git(root, [...Q, 'diff', '--no-color', '--no-ext-diff', ...args]);
  const truncated = text.length > MAX_DIFF_CHARS;
  return { text: truncated ? text.slice(0, MAX_DIFF_CHARS) : text, truncated };
}

// git has nothing to diff an untracked file against, so build a "new file" diff from its content.
async function untrackedDiff(root, rel) {
  const file = path.resolve(root, rel);
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Invalid path.');
  const stat = await fs.promises.lstat(file);
  if (stat.isSymbolicLink()) return { note: 'Untracked symbolic link' };
  if (stat.isDirectory()) return { note: 'Untracked folder (nested repository?)' };
  const len = Math.min(stat.size, MAX_DIFF_CHARS);
  const buf = Buffer.alloc(len);
  const fh = await fs.promises.open(file, 'r');
  try {
    await fh.read(buf, 0, len, 0);
  } finally {
    await fh.close();
  }
  if (buf.includes(0)) return { note: 'Binary file' };
  const body = buf.toString('utf8').split('\n');
  if (body[body.length - 1] === '') body.pop();
  const text = `new file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${body.length} @@\n` + body.map(l => '+' + l.replace(/\r$/, '')).join('\n') + '\n';
  return { text, truncated: stat.size > len };
}

async function hasHead(root) {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
}

// --- commit window ---
function openWorktreeWindow(root) {
  const entry = toolPanel(root, 'commitChanges', 'Commit', 'worktree.js', `
<div id="layout">
  <div id="left">
    <div id="unstagedBox" class="box">
      <div class="bar"><span class="title">Working directory changes</span><span id="unstagedCount" class="count"></span></div>
      <div class="bar"><input id="unstagedFilter" class="filter" type="text" placeholder="Filter files" spellcheck="false"></div>
      <div id="unstaged" class="tree" tabindex="0"></div>
    </div>
    <div id="leftSplit" class="hsplit"></div>
    <div class="bar stage-bar">
      <button id="unstageAll" title="Unstage all">&#8648;</button>
      <button id="unstageBtn" title="Unstage the selected files">&#8593; Unstage</button>
      <span class="grow"></span>
      <button id="stageBtn" title="Stage the selected files">&#8595; Stage</button>
      <button id="stageAll" title="Stage all">&#8650;</button>
    </div>
    <div id="stagedBox" class="box">
      <div class="bar"><span class="title">Staged</span><span id="stagedCount" class="count"></span></div>
      <div id="staged" class="tree" tabindex="0"></div>
    </div>
  </div>
  <div id="splitter" class="vsplit"></div>
  <div id="right">
    <div id="diffHead" class="diff-head"></div>
    <div id="diff" class="diff"></div>
    <div id="rightSplit" class="hsplit"></div>
    <div id="commitArea">
      <div id="commitButtons">
        <button id="commitBtn" class="primary" title="Commit the staged changes (Ctrl+Enter)">Commit</button>
        <button id="commitPushBtn">Commit &amp; push</button>
        <label class="check"><input type="checkbox" id="amend"> Amend commit</label>
        <span class="grow"></span>
        <button id="resetAll" title="Discard all staged and unstaged changes">Reset all changes</button>
        <button id="resetUnstaged" title="Discard unstaged changes; staged changes stay">Reset unstaged changes</button>
        <button id="refreshBtn" title="Refresh (F5)">&#10227; Refresh</button>
      </div>
      <textarea id="commitMsg" placeholder="Enter commit message" spellcheck="true"></textarea>
    </div>
  </div>
</div>
<div id="statusBar"><span id="committer"></span><span id="branchInfo"></span><span class="grow"></span><span id="stagedInfo"></span></div>`,
  handleWorktreeMessage);
  entry.refresh = () => entry.ready && loadWorktree(entry).catch(e => entry.post({ type: 'error', message: e.message }));
}

async function loadWorktree(entry) {
  const root = entry.root;
  const [unstaged, staged, untracked, status, name, email] = await Promise.all([
    diffFiles(root, []),
    diffFiles(root, ['--cached']),
    untrackedFiles(root),
    git(root, ['status', '--porcelain=v1', '-b', '-uno']),
    git(root, ['config', 'user.name']).catch(() => ''),
    git(root, ['config', 'user.email']).catch(() => '')
  ]);
  entry.post({
    type: 'state',
    unstaged: [...unstaged, ...untracked],
    staged,
    head: parseBranchHead(status.split('\n')[0]),
    committer: { name: name.trim(), email: email.trim() }
  });
}

async function handleWorktreeMessage(entry, msg) {
  const root = entry.root;
  switch (msg.type) {
    case 'ready':
    case 'refresh':
      return entry.refresh();
    case 'diff': {
      if (typeof msg.path !== 'string') return;
      let result;
      try {
        if (msg.untracked) result = await untrackedDiff(root, msg.path);
        else result = await diffText(root, [...(msg.area === 'staged' ? ['--cached'] : []), '--', msg.path]);
      } catch (e) {
        result = { error: e.message };
      }
      return entry.post({ type: 'diff', key: msg.key, ...result });
    }
    case 'stage':
      if (!isPathList(msg.paths)) return;
      await git(root, ['add', '-A', '--', ...msg.paths]);
      return refresh();
    case 'unstage':
      if (!isPathList(msg.paths)) return;
      await git(root, ['reset', '-q', '--', ...msg.paths]);
      return refresh();
    case 'stageAll':
      await git(root, ['add', '-A']);
      return refresh();
    case 'unstageAll':
      await git(root, ['reset', '-q']);
      return refresh();
    case 'amendMessage': {
      const text = await git(root, ['log', '-1', '--format=%B']).catch(() => '');
      return entry.post({ type: 'amendMessage', text: text.trim() });
    }
    case 'commit':
      return commitChanges(entry, msg);
    case 'resetAll': {
      const pick = await vscode.window.showWarningMessage('Reset all changes? Staged and unstaged changes are discarded. This cannot be undone.',
        { modal: true }, 'Reset, keep new files', 'Reset and delete new files');
      if (!pick) return;
      await git(root, ['reset', '--hard', 'HEAD']);
      if (pick === 'Reset and delete new files') await git(root, ['clean', '-fd']);
      return refresh();
    }
    case 'resetUnstaged': {
      const pick = await vscode.window.showWarningMessage('Discard all unstaged changes? Staged changes are kept. This cannot be undone.',
        { modal: true }, 'Discard, keep new files', 'Discard and delete new files');
      if (!pick) return;
      await git(root, ['checkout', '--', '.']);
      if (pick === 'Discard and delete new files') await git(root, ['clean', '-fd']);
      return refresh();
    }
    case 'openFile':
      if (typeof msg.path !== 'string') return;
      return vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(vscode.Uri.file(root), msg.path));
  }
}

async function commitChanges(entry, { message, amend, push: andPush }) {
  const root = entry.root;
  if (typeof message !== 'string' || !message.trim()) return void vscode.window.showWarningMessage('Enter a commit message.');
  const staged = lines(await git(root, ['diff', '--cached', '--name-only']));
  if (!staged.length && !amend) {
    const pick = await vscode.window.showWarningMessage('There are no staged changes. Stage all changes and commit?', { modal: true }, 'Stage all and commit');
    if (!pick) return;
    await git(root, ['add', '-A']);
  }
  await git(root, ['commit', ...(amend ? ['--amend'] : []), '-F', '-'], message);
  entry.post({ type: 'committed' });
  refresh();
  if (andPush && (await push(root, {}))) refresh();
}

// --- stash window ---
function openStashWindow(root) {
  const entry = toolPanel(root, 'stashes', 'Stash', 'stash.js', `
<div id="layout">
  <div id="left">
    <div class="bar"><span class="title">Show:</span><select id="stashSelect"></select><button id="refreshBtn" title="Refresh (F5)">&#10227;</button></div>
    <div class="bar"><span id="fileCount" class="count"></span><input id="filter" class="filter" type="text" placeholder="Filter files" spellcheck="false"></div>
    <div id="tree" class="tree" tabindex="0"></div>
    <div id="leftSplit" class="hsplit"></div>
    <div id="stashArea">
      <textarea id="stashMsg" spellcheck="true"></textarea>
      <label class="check"><input type="checkbox" id="keepIndex"> Keep index</label>
      <label class="check"><input type="checkbox" id="includeUntracked" checked> Include untracked files</label>
      <div class="buttons">
        <button id="stashAll" class="primary">Stash all changes</button>
        <button id="stashSelected" title="Stash only the files selected above">Stash selected changes</button>
        <button id="dropBtn">Drop selected stash</button>
        <button id="applyBtn">Apply selected stash</button>
        <button id="popBtn" title="Apply the stash and drop it">Pop selected stash</button>
      </div>
    </div>
  </div>
  <div id="splitter" class="vsplit"></div>
  <div id="right">
    <div id="diffHead" class="diff-head"></div>
    <div id="diff" class="diff"></div>
  </div>
</div>`,
  handleStashMessage);
  entry.refresh = () => entry.ready && loadStashes(entry).catch(e => entry.post({ type: 'error', message: e.message }));
}

async function stashList(root) {
  return lines(await git(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%s'])).map(l => {
    const [ref, hash, subject] = l.split(FS);
    return { ref, hash, subject };
  });
}

async function loadStashes(entry) {
  const [stashes, status] = await Promise.all([stashList(entry.root), git(entry.root, ['status', '--porcelain=v1'])]);
  entry.post({ type: 'state', stashes, changes: lines(status).length });
}

async function stashParents(root, hash) {
  return (await git(root, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
}

async function handleStashMessage(entry, msg) {
  const root = entry.root;
  const wd = msg.sel === 'wd';
  if (msg.sel !== undefined && !wd && !isHash(msg.sel)) return;
  switch (msg.type) {
    case 'ready':
    case 'refresh':
      return entry.refresh();
    case 'files': {
      let files;
      if (wd) {
        files = [...(await diffFiles(root, [(await hasHead(root)) ? 'HEAD' : '--cached'])), ...(await untrackedFiles(root))];
      } else {
        const parents = await stashParents(root, msg.sel);
        files = (await commitDetails(root, msg.sel, parents[0])).files;
        // a stash made with --include-untracked keeps the new files in a third parent
        if (parents[2]) files.push(...lines(await git(root, [...Q, 'ls-tree', '-r', '--name-only', parents[2]])).map(p => ({ path: p, status: '?', add: 0, del: 0, untracked: true })));
      }
      return entry.post({ type: 'files', key: msg.key, files });
    }
    case 'diff': {
      if (typeof msg.path !== 'string') return;
      let result;
      try {
        if (wd) {
          result = msg.untracked ? await untrackedDiff(root, msg.path) : await diffText(root, [(await hasHead(root)) ? 'HEAD' : '--cached', '--', msg.path]);
        } else {
          const parents = await stashParents(root, msg.sel);
          result = await diffText(root, msg.untracked ? [EMPTY_TREE, parents[2], '--', msg.path] : [parents[0], msg.sel, '--', msg.path]);
        }
      } catch (e) {
        result = { error: e.message };
      }
      return entry.post({ type: 'diff', key: msg.key, ...result });
    }
    case 'stash': {
      if (msg.paths !== undefined && !isPathList(msg.paths)) return;
      const message = typeof msg.message === 'string' ? msg.message.trim() : '';
      await git(root, ['stash', 'push',
        ...(msg.keepIndex ? ['--keep-index'] : []),
        ...(msg.untracked ? ['--include-untracked'] : []),
        ...(message ? ['-m', message] : []),
        ...(msg.paths ? ['--', ...msg.paths] : [])]);
      entry.post({ type: 'stashed' });
      return refresh();
    }
    case 'apply':
    case 'pop':
    case 'drop': {
      const stash = (await stashList(root)).find(s => s.hash === msg.sel);
      if (!stash) return refresh();
      if (msg.type === 'drop' && !(await confirm(`Drop ${stash.ref} (${stash.subject})? This cannot be undone.`))) return;
      await git(root, ['stash', msg.type, stash.ref]);
      return refresh();
    }
  }
}

module.exports = { activate, deactivate };
