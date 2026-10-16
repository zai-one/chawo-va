// IPC for «В CRM». The renderer never gets a token back; it only sends new values to store.

import { BrowserWindow, app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { CRM_TARGETS, type CrmTarget } from '@chawo/core/crm';
import { CrmController } from '@chawo/engine/crm/crmPage';
import { nodeFetch } from '@chawo/engine/crm/crmFlow';
import { crmConfigPath, databasePath } from '@chawo/engine/paths';
import { emit, handle } from './ipc';

export function registerCrmIpc(getWindow: () => BrowserWindow | null): CrmController {
  const push = () => {
    const w = getWindow();
    emit(w, 'crm:state', ctl.state());
  };
  const ctl: CrmController = new CrmController({
    configPath: crmConfigPath,
    sentPath: databasePath,
    read: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      } catch {
        return null;
      }
    },
    fetch: nodeFetch,
    version: app.getVersion(),
    push,
  });
  const tgt = (v: unknown): CrmTarget => (CRM_TARGETS.includes(v as CrmTarget) ? (v as CrmTarget) : ('' as CrmTarget));
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  handle('crm:state', () => ctl.state());
  handle('crm:setConfig', (_e, target: unknown, fields: unknown) => ctl.setConfig(tgt(target), fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : {}));
  handle('crm:preview', (_e, path: unknown, target: unknown, id: unknown, score: unknown) => ctl.preview(str(path), tgt(target), str(id), score === true));
  handle('crm:clearPreview', () => ctl.clearPreview());
  handle('crm:send', (_e, force: unknown) => ctl.send(force === true));
  return ctl;
}
