// «В CRM» (brief card button + panel) and «Настройки CRM» on the File page.
import { createRef, Fragment, useEffect, useState, type RefObject } from 'react';
import type { CrmStateDto, CrmTarget } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Hint, Row, Status } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL, type Tr } from '../../app/i18n';
import { applyCrm, crmStore } from '../../app/state';
import { createStore, useStore } from '../../app/store';

// Outlive page redraws and page switches, like the module variables of the old window.
interface CrmUi {
  open: boolean;
  target: CrmTarget | '';
  id: string;
  score: boolean;
}
const crmUi = createStore<CrmUi>({ open: false, target: '', id: '', score: false });
const settingsOpen = createStore(false);

const setUi = (patch: Partial<CrmUi>) => crmUi.update((u) => ({ ...u, ...patch }));
const clearPreview = () => void invoke('crm:clearPreview').then(applyCrm);

/** Loads the CRM state once when a block needs it and it is not there yet. */
function useCrmState(): CrmStateDto | null {
  const s = useStore(crmStore);
  useEffect(() => {
    if (!crmStore.get()) void invoke('crm:state').then(applyCrm);
  }, []);
  return s;
}

/** «В CRM» in the brief card head: opens / closes the panel, dropping any old preview. */
export function CrmOpenButton() {
  const L = useL();
  return (
    <Button
      variant="link"
      data-crm="open"
      onClick={() => {
        setUi({ open: !crmUi.get().open });
        clearPreview();
      }}
    >
      {L('В CRM', 'To CRM')}
    </Button>
  );
}

/** The panel host under the brief card; empty (hidden by CSS) while closed. */
export function CrmPanelHost({ briefPath }: { briefPath: string | null }) {
  const open = useStore(crmUi).open;
  return (
    <div className="crm-panel" data-crm="panel">
      {open && briefPath && <CrmPanel briefPath={briefPath} />}
    </div>
  );
}

/** The «В CRM» panel: target, record id, score, «Показать», then «Отправить». */
function CrmPanel({ briefPath }: { briefPath: string }) {
  const L = useL();
  const s = useCrmState();
  const ui = useStore(crmUi);
  const ready = s ? s.targets.filter((x) => x.ready) : [];
  const target: CrmTarget | '' = ready.length === 0 ? ui.target : ready.some((x) => x.id === ui.target) ? ui.target : ready[0].id;
  // The remembered target is gone (settings cleared): fall back to the first ready one.
  useEffect(() => {
    if (target !== crmUi.get().target) setUi({ target });
  }, [target]);
  if (!s) return null;
  if (ready.length === 0) {
    return <Hint>{L('CRM не настроена — заполните «Настройки CRM» ниже.', 'No CRM set up — fill in «CRM settings» below.')}</Hint>;
  }
  const fresh = s.previewFor && s.previewFor.path === briefPath && s.previewFor.target === target && s.previewFor.id === ui.id.trim() && s.previewFor.score === ui.score;
  return (
    <>
      <div className="row inline crm-row">
        <Select
          data-crm="target"
          aria-label={L('Куда', 'Where')}
          options={ready.map((x) => ({ value: x.id, label: x.name }))}
          value={target}
          onChange={(v) => {
            setUi({ target: v as CrmTarget });
            clearPreview();
          }}
        />
        <TextField
          data-crm="id"
          className="crm-id"
          value={ui.id}
          spellCheck={false}
          placeholder={target === 'webhook' ? L('id (необязательно)', 'id (optional)') : L('id сделки / контакта', 'deal / contact id')}
          onInput={(v) => {
            setUi({ id: v });
            if (s.preview) clearPreview();
          }}
        />
        <Check
          data-crm="score"
          labelClass=""
          checked={ui.score}
          onChange={(on) => {
            setUi({ score: on });
            clearPreview();
          }}
          label={L(' + оценка', ' + score')}
        />
        <Button data-crm="preview" onClick={() => void invoke('crm:preview', briefPath, target as CrmTarget, ui.id, ui.score).then(applyCrm)}>
          {L('Показать, что уйдёт', 'Show what goes out')}
        </Button>
      </div>
      {s.preview && fresh && (
        <>
          <pre className="crm-preview" data-crm="previewText">
            {s.preview}
          </pre>
          {s.duplicate && <Hint warn>{s.duplicate}</Hint>}
          <Row>
            <Button variant="primary" data-crm="send" disabled={s.busy} onClick={() => void invoke('crm:send', Boolean(s.duplicate)).then(applyCrm)}>
              {s.busy ? L('Отправляю…', 'Sending…') : s.duplicate ? L('Отправить ещё раз', 'Send again') : L('Отправить', 'Send')}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setUi({ open: false });
                clearPreview();
              }}
            >
              {L('Отмена', 'Cancel')}
            </Button>
          </Row>
        </>
      )}
      {s.status && (
        <Status warn={s.ok === false} data-crm="status">
          {s.status}
        </Status>
      )}
    </>
  );
}

interface FieldSpec {
  key: string;
  /** Placeholder; a select has its options instead. */
  ph?: string;
  secret?: boolean;
  opts?: string[];
}

