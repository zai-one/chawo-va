// «MCP-сервер» block on the «Сеть» page: the opt-in switch (McpEnabled) and the ready config
// snippet for Claude Desktop / Cursor with a copy button. The server itself is `chawo-va mcp`
// (stdio, read-only), started by the assistant; the app never listens for it.

import { app, clipboard, ipcMain } from 'electron';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { configSnippet, launchFor } from './mcp/mcpServer';

export interface McpStateDto {
  enabled: boolean;
  snippet: string;
  copied: boolean;
}

export function registerMcpIpc(settings: { get: () => SettingsData }): void {
  let copied = false;
  const snippet = () => {
    // Same data folders as this app instance (portable / test profiles set them).
    const l = launchFor(process.execPath, app.getAppPath(), {
      CHAWO_APPDATA: process.env.CHAWO_APPDATA,
      CHAWO_LOCALAPPDATA: process.env.CHAWO_LOCALAPPDATA,
      CHAWO_MEETINGS_DIR: process.env.CHAWO_MEETINGS_DIR,
    });
    return configSnippet(l.command, l.args, l.env);
  };
  const state = (): McpStateDto => ({ enabled: settings.get().McpEnabled, snippet: snippet(), copied });
  ipcMain.handle('mcp:state', () => state());
  ipcMain.handle('mcp:enable', (_e, on: unknown) => {
    if (typeof on === 'boolean') {
      const s = settings.get();
      s.McpEnabled = on;
      Settings.save(s);
    }
    copied = false;
    return state();
  });
  ipcMain.handle('mcp:copy', async () => {
    await clipboard.writeText(snippet());
    copied = true;
    return state();
  });
}
