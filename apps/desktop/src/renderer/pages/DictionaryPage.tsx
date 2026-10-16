// «Словарь»: replacements, voice punctuation/numbers, suggestions, learned fixes, snippets, own script.
import { useEffect, useRef, useState } from 'react';
import type { DictionaryStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row, Status } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applyDict, dictStore } from '../app/state';
import { useStore } from '../app/store';

type DictRow = DictionaryStateDto['rows'][number];
type SnippetRow = DictionaryStateDto['snippets']['rows'][number];

/** Saved on every keystroke, the state is only stored: the fields keep their text and the caret. */
const keep = (st: DictionaryStateDto) => dictStore.set(st);

const snippetLines = (text: string) => Math.min(6, Math.max(1, text.split('\n').length));

function ReplacementRow({ r, s, focus }: { r: DictRow; s: DictionaryStateDto; focus: boolean }) {
  const heard = useRef<HTMLInputElement>(null);
  const written = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) heard.current?.focus();
  }, [focus]);
  // Saved on every edit like WPF; the other field of the row is read as it is now.
  const send = () => void invoke('dict:setRow', r.id, heard.current?.value ?? '', written.current?.value ?? '').then(keep);
  return (
    <div className="dict-row">
      <TextField fieldRef={heard} value={r.from} spellCheck={false} aria-label={s.heardHeader} onInput={send} />
      <TextField fieldRef={written} value={r.to} spellCheck={false} aria-label={s.writtenHeader} onInput={send} />
      <Button onClick={() => void invoke('dict:remove', r.id).then(applyDict)}>{s.deleteLabel}</Button>
    </div>
  );
}

function SnippetLine({ r, s, focus }: { r: SnippetRow; s: DictionaryStateDto; focus: boolean }) {
  const sn = s.snippets;
  const trig = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  // The text box grows with its lines as you type (up to 6).
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => {
    if (focus) trig.current?.focus();
  }, [focus]);
  const send = () => void invoke('dict:setSnippet', r.id, trig.current?.value ?? '', body.current?.value ?? '').then(keep);
  return (
    <div className="snippet-row">
      <TextField
        fieldRef={trig}
        value={r.trigger}
        placeholder={sn.triggerPlaceholder}
        spellCheck={false}
        aria-label={sn.triggerHeader}
        data-dict="snippetTrigger"
        onInput={send}
      />
      <TextArea
        fieldRef={body}
        value={r.text}
        placeholder={sn.textPlaceholder}
        spellCheck={false}
        rows={snippetLines(typed ?? r.text)}
        aria-label={sn.textHeader}
        data-dict="snippetText"
        onInput={(v) => {
          setTyped(v);
          send();
        }}
      />
      <Button onClick={() => void invoke('dict:removeSnippet', r.id).then(applyDict)}>{s.deleteLabel}</Button>
    </div>
  );
}