const targetRows = (L: Tr): [CrmTarget, string, FieldSpec[]][] => [
  ['amocrm', 'amoCRM', [{ key: 'base', ph: 'https://company.amocrm.ru' }, { key: 'entity', opts: ['leads', 'contacts', 'companies'] }, { key: 'token', ph: L('долгосрочный токен', 'long-lived token'), secret: true }]],
  ['bitrix', 'Bitrix24', [{ key: 'webhook', ph: 'https://portal.bitrix24.ru/rest/1/…/', secret: true }, { key: 'entity', opts: ['deal', 'lead', 'contact', 'company'] }, { key: 'mode', opts: ['comment', 'task'] }, { key: 'responsibleId', ph: L('id ответственного (для задачи)', 'responsible id (task)') }]],
  ['hubspot', 'HubSpot', [{ key: 'token', ph: L('токен private app', 'private app token'), secret: true }, { key: 'object', opts: ['contacts', 'deals', 'companies'] }]],
  ['webhook', 'Webhook', [{ key: 'url', ph: 'https://example.com/hook' }, { key: 'secret', ph: L('секрет подписи (необязательно)', 'signing secret (optional)'), secret: true }]],
];

/** One target: its fields, «Сохранить» (sends what the fields hold now) and «Очистить». */
function TargetRow({ s, target, name, specs, onSaved }: { s: CrmStateDto; target: CrmTarget; name: string; specs: FieldSpec[]; onSaved: (st: CrmStateDto) => void }) {
  const L = useL();
  const cfg = s.config[target];
  const [refs] = useState(() => new Map<string, RefObject<HTMLInputElement | null>>(specs.filter((f) => !f.opts).map((f) => [f.key, createRef<HTMLInputElement>()])));
  // Selects keep the user's pick until «Сохранить» (the field re-shows its value on every render).
  const [picked, setPicked] = useState<Record<string, string>>({});
  const choiceOf = (f: FieldSpec) => picked[f.key] ?? String(cfg[f.key] ?? f.opts![0]);
  const save = () => {
    const fields: Record<string, unknown> = {};
    for (const f of specs) fields[f.key] = f.opts ? choiceOf(f) : (refs.get(f.key)?.current?.value ?? '');
    void invoke('crm:setConfig', target, fields).then(onSaved);
  };
  const ready = s.targets.find((x) => x.id === target)?.ready;
  return (
    <div className="crm-target">
      <strong>{name + (ready ? ' ✓' : '')}</strong>
      {specs.map((f) => {
        const dataCrm = `${target}.${f.key}`;
        if (f.opts) {
          return <Select key={f.key} data-crm={dataCrm} options={f.opts.map((v) => ({ value: v, label: v }))} value={choiceOf(f)} onChange={(v) => setPicked((p) => ({ ...p, [f.key]: v }))} />;
        }
        const cur = cfg[f.key];
        return (
          <TextField
            key={f.key}
            fieldRef={refs.get(f.key)}
            data-crm={dataCrm}
            type={f.secret ? 'password' : 'text'}
            value={f.secret ? '' : String(cur ?? '')}
            placeholder={f.secret ? (cur ? L('задан — введите новый, чтобы заменить', 'set — type a new one to replace') : f.ph) : f.ph}
            spellCheck={false}
            autoComplete="off"
          />
        );
      })}
      <Button data-crm={`${target}.save`} onClick={save}>
        {L('Сохранить', 'Save')}
      </Button>
      <Button variant="link" onClick={() => void invoke('crm:setConfig', target, { clear: true }).then(onSaved)}>
        {L('Очистить', 'Clear')}
      </Button>
    </div>
  );
}

/** «Настройки CRM»: one compact row set per target; tokens are write-only («задан» when stored). */
export function CrmSettings() {
  const L = useL();
  const s = useCrmState();
  const open = useStore(settingsOpen);
  // After a save / clear the rows are built anew from the new state (secret fields empty again).
  const [round, setRound] = useState(0);
  const onSaved = (st: CrmStateDto) => {
    applyCrm(st);
    setRound((n) => n + 1);
  };
  return (
    <details className="crm-settings" data-crm="settings" open={s ? open : undefined} onToggle={s ? (e) => settingsOpen.set(e.currentTarget.open) : undefined}>
      <summary>{L('Настройки CRM', 'CRM settings')}</summary>
      {s && (
        <Fragment key={round}>
          <Hint>
            {L(
              'Уходит только карточка «Кратко и задачи» (и оценка, если отметить) и только по кнопке «Отправить» после просмотра. Токены хранятся только на этом компьютере (crm.json) и сюда не возвращаются.',
              'Only the brief (and the score if ticked) goes out, and only by «Send» after the preview. Tokens stay on this computer (crm.json) and are never shown again.',
            )}
          </Hint>
          {targetRows(L).map(([target, name, specs]) => (
            <TargetRow key={target} s={s} target={target} name={name} specs={specs} onSaved={onSaved} />
          ))}
          {s.status && !s.previewFor && <Status warn={s.ok === false}>{s.status}</Status>}
        </Fragment>
      )}
    </details>
  );
}
