// «Мозг»: where the Brain runs (service with a key, or a local .gguf model) and how it rewrites dictation.
import { useEffect, useRef } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check, Radio, Select } from '@chawo/ui/Choice';
import { Card, Hint, Progress, Row } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import type { BrainStateDto } from '@chawo/ipc/contract';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applyBrain, brainStore } from '../app/state';
import { useStore } from '../app/store';
import { AppRules } from './AppRules';

/** Service, key, address and model. Keyed by provider, so a switch shows that provider's url / model. */
function ServerBlock({ v }: { v: BrainStateDto['server'] }) {
  const L = useL();
  const key = useRef<HTMLInputElement>(null);
  const onKey = (text: string) =>
    void invoke('brain:key', text).then((st) => {
      // A pasted key may switch the service; the field leaves focus only then, so the caret stays put.
      const prev = brainStore.get();
      if (prev && st.server.providerId !== prev.server.providerId) key.current?.blur();
      applyBrain(st);
    });
  return (
    <>
      <div className="form">
        <span>{L('Сервис', 'Service')}</span>
        <Select options={v.providers.map((p) => ({ value: p.id, label: p.label }))} value={v.providerId} onChange={(id) => void invoke('brain:provider', id).then(applyBrain)} />
        <span>{L('Ключ API', 'API key')}</span>
        <div>
          {/* A stored key is never shown. */}
          <TextField fieldRef={key} type="password" value="" placeholder={v.keyPlaceholder} spellCheck={false} autoComplete="off" onInput={onKey} />
          <Button variant="link" disabled={!v.keysLinkEnabled} onClick={() => void invoke('brain:keysLink')}>
            {v.keysLink}
          </Button>
        </div>
        {v.custom && (
          <>
            <span>{L('Адрес', 'Address')}</span>
            <TextField
              value={v.url}
              spellCheck={false}
              placeholder="http://localhost:11434/v1"
              title={L(
                'OpenAI-совместимый API, например http://localhost:1234/v1 (LM Studio) или http://localhost:11434/v1 (Ollama)',
                'An OpenAI-compatible API, e.g. http://localhost:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama)',
              )}
              onCommit={(url) => void invoke('brain:url', url).then(applyBrain)}
            />
          </>
        )}
        <span>{L('Модель', 'Model')}</span>
        <div className="inline">
          <TextField value={v.model} spellCheck={false} list="brain-models" data-brain="model" onCommit={(model) => void invoke('brain:model', model).then(applyBrain)} />
          <datalist id="brain-models">
            {v.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button data-brain="reload" disabled={v.loading} onClick={() => void invoke('brain:refresh').then(applyBrain)}>
            {L('Обновить', 'Reload')}
          </Button>
        </div>
      </div>
      <Hint line data-brain="server-status">
        {v.status}
      </Hint>
    </>
  );
}

function LocalBlock({ s }: { s: BrainStateDto }) {
  const L = useL();
  const v = s.local;
  const busy = s.download?.running === true;
  const d = s.download;
  return (
    <>
      <label className="block">{L('Модель на компьютере', 'Model on this computer')}</label>
      <div className="models">
        {v.rows.map((r) => {
          const kind = r.kind;
          const path = r.path;
          const select = () =>
            void (kind === 'File' && path ? invoke('brain:localFile', path) : invoke('brain:localModel', kind)).then(applyBrain);
          return (
            <div key={kind === 'File' ? `file:${path ?? ''}` : kind} className="model" data-brain-row={kind}>
              <label>
                <Radio name="brain-model" checked={r.selected} disabled={busy} onSelect={select} /> {r.label}
              </label>
              {r.onDisk && <span className="disk">{L('на диске', 'on disk')}</span>}
              {r.canDownload && (
                <Button disabled={busy} onClick={() => void invoke('brain:download', kind).then(applyBrain)}>
                  {r.downloadLabel}
                </Button>
              )}
              {path && r.deletable && (
                <Button disabled={busy && r.selected} onClick={() => void invoke('brain:deleteGguf', path).then(applyBrain)}>
                  {L('Удалить', 'Delete')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <Row>
        <Button data-brain="pickFile" disabled={busy} onClick={() => void invoke('brain:pickFile').then(applyBrain)}>
          {L('Выбрать файл .gguf…', 'Choose a .gguf file…')}
        </Button>
      </Row>
      <label className="block">{L('Папка моделей', 'Models folder')}</label>
      <Row>
        <span className="line" data-brain="modelsDir">
          {v.modelsDir}
        </span>
        <Button disabled={busy} onClick={() => void invoke('brain:pickFolder').then(applyBrain)}>
          {L('Изменить…', 'Change…')}
        </Button>
        <Button variant="link" onClick={() => void invoke('brain:openFolder')}>
          {L('Открыть', 'Open')}
        </Button>
        {v.modelsDirCustom && (
          <Button variant="link" disabled={busy} onClick={() => void invoke('brain:resetFolder').then(applyBrain)}>
            {L('Обычная папка', 'Usual folder')}
          </Button>
        )}
      </Row>
      <Hint>
        {L(
          'Сюда скачиваются модели; любой файл .gguf из этой папки появляется в списке выше. Модель из другого места — «Выбрать файл»: она используется там, где лежит.',
          'Models are downloaded here; any .gguf file in this folder shows in the list above. A model elsewhere: «Choose a file», it is used where it is.',
        )}
      </Hint>
      {v.customUrlVisible && (
        <>
          <label className="block">{L('Ссылка Hugging Face', 'Hugging Face link')}</label>
          <TextField
            value={v.customUrl}
            spellCheck={false}
            title={L('Страница файла .gguf или прямая ссылка resolve. Скачивается только по кнопке ниже.', 'A .gguf file page or a resolve link. Downloaded only by the button below.')}
            onCommit={(url) => void invoke('brain:customUrl', url).then(applyBrain)}
          />
        </>
      )}
      {v.fileStatus && <Hint line>{v.fileStatus}</Hint>}
      {d ? (
        <Card failed={d.failed}>
          <div>{d.title}</div>
          <Hint>{d.intro}</Hint>
          {d.running && <Progress percent={d.percent} />}
          <p className="status muted">{d.text}</p>
          <Row>
            {d.running ? (
              <Button onClick={() => void invoke('brain:cancelDownload').then(applyBrain)}>{L('Отмена', 'Cancel')}</Button>
            ) : (
              <>
                {d.failed && (
                  <Button variant="primary" onClick={() => void invoke('brain:download', d.kind).then(applyBrain)}>
                    {L('Повторить', 'Retry')}
                  </Button>
                )}
                <Button variant="link" onClick={() => void invoke('brain:dismissDownload').then(applyBrain)}>
                  {L('Скрыть', 'Hide')}
                </Button>
              </>
            )}
          </Row>
        </Card>
      ) : (
        v.rows.some((r) => r.canDownload) && <Hint>{L('Пока кнопка «Скачать» не нажата, в сеть ничего не уходит.', 'Nothing goes out on the network until you press Download.')}</Hint>
      )}
      <label className="block">{L('Где считает', 'Where it runs')}</label>
      <Select options={v.deviceChoices} value={v.device} onChange={(dev) => void invoke('brain:device', dev).then(applyBrain)} />
      <Hint>{v.deviceHint}</Hint>
    </>
  );
}

export function BrainPage() {
  const L = useL();
  const s = useStore(brainStore);
  useEffect(() => {
    void invoke('brain:state', true).then(applyBrain);
  }, []);
  if (!s) return <h1>{L(...TITLES.brain)}</h1>;
  return (
    <>
      <h1>{L(...TITLES.brain)}</h1>
      <p className="muted">{s.hint}</p>
      <Row>
        <span>{L('Где думает', 'Runs on')}</span>
        <Select options={s.sourceChoices} value={s.source} onChange={(v) => void invoke('brain:source', v).then(applyBrain)} />
      </Row>
      {s.status && <Hint>{s.status}</Hint>}

      {s.server.visible && <ServerBlock key={s.server.providerId} v={s.server} />}
      {s.local.visible && <LocalBlock s={s} />}

      {s.everyTake.visible && (
        <>
          <label className="block">{L('Переписывать фразу', 'Rewrite the phrase')}</label>
          <Select
            options={[
              { value: 'off', label: L('Выключено', 'Off') },
              { value: 'on', label: L('Переписывать каждую фразу', 'Rewrite each phrase') },
            ]}
            value={s.everyTake.on ? 'on' : 'off'}
            onChange={(v) => void invoke('brain:everyTake', v === 'on').then(applyBrain)}
          />
          <Hint>{s.everyTake.hint}</Hint>
        </>
      )}
      {s.style.visible && (
        <>
          <label className="block">{L('Как править', 'How to edit')}</label>
          <Select options={s.style.choices} value={s.style.value} onChange={(v) => void invoke('brain:style', v).then(applyBrain)} />
          <Hint>{s.style.hint}</Hint>
        </>
      )}
      {s.instruction.visible && (
        <>
          <label className="block">{L('Своя инструкция', 'Own instruction')}</label>
          <TextArea value={s.instruction.text} spellCheck={false} rows={4} onCommit={(text) => void invoke('brain:instruction', text).then(applyBrain)} />
          <Hint>{s.instruction.hint}</Hint>
        </>
      )}
      {s.selection.visible && (
        <>
          <Check checked={s.selection.on} onChange={(on) => void invoke('brain:selection', on).then(applyBrain)} label={' ' + L('Править выделенный текст голосом', 'Edit selected text by voice')} />
          <Hint indent>{s.selection.hint}</Hint>
        </>
      )}
      {s.context.visible && (
        <>
          <label className="block">{L('Контекст для Мозга (по желанию)', 'Context for the Brain (opt-in)')}</label>
          <Check
            id="brain-context-clipboard"
            checked={s.context.clipboard}
            onChange={(clipboard) => void invoke('brain:context', { clipboard }).then(applyBrain)}
            label={' ' + L('Текст из буфера обмена', 'Clipboard text')}
          />
          <Check id="brain-context-app" checked={s.context.app} onChange={(app) => void invoke('brain:context', { app }).then(applyBrain)} label={' ' + L('Программа и заголовок окна', 'Program and window title')} />
          <Hint indent>{s.context.hint}</Hint>
          {s.context.warning && (
            <Hint warn indent>
              {s.context.warning}
            </Hint>
          )}
        </>
      )}
      <AppRules v={s.appRules} />
    </>
  );
}
