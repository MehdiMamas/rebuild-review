// Fixture app for the Electron adapter tests: two windows, screens reached only by clicking, no addresses.
// It has planted problems. Which ones, and where, is written in ../answers.json, not here.
const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('node:path');

protocol.registerSchemesAsPrivileged([{ scheme: 'fixture', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const outside = (process.argv.find((a) => a.startsWith('--outside=')) || '').slice('--outside='.length);
const open = (title, file, w = 900, h = 650) => {
  const win = new BrowserWindow({ width: w, height: h, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
  win.loadFile(path.join(__dirname, file));
  return win;
};

app.whenReady().then(() => {
  // The app's own data comes through a custom scheme, so a renderer request has no network address.
  protocol.handle('fixture', (req) => {
    const p = new URL(req.url).pathname;
    const body = p === '/tasks' ? JSON.stringify([{ id: 1, title: 'Write report' }, { id: 2, title: 'Send invoice' }]) : JSON.stringify({ ok: true, path: p });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  ipcMain.handle('choose-file', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] });
    return r.canceled ? 'No file chosen' : r.filePaths[0];
  });
  ipcMain.handle('open-inspector', () => { open('Inspector', 'inspector.html', 600, 500); });
  open('Workbench', 'index.html');
  // A request from the main process to an outside address.
  if (outside) fetch(outside).then(() => console.log('main-process fetch to outside address: answered'), (e) => console.log('main-process fetch to outside address: failed', (e.cause && e.cause.code) || e.message));
});
app.on('window-all-closed', () => app.quit());
