// Smoke scripts call ipcMain handlers directly. Main checks that a call comes from the app's own page,
// so the fake event carries the main window's frame, exactly as a real call from that window would.
const { BrowserWindow } = require('electron');

function appEvent() {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /\/index\.html$/.test(x.webContents.getURL()));
  if (!w) throw new Error('appEvent: the main window is not open yet');
  return { sender: w.webContents, senderFrame: w.webContents.mainFrame };
}

module.exports = { appEvent };
