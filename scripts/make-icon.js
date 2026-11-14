// Renders assets/icon.svg into PNGs and a multi-size Windows .ico.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// ICO files can hold PNG images directly (supported since Windows Vista)
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const sizes = [...new Set([...ICO_SIZES, 512])];
  const result = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(SVG)};
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const out = {};
    for (const size of ${JSON.stringify(sizes)}) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, size, size);
      out[size] = c.toDataURL('image/png');
    }
    return out;
  })()`);
  const png = (size) => Buffer.from(result[size].split(',')[1], 'base64');
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png(512));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), png(256));
  console.log('icons written: build/icon.ico, build/icon.png, assets/icon.png');
  app.exit(0);
});
