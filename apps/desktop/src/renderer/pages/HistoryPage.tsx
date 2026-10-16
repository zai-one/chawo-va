// «История»: the last dictation takes — search, copy, rerun through the Brain, fix in place; «Спросить» on top.
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@chawo/ui/Button';
import { Select } from '@chawo/ui/Choice';
import { Hint, Row, Status } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import type { HistoryStateDto } from '@chawo/ipc/contract';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applyAsk, applyHistory, historyStore } from '../app/state';
import { useStore } from '../app/store';
import { AskBox } from './AskBox';

export function HistoryPage() {
  const L = useL();
  const s = useStore(historyStore);
  // The row whose text is open in the «Исправить» editor.
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    void invoke('history:state').then(applyHistory);
    void invoke('ask:state').then(applyAsk);
  }, []);
  return (
    <>
      <h1>{L(...TITLES.history)}</h1>
      {s && (
        <>
          <AskBox />
          <p className="muted">{s.intro}</p>
          <Row>
            <TextField
              value={s.query}
              placeholder={s.searchPlaceholder}
              spellCheck={false}
              data-history="search"
              className="hist-search"
              onInput={(v) => void invoke('history:query', v).then(applyHistory)}
            />
            <label>
              {s.keepLabel + ' '}
              <Select options={s.keepChoices} value={s.keep} aria-label={s.keepLabel} onChange={(v) => void invoke('history:keep', v).then(applyHistory)} />
            </label>
            <Button variant="link" disabled={s.rows.length === 0 && !s.query} onClick={() => void invoke('history:clear').then(applyHistory)}>
              {s.labels.clearAll}
            </Button>
          </Row>
          <Hint>{s.keepHint}</Hint>
          <Status data-history="status">{s.status}</Status>
          <div className="hist" data-history="list">
            {s.rows.length === 0 ? (
              <div className="empty muted">{s.empty}</div>
            ) : (
              s.rows.map((r) => <HistoryItem key={r.id} s={s} r={r} editing={editing === r.id} setEditing={setEditing} />)
            )}
          </div>
          <Hint data-history="count">{s.countLine}</Hint>
        </>
      )}
    </>
  );
}

function HistoryItem({ s, r, editing, setEditing }: { s: HistoryStateDto; r: HistoryStateDto['rows'][number]; editing: boolean; setEditing: (id: string | null) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const copy = (which: 'final' | 'raw') => void invoke('history:copy', r.id, which).then(applyHistory);
  // Saving redraws the list without the editor, like the legacy full redraw after main's answer.
  const save = () =>
    void invoke('history:edit', r.id, area.current?.value ?? r.final).then((st) => {
      setEditing(null);
      applyHistory(st);
    });
  return (
    <div className="hist-item">
      <div className="hist-head muted">
        <span>{`${r.when} · ${r.seconds}`}</span>
        {r.command && <span className="hist-cmd">{`«${r.command}»`}</span>}
        {r.tag && <span className={`hist-tag${r.failed ? ' failed' : ''}`}>{r.tag}</span>}
      </div>
      {editing ? (
        <TextArea
          fieldRef={area}
          value={r.final}
          spellCheck
          rows={Math.min(8, Math.max(2, Math.ceil(r.final.length / 90)))}
          className="hist-edit"
          data-history="edit"
        />
      ) : (
        <div className="hist-text">{r.final}</div>
      )}
      {r.raw && (
        <div className="hist-raw muted">
          <span>{s.labels.rawHeader + ' '}</span>
          {r.raw}
        </div>
      )}
      {editing ? (
        <Row className="hist-acts">
          <Button data-history="save" onClick={save}>
            {s.labels.save}
          </Button>
          <Button variant="link" onClick={() => setEditing(null)}>
            {s.labels.cancel}
          </Button>
        </Row>
      ) : (
        <Row className="hist-acts">
          <Button onClick={() => copy('final')}>{s.labels.copy}</Button>
          {r.raw && (
            <Button variant="link" onClick={() => copy('raw')}>
              {s.labels.copyRaw}
            </Button>
          )}
          {/* «Исправить»: the text becomes an editor in place; saving teaches «Словарь из исправлений».
              Rendered synchronously: a script clicks it and fills the editor in the same task. */}
          <Button variant="link" data-history="fix" onClick={() => flushSync(() => setEditing(r.id))}>
            {s.labels.edit}
          </Button>
          <Button variant="link" disabled={!s.canRerun} title={s.rerunTip || undefined} onClick={() => void invoke('history:rerun', r.id).then(applyHistory)}>
            {s.rerunningId === r.id ? '…' : s.labels.rerun}
          </Button>
          <Button variant="link" onClick={() => void invoke('history:remove', r.id).then(applyHistory)}>
            {s.labels.remove}
          </Button>
        </Row>
      )}
    </div>
  );
}