export function DictionaryPage() {
  const L = useL();
  const s = useStore(dictStore);
  // The row just added («Добавить») gets the caret in its first field.
  const [focusId, setFocusId] = useState<number | null>(null);
  const cmd = useRef<HTMLInputElement>(null);
  // «Проверить» stays disabled from the click until main answers.
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    void invoke('dict:state').then(applyDict);
  }, []);
  const added = (res: { id: number; state: DictionaryStateDto }) => {
    applyDict(res.state);
    setFocusId(res.id);
  };
  if (!s) return <h1>{L(...TITLES.dictionary)}</h1>;
  const sp = s.spoken;
  const lr = s.learned;
  const sn = s.snippets;
  const sc = s.script;
  const test = () => {
    setTesting(true);
    void invoke('dict:setScript', cmd.current?.value ?? '')
      .then(() => invoke('dict:testScript'))
      .then(applyDict)
      .finally(() => setTesting(false));
  };
  return (
    <>
      <h1>{L(...TITLES.dictionary)}</h1>
      <p className="muted">{s.intro}</p>

      <div className="dict">
        <div className="dict-row head muted">
          <span>{s.heardHeader}</span>
          <span>{s.writtenHeader}</span>
          <span />
        </div>
        {s.rows.map((r) => (
          <ReplacementRow key={r.id} r={r} s={s} focus={r.id === focusId} />
        ))}
      </div>
      <Row>
        <Button onClick={() => void invoke('dict:add').then(added)}>{s.addLabel}</Button>
      </Row>

      {/* Voice punctuation and numbers: two switches, each with one hint line. */}
      <Check
        checked={sp.punctuation}
        data-dict="punctuation"
        onChange={(on) => void invoke('dict:setSpoken', 'punctuation', on).then(applyDict)}
        label={' ' + sp.punctuationLabel}
      />
      <Hint indent>{sp.punctuationHint}</Hint>
      <Check
        checked={sp.numbers}
        data-dict="numbers"
        onChange={(on) => void invoke('dict:setSpoken', 'numbers', on).then(applyDict)}
        label={' ' + sp.numbersLabel}
      />
      <Hint indent>{sp.numbersHint}</Hint>

      <Row>
        <Button onClick={() => void invoke('dict:suggest').then(applyDict)}>{s.suggestLabel}</Button>
      </Row>
      <Hint>{s.suggestHint}</Hint>
      {s.suggestions.length > 0 && (
        <div className="dict suggest">
          {s.suggestions.map((g) => (
            <div key={g.id} className="dict-row">
              <span className="cell">{g.heard}</span>
              <span className="cell muted">{g.written + (g.source ? `  (${g.source})` : '')}</span>
              <Button onClick={() => void invoke('dict:addSuggestion', g.heard, g.written).then(applyDict)}>{s.addSuggestionLabel}</Button>
            </div>
          ))}
        </div>
      )}

      {/* «Из исправлений»: fixes seen twice from «История» → «Исправить»; one switch, rows with two buttons. */}
      <Fieldset className="learned" data-dict="learned" legend={lr.heading}>
        <Hint>{lr.hint}</Hint>
        <Check checked={lr.autoAdd} data-dict="learnAuto" onChange={(on) => void invoke('dict:setLearnAuto', on).then(applyDict)} label={' ' + lr.autoLabel} />
        {lr.rows.length === 0 && <Hint>{lr.empty}</Hint>}
        {lr.rows.map((r) => (
          <div key={`${r.from}\u0000${r.to}`} className="learned-row">
            <span className="cell">{r.from}</span>
            <span className="cell">{'→ ' + r.to}</span>
            <span className="muted">{r.times}</span>
            <Button data-dict="learnAccept" onClick={() => void invoke('dict:acceptLearned', r.from, r.to).then(applyDict)}>
              {lr.acceptLabel}
            </Button>
            <Button variant="link" onClick={() => void invoke('dict:dismissLearned', r.from, r.to).then(applyDict)}>
              {lr.dismissLabel}
            </Button>
          </div>
        ))}
      </Fieldset>

      {/* «Сниппеты»: compact block — trigger, text (grows with lines), delete. */}
      <Fieldset className="snippets" data-dict="snippets" legend={sn.heading}>
        <Hint>{sn.hint}</Hint>
        {sn.rows.map((r) => (
          <SnippetLine key={r.id} r={r} s={s} focus={r.id === focusId} />
        ))}
        <Row>
          <Button data-dict="snippetAdd" onClick={() => void invoke('dict:addSnippet').then(added)}>
            {sn.addLabel}
          </Button>
        </Row>
      </Fieldset>

      {/* «Свой скрипт»: last, for people who write code. One field, one switch, one check button. */}
      <Fieldset className="post-script" legend={sc.heading}>
        <Hint>{sc.hint}</Hint>
        <Row>
          <TextField
            fieldRef={cmd}
            className="grow"
            value={sc.command}
            placeholder={sc.placeholder}
            spellCheck={false}
            data-dict="script"
            aria-label={sc.heading}
            onInput={(v) => void invoke('dict:setScript', v).then(keep)}
          />
          <Button data-dict="scriptTest" disabled={sc.busy || testing} onClick={test}>
            {sc.testLabel}
          </Button>
        </Row>
        <Check checked={sc.files} data-dict="scriptFiles" onChange={(on) => void invoke('dict:setScriptFiles', on).then(applyDict)} label={' ' + sc.filesLabel} />
        {sc.testLine && (
          <Status warn={sc.testOk === false} data-dict="scriptResult">
            {sc.testLine}
          </Status>
        )}
      </Fieldset>
    </>
  );
}
