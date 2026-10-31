// Fixture app for the Electron adapter tests: two windows, screens reached only by clicking, no addresses.
// It has planted problems. Which ones, and where, is written in ../answers.json, not here.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

let apiBase = '';

const outside = (process.argv.find((a) => a.startsWith('--outside=')) || '').slice('--outside='.length);
const open = (title, file, w = 900, h = 650) => {
  const win = new BrowserWindow({ width: w, height: h, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), additionalArguments: [`--api=${apiBase}`, `--outside=${outside}`] } });
  win.loadFile(path.join(__dirname, file));
  return win;
};

app.whenReady().then(async () => {
  // The app's own data comes from a server on the loopback address, started here; the windows have no address bar.
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0].replace(/^\/api/, '');
    const body = p === '/tasks' ? JSON.stringify([{ id: 1, title: 'Write report' }, { id: 2, title: 'Send invoice' }]) : JSON.stringify({ ok: true, path: p });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${server.address().port}/api`;
  ipcMain.handle('choose-file', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] });
    return r.canceled ? 'No file chosen' : r.filePaths[0];
  });
  ipcMain.handle('open-inspector', () => { open('Inspector', 'inspector.html', 600, 500); });
  open('Workbench', 'index.html');
  // What the app can see of the machine it runs on: reported, never read by the adapter.
  const tokenFile = path.join(os.homedir(), '.fake-token');
  console.log('env-secret:', process.env.RR_SECRET_PARENT || 'absent');
  console.log('token-file:', fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : 'absent');
  // A request from the main process to an outside address.
  if (outside) fetch(outside + '/main').then(() => console.log('main-process fetch to outside address: answered'), (e) => console.log('main-process fetch to outside address: failed', (e.cause && e.cause.code) || e.message));
});
app.on('window-all-closed', () => app.quit());
