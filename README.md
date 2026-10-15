# GitXYZ

A VS Code extension that shows your git graph in 3D (three.js). It navigates like Blender and works like Git Extensions.

## Features

- 3D commit graph with search, branch/author filters, pinned branches and several colour and layout modes
- Side panel with commit info, changed files and actions (checkout, branch, tag, cherry-pick, revert, reset, merge, rebase)
- Commit view with a file tree and diff; the Commit and Stash windows follow Git Extensions
- Fetch, pull, push and a Commands menu with the usual git tools

## Run from source

```powershell
npm install
```

Press F5 in VS Code to start the Extension Development Host, then run **GitXYZ: Open 3D Graph** from the Command Palette (or the button in the Source Control title bar).

## Build and install

```powershell
.\build.ps1            # creates gitxyz-<version>.vsix
.\build.ps1 -Install   # also installs it into VS Code
```

Requires Node.js and the `code` command on your PATH for `-Install`.

## Controls

| Input | Action |
| --- | --- |
| Scroll | Zoom |
| Left drag | Pan / move a node |
| Right drag | Tilt and orbit |
| Double-click | Open the commit view |
| Right-click | Actions menu |
| P | Pin branch |
| N | Toggle sidebar |
| H | Hide interface |
| F5 | Refresh |
| Esc | Deselect |
