// «MCP-сервер» on «Сеть»: opt-in switch + ready config for Claude Desktop / Cursor (read-only, stdio).
import { useEffect } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { applyMcp, mcpStore } from '../app/state';
import { useStore } from '../app/store';

export function McpBox() {
  const L = useL();
  const st = useStore(mcpStore);
  useEffect(() => {
    void invoke('mcp:state').then(applyMcp);
  }, []);
  if (!st) return null;
  return (
    <Fieldset className="mcp-box" legend={L('MCP-сервер для ассистентов', 'MCP server for assistants')}>
      <Check
        checked={st.enabled}
        onChange={(on) => void invoke('mcp:enable', on).then(applyMcp)}
        data-mcp="enabled"
        label={L(' Разрешить chawo-va mcp', ' Allow chawo-va mcp')}
      />
      <Hint>
        {L(
          'Claude Desktop, Cursor и другие MCP-клиенты смогут искать и читать ваши расшифровки (папка встреч и папки «Спросить историю» на «Истории»), фразы диктовки, «Кратко», чек-лист и статистику. Только чтение; порт не открывается — клиент сам запускает программу. Вставьте конфиг в claude_desktop_config.json или ~/.cursor/mcp.json.',
          'Claude Desktop, Cursor and other MCP clients can search and read your transcripts (the meetings folder and the «Ask history» folders on History), dictation phrases, briefs, checklist scores and stats. Read-only; no port is opened — the client starts the program itself. Paste the config into claude_desktop_config.json or ~/.cursor/mcp.json.',
        )}
      </Hint>
      {st.enabled && (
        <>
          <pre className="mcp-snippet" data-mcp="snippet">
            {st.snippet}
          </pre>
          <Row>
            <Button data-mcp="copy" onClick={() => void invoke('mcp:copy').then(applyMcp)}>
              {st.copied ? L('Скопировано', 'Copied') : L('Копировать конфиг', 'Copy config')}
            </Button>
          </Row>
        </>
      )}
    </Fieldset>
  );
}
