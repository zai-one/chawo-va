// «Проверка по чек-листу» — the Brain marks each item yes / partial / no with a quote (.score.json / .score.txt).
import { useRef, useState } from 'react';
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Card, Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyFile } from '../../app/state';

const MARK = { yes: '✓', partial: '½', no: '✗' } as const;

export function ScoreBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const sc = s.score;
  const cur = sc.checklists.find((x) => x.id === sc.checklist) ?? sc.checklists[0] ?? null;
  const items = useRef<HTMLTextAreaElement>(null);
  const name = useRef<HTMLInputElement>(null);
  // The editor fields keep what is typed across pushes; picking another checklist, deleting, or a save
  // without a note drops that draft: the fields are built anew and show the stored checklist.
  const [round, setRound] = useState(0);
  const dropDraft = () => setRound((n) => n + 1);
  const draftKey = `${cur?.id ?? ''}#${round}`;
  const r = sc.result;
  return (
    <Fieldset className="meeting-brief call-score" legend={L('Проверка по чек-листу', 'Checklist score')}>
      <Check
        labelClass=""
        data-score="enabled"
        checked={sc.enabled}
        disabled={!sc.available && !sc.enabled}
        onChange={(on) => void invoke('file:options', { score: on }).then(applyFile)}
        label={L(' После расшифровки писать .score.json и .score.txt', ' After transcription also write .score.json and .score.txt')}
      />
      <Hint>
        {sc.available
          ? L(`Мозг: ${sc.where}. Каждый пункт: да / частично / нет и цитата из звонка. Встроенный чек-лист можно взять за основу — сохраните под своим названием.`,
            `Brain: ${sc.where}. Each item: yes / partial / no with a quote from the call. Start from the built-in checklist and save it under your own name.`)
          : L('Нужен Мозг: скачайте локальную модель на «Мозге» или настройте свой сервер.', 'Needs the Brain: download a local model on Brain, or set up your own server.')}
      </Hint>
      <div className="row inline">
        <label>{L('Чек-лист ', 'Checklist ')}</label>
        <Select
          data-score="checklist"
          aria-label={L('Чек-лист', 'Checklist')}
          options={sc.checklists.map((x) => ({ value: x.id, label: x.builtin ? x.name : `${x.name} ${L('(свой)', '(custom)')}` }))}
          value={cur?.id ?? ''}
          onChange={(v) => {
            dropDraft();
            void invoke('file:scoreChecklist', v).then(applyFile);
          }}
        />
      </div>
      <TextArea
        key={draftKey}
        fieldRef={items}
        data-score="items"
        rows={Math.min(8, Math.max(3, cur?.items.length ?? 3))}
        spellCheck
        value={(cur?.items ?? []).join('\n')}
        placeholder={L('Один пункт на строку', 'One item per line')}
      />
      <Row className="tpl-row">
        <TextField
          key={draftKey}
          fieldRef={name}
          data-score="name"
          className="grow"
          spellCheck={false}
          value={cur && !cur.builtin ? cur.name : ''}
          placeholder={L('название своего чек-листа', 'your checklist name')}
        />
        <Button
          data-score="save"
          onClick={() =>
            void invoke('file:saveChecklist', name.current?.value ?? '', items.current?.value ?? '').then((st) => {
              if (!st.score.note) dropDraft();
              applyFile(st);
            })
          }
        >
          {L('Сохранить чек-лист', 'Save checklist')}
        </Button>
        {cur && !cur.builtin && (
          <Button
            variant="link"
            data-score="delete"
            onClick={() => {
              dropDraft();
              void invoke('file:deleteChecklist', cur.name).then(applyFile);
            }}
          >
            {L('Удалить', 'Delete')}
          </Button>
        )}
      </Row>
      {sc.note && <Hint warn>{sc.note}</Hint>}
      <Row>
        <Button variant="primary" data-score="run" disabled={s.busy || sc.busy || !sc.available || !s.lastOutput} onClick={() => void invoke('file:runScore').then(applyFile)}>
          {L('Проверить последнюю расшифровку', 'Score the last transcript')}
        </Button>
      </Row>
      {r && (
        <Card className="result score-card">
          <div className="card-head">
            <strong>{L(`${r.checklist.name}: ${String(r.score).replace('.', ',')} из ${r.max} (${r.percent}%)`, `${r.checklist.name}: ${r.score} of ${r.max} (${r.percent}%)`)}</strong>
            {sc.path ? (
              <Button variant="link" onClick={() => void invoke('file:reveal', sc.path!)}>
                {L('Показать файл', 'Show file')}
              </Button>
            ) : (
              <span />
            )}
          </div>
          <ul className="score-items">
            {r.items.map((x, i) => (
              <li key={i} className={`v-${x.verdict}`}>
                <span className="mark">{MARK[x.verdict]}</span>
                <span>{x.item}</span>
                {x.quote && <q>{x.quote}</q>}
                {x.note && <small className="muted">{x.note}</small>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Fieldset>
  );
}
