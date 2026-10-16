// «MCP-сервер» block on the «Сеть» page: the opt-in switch (McpEnabled) and the ready config
// snippet for Claude Desktop / Cursor with a copy button. The server itself is `chawo-va mcp`
// (stdio, read-only), started by the assistant; the app never listens for it.

import { clipboard } from 'electron';
import * as AppPaths from './appPaths';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { configSnippet, launchFor } from '@chawo/engine/mcp/mcpServer';
import type { McpStateDto } from '@chawo/ipc/contract';
import { handle } from './ipc';


export function registerMcpIpc(settings: { get: () => SettingsData }): void {
  let copied = false;
  const snippet = () => {
    // Same data folders as this app instance (portable / test profiles set them).
    const l = launchFor(process.execPath, AppPaths.root(), {
      CHAWO_APPDATA: process.env.CHAWO_APPDATA,
      CHAWO_LOCALAPPDATA: process.env.CHAWO_LOCALAPPDATA,
      CHAWO_MEETINGS_DIR: process.env.CHAWO_MEETINGS_DIR,
    });
    return configSnippet(l.command, l.args, l.env);
  };
  const state = (): McpStateDto => ({ enabled: settings.get().McpEnabled, snippet: snippet(), copied });
  handle('mcp:state', () => state());
  handle('mcp:enable', (_e, on: unknown) => {
    if (typeof on === 'boolean') {
      const s = settings.get();
      s.McpEnabled = on;
      Settings.save(s);
    }
    copied = false;
    return state();
  });
  handle('mcp:copy', async () => {
    await clipboard.writeText(snippet());
    copied = true;
    return state();
  });
}
