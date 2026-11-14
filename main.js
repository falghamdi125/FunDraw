const { app, BrowserWindow, ipcMain, screen, clipboard, nativeImage, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const LEARN_HEIGHT = 260;
const dataFile = () => path.join(app.getPath('userData'), 'canvas.json');
const learnSizeFile = () => path.join(app.getPath('userData'), 'learn-size.json');

// Size of the learn-mode strip the last time it was used (position is never remembered)
function loadLearnSize() {
  try {
    const s = JSON.parse(fs.readFileSync(learnSizeFile(), 'utf8'));
    if (s.width > 0 && s.height > 0) return s;
  } catch {}
  return null;
}
function saveLearnSize(size) {
  try {
    fs.writeFileSync(learnSizeFile(), JSON.stringify(size), 'utf8');
  } catch {}
}

let win;
let normalBounds = null;
let wasMaximized = false;
let learnMode = false;

function overlayColors(dark) {
  return dark
    ? { color: '#1e1f24', symbolColor: '#e6e6e6', height: 52 }
    : { color: '#f7f7f9', symbolColor: '#222222', height: 52 };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 150,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(false),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('close', () => {
    if (learnMode) {
      const b = win.getBounds();
      saveLearnSize({ width: b.width, height: b.height });
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// The app used to be called "Math Pad" and stored its data in %APPDATA%\math-pad.
// On the first FunDraw start, copy the boards over (the old folder is left as a backup).
function migrateFromMathPad() {
  const userData = app.getPath('userData');
  if (path.basename(userData) !== 'FunDraw') return; // a custom data folder (tests): leave it alone
  const old = path.join(app.getPath('appData'), 'math-pad');
  if (fs.existsSync(path.join(userData, 'boards.json')) || !fs.existsSync(old)) return;
  try {
    fs.mkdirSync(userData, { recursive: true });
    if (fs.existsSync(path.join(old, 'boards'))) {
      fs.cpSync(path.join(old, 'boards'), path.join(userData, 'boards'), { recursive: true });
    }
    for (const f of ['boards.json', 'learn-size.json', 'canvas.json']) {
      if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(userData, f));
    }
  } catch (err) {
    console.error('Could not copy data from Math Pad', err);
  }
}

app.whenReady().then(() => {
  migrateFromMathPad();
  Menu.setApplicationMenu(null); // the app handles its own shortcuts (Ctrl+V, Ctrl+0, ...)
  createWindow();
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('set-theme', (_e, dark) => {
  if (!win) return;
  win.setTitleBarOverlay(overlayColors(dark));
  win.setBackgroundColor(dark ? '#16171b' : '#ffffff');
});

ipcMain.handle('set-learn-mode', (_e, on) => {
  if (!win || on === learnMode) return learnMode;
  learnMode = on;
  if (on) {
    // Keep the window exactly where it is (same x, y and width); only shrink the height.
    wasMaximized = win.isMaximized();
    const current = win.getBounds();
    normalBounds = wasMaximized ? win.getNormalBounds() : current;
    if (wasMaximized) win.unmaximize();
    const saved = loadLearnSize();
    const { workArea } = screen.getDisplayMatching(current);
    win.setBounds({
      x: current.x,
      y: current.y,
      width: saved ? Math.min(saved.width, workArea.width) : current.width,
      height: saved ? Math.min(saved.height, workArea.height) : Math.min(LEARN_HEIGHT, current.height),
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setMaximizable(false);
  } else {
    const strip = win.getBounds();
    saveLearnSize({ width: strip.width, height: strip.height });
    win.setAlwaysOnTop(false);
    win.setMaximizable(true);
    if (wasMaximized) {
      win.maximize();
    } else if (normalBounds) {
      // Restore the size but leave the window where the strip is now, kept on screen.
      const cur = win.getBounds();
      const { workArea } = screen.getDisplayMatching(cur);
      const width = Math.min(normalBounds.width, workArea.width);
      const height = Math.min(normalBounds.height, workArea.height);
      win.setBounds({
        x: Math.min(Math.max(cur.x, workArea.x), workArea.x + workArea.width - width),
        y: Math.min(Math.max(cur.y, workArea.y), workArea.y + workArea.height - height),
        width,
        height,
      });
    }
  }
  return learnMode;
});

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('set-opacity', (_e, value) => {
  if (win) win.setOpacity(value);
});

// ---------- Boards: one JSON file per board, plus an index ----------
const boardsDir = () => path.join(app.getPath('userData'), 'boards');
const indexFile = () => path.join(app.getPath('userData'), 'boards.json');
const boardFile = (id) => path.join(boardsDir(), id.replace(/[^a-z0-9]/gi, '') + '.json');

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
let boardIndex = null;
function getIndex() {
  if (boardIndex) return boardIndex;
  fs.mkdirSync(boardsDir(), { recursive: true });
  try {
    boardIndex = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
  } catch {
    boardIndex = null;
  }
  if (!boardIndex || !Array.isArray(boardIndex.boards) || !boardIndex.boards.length) {
    const id = newId();
    // first run with boards: the existing single canvas becomes the first board
    if (fs.existsSync(dataFile())) fs.copyFileSync(dataFile(), boardFile(id));
    boardIndex = { current: id, boards: [{ id, name: 'My board', updated: Date.now() }] };
    saveIndex();
  }
  if (!boardIndex.boards.some((b) => b.id === boardIndex.current)) boardIndex.current = boardIndex.boards[0].id;
  return boardIndex;
}
function saveIndex() {
  writeAtomic(indexFile(), JSON.stringify(boardIndex, null, 1));
}
function saveBoard(id, json) {
  const idx = getIndex();
  const entry = idx.boards.find((b) => b.id === id);
  if (!entry) return;
  writeAtomic(boardFile(id), json);
  entry.updated = Date.now();
  saveIndex();
}

ipcMain.handle('boards-list', () => getIndex());

ipcMain.handle('board-load', async (_e, id) => {
  await writeChain;
  const idx = getIndex();
  if (!idx.boards.some((b) => b.id === id)) id = idx.current;
  idx.current = id;
  saveIndex();
  let json = null;
  try {
    json = fs.readFileSync(boardFile(id), 'utf8');
  } catch {}
  return { id, json };
});

// Saves are written in the background, one after another, so the app never waits on the disk
let writeChain = Promise.resolve();
let saveSeq = 0; // a newer save (including the one on close) makes older queued saves skip
function saveBoardAsync(id, json) {
  const mySeq = ++saveSeq;
  writeChain = writeChain
    .then(async () => {
      if (mySeq !== saveSeq) return;
      const idx = getIndex();
      const entry = idx.boards.find((b) => b.id === id);
      if (!entry) return;
      const file = boardFile(id);
      await fs.promises.writeFile(file + '.tmp', json, 'utf8');
      await fs.promises.rename(file + '.tmp', file);
      entry.updated = Date.now();
      await fs.promises.writeFile(indexFile() + '.tmp', JSON.stringify(idx, null, 1), 'utf8');
      await fs.promises.rename(indexFile() + '.tmp', indexFile());
    })
    .catch((err) => console.error('save failed', err));
  return writeChain;
}
ipcMain.handle('board-save', (_e, id, json) => saveBoardAsync(id, json));

ipcMain.on('board-save-sync', (e, id, json) => {
  saveSeq++;
  try {
    saveBoard(id, json);
  } finally {
    e.returnValue = true;
  }
});

ipcMain.handle('board-create', (_e, name) => {
  const idx = getIndex();
  const id = newId();
  idx.boards.push({ id, name: String(name || 'Untitled').slice(0, 80), updated: Date.now() });
  saveIndex();
  return id;
});

ipcMain.handle('board-rename', (_e, id, name) => {
  const entry = getIndex().boards.find((b) => b.id === id);
  if (entry && String(name).trim()) {
    entry.name = String(name).trim().slice(0, 80);
    saveIndex();
  }
  return getIndex();
});

ipcMain.handle('board-delete', (_e, id) => {
  const idx = getIndex();
  idx.boards = idx.boards.filter((b) => b.id !== id);
  try {
    fs.unlinkSync(boardFile(id));
  } catch {}
  if (!idx.boards.length) idx.boards.push({ id: newId(), name: 'My board', updated: Date.now() });
  if (idx.current === id) idx.current = idx.boards[0].id;
  saveIndex();
  return idx;
});

ipcMain.handle('read-clipboard', () => {
  const img = clipboard.readImage();
  return { image: img.isEmpty() ? null : img.toDataURL(), text: clipboard.readText() };
});

// Puts a picture of the copied strokes on the clipboard, plus a marker text so the
// app can recognise its own copy and paste editable strokes instead of a picture.
ipcMain.handle('write-clipboard', (_e, dataURL, marker) => {
  clipboard.write({
    image: dataURL ? nativeImage.createFromDataURL(dataURL) : undefined,
    text: marker,
  });
});

ipcMain.handle('save-png', async (_e, dataURL) => {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export as PNG',
    defaultPath: path.join(app.getPath('pictures'), `FunDraw ${stamp}.png`),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, Buffer.from(dataURL.split(',')[1], 'base64'));
  return true;
});
