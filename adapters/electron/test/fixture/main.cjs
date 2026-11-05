// Fixture app for the Electron adapter tests: two windows, screens reached only by clicking, no addresses.
// It has planted problems. Which ones, and where, is written in ../answers.json, not here.
const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

let apiBase = '';
let reloading = false;
// A custom scheme the app serves from its main process; run.json launch.schemes names it.
protocol.registerSchemesAsPrivileged([{ scheme: 'rrapp', privileges: { standard: true, secure: true } }]);

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
  protocol.handle('rrapp', () => new Response('<!doctype html><html><head><meta charset="utf-8"><title>Scheme page</title></head><body><h1>Scheme page</h1><p>Served over a custom scheme.</p></body></html>', { headers: { 'content-type': 'text/html' } }));
  ipcMain.handle('open-scheme', () => { const w = new BrowserWindow({ width: 600, height: 400 }); w.loadURL('rrapp://app/page'); });
  // Closes the window it was asked from; the app quits with its last window (window-all-closed below).
  ipcMain.handle('close-window', (e) => { BrowserWindow.fromWebContents(e.sender).close(); });
  // A reload that replaces the window: no window exists for 3 s, then the app opens a new one.
  ipcMain.handle('reload-window', (e) => {
    reloading = true;
    BrowserWindow.fromWebContents(e.sender).destroy();
    setTimeout(() => { open('Workbench', 'index.html'); reloading = false; }, 3000);
  });
  ipcMain.handle('open-inspector', () => { open('Inspector', 'inspector.html', 600, 500); });
  // A helper window that opens first and closes itself, the way an editor's helper process does. No buttons, no problems.
  const helper = new BrowserWindow({ width: 300, height: 200, show: true, title: 'rr-helper' });
  helper.loadURL('data:text/html,<title>rr-helper</title>');
  setTimeout(() => { if (!helper.isDestroyed()) helper.close(); }, 300);
  open('Workbench', 'index.html');
  // What the app can see of the machine it runs on: reported, never read by the adapter.
  const tokenFile = path.join(os.homedir(), '.fake-token');
  console.log('fixture-env:', process.env.RR_FIXTURE_ENV || 'absent');
  console.log('env-secret:', process.env.RR_SECRET_PARENT || 'absent');
  console.log('token-file:', fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : 'absent');
  // A request from the main process to an outside address.
  if (outside) fetch(outside + '/main').then(() => console.log('main-process fetch to outside address: answered'), (e) => console.log('main-process fetch to outside address: failed', (e.cause && e.cause.code) || e.message));
});
app.on('window-all-closed', () => { if (!reloading) app.quit(); });
