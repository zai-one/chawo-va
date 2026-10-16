// «Кратко и задачи» — after a meeting/file transcript, via the Brain (local by default).
import { useRef, useState } from 'react';
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Card, Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyFile } from '../../app/state';
import { CrmOpenButton, CrmPanelHost, CrmSettings } from './CrmPanel';

export function BriefBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const br = s.brief;
  const instr = useRef<HTMLTextAreaElement>(null);
  const tplName = useRef<HTMLInputElement>(null);
  // The name field starts empty again after «Сохранить как шаблон» (the old page was rebuilt then).
  const [nameRound, setNameRound] = useState(0);
  // Template picker: built-ins, the user's own templates, then «Своя инструкция» (the free text).
  const templates = br.templates;
  const picked = templates.find((x) => x.id === br.template) ?? null;
  const options = [
    ...templates.map((x) => ({ value: x.id, label: x.builtin ? x.name : `${x.name} ${L('(свой)', '(custom)')}` })),
    { value: '', label: L('Своя инструкция', 'Own instruction') },
  ];
  // Built-ins stay editable: changing the text copies it into «Своя инструкция» and selects OWN.
  const commitInstruction = (text: string) => {
    if (picked && !picked.builtin) void invoke('file:saveBriefTemplate', picked.name, text).then(applyFile);
    else void invoke('file:briefInstruction', text).then(applyFile);
  };
  const saveTemplate = () =>
    void invoke('file:saveBriefTemplate', tplName.current?.value ?? '', instr.current?.value ?? '').then((st) => {
      setNameRound((n) => n + 1);
      applyFile(st);
    });
  return (
    <Fieldset className="meeting-brief" legend={L('Кратко и задачи', 'Brief and tasks')}>
      <Check
        labelClass=""
        checked={br.enabled || s.options.brief}
        disabled={!br.available && !br.enabled}
        onChange={(on) => void invoke('file:options', { brief: on }).then(applyFile)}
        label={L(' После расшифровки писать .brief.txt', ' After transcription also write .brief.txt')}
      />
      <Hint>
        {br.available
          ? L(`Мозг: ${br.where}. Выберите шаблон или впишите свою инструкцию — Мозг следует ей. В терминале: chawo-va brief --template …`, `Brain: ${br.where}. Pick a template or write your own instruction — the Brain follows it. In the terminal: chawo-va brief --template …`)
          : L('Нужен Мозг: скачайте локальную модель на «Мозге» или настройте свой сервер. Расшифровка без этого всё равно работает.', 'Needs the Brain: download a local model on Brain, or set up your own server. Transcription still works without it.')}
      </Hint>
      <Row>
        <label>{L('Шаблон ', 'Template ')}</label>
        <Select data-brief="template" aria-label={L('Шаблон', 'Template')} options={options} value={picked ? picked.id : ''} onChange={(v) => void invoke('file:briefTemplate', v).then(applyFile)} />
      </Row>
      <TextArea
        fieldRef={instr}
        data-brief="instruction"
        rows={4}
        spellCheck
        value={picked ? picked.instruction : br.instruction || br.defaultInstruction}
        placeholder={br.defaultInstruction}
        onCommit={commitInstruction}
      />
      <Row className="tpl-row">
        <TextField key={nameRound} fieldRef={tplName} data-brief="templateName" className="grow" value="" spellCheck={false} placeholder={L('название нового шаблона', 'new template name')} />
        <Button data-brief="saveTemplate" onClick={saveTemplate}>
          {L('Сохранить как шаблон', 'Save as template')}
        </Button>
        {picked && !picked.builtin && (
          <Button variant="link" data-brief="deleteTemplate" onClick={() => void invoke('file:deleteBriefTemplate', picked.name).then(applyFile)}>
            {L('Удалить шаблон', 'Delete template')}
          </Button>
        )}
      </Row>
      {br.templateNote && <Hint warn>{br.templateNote}</Hint>}
      <Row>
        <Button variant="primary" disabled={s.busy || br.busy || !br.available || !s.lastOutput} onClick={() => void invoke('file:runBrief').then(applyFile)}>
          {L('Составить по последней расшифровке', 'Build from the last transcript')}
        </Button>
      </Row>
      {br.text && (
        <Card className="result brief-card">
          <div className="card-head">
            <strong>{L('Карточка', 'Card')}</strong>
            <span className="row inline">
              {br.path ? <CrmOpenButton /> : <span />}
              {br.path ? (
                <Button variant="link" onClick={() => void invoke('file:reveal', br.path!)}>
                  {L('Показать файл', 'Show file')}
                </Button>
              ) : (
                <span />
              )}
            </span>
          </div>
          <pre className="last-text">{br.text}</pre>
          <CrmPanelHost briefPath={br.path} />
        </Card>
      )}
      <CrmSettings />
    </Fieldset>
  );
}
