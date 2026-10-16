// «Спросить историю» on «История»: question, where to look, the answer with its sources.
import { useRef } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check } from '@chawo/ui/Choice';
import { Hint, Row, Status } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../bridge';
import { applyAsk, askStore } from '../app/state';
import { useStore } from '../app/store';

/** What is typed in the question box, kept while the page is closed (as before React). */
let askDraft: string | null = null;

export function AskBox() {
  const a = useStore(askStore);
  const q = useRef<HTMLInputElement>(null);
  // HistoryPage asks main for the state (after history:state, like the legacy show()).
  const go = () => {
    const text = q.current?.value ?? '';
    if (!a || a.busy || !text.trim()) return;
    void invoke('ask:run', text).then(applyAsk);
  };
  const chip = (key: string, label: string, tip: string, remove?: () => void) => (
    <span key={key} className="ask-chip" title={tip}>
      {label}
      {remove && (
        <Button variant="link" onClick={remove}>
          ×
        </Button>
      )}
    </span>
  );
  return (
    <section className="ask" data-ask="box">
      {a && (
        <>
          <h2>{a.title}</h2>
          <Row>
            <TextField
              fieldRef={q}
              value={askDraft ?? a.question}
              onInput={(v) => (askDraft = v)}
              placeholder={a.placeholder}
              spellCheck={false}
              maxLength={500}
              data-ask="q"
              className="ask-q"
              onKeyDown={(e) => {
                if (e.key === 'Enter') go();
              }}
            />
            {a.busy ? (
              <Button data-ask="run" onClick={() => void invoke('ask:cancel').then(applyAsk)}>
                {a.labels.cancel}
              </Button>
            ) : (
              <Button variant="primary" data-ask="run" onClick={go}>
                {a.labels.ask}
              </Button>
            )}
          </Row>
          <Row className="ask-where muted">
            <span>{a.labels.where}</span>
            <Check checked={a.useHistory} onChange={(on) => void invoke('ask:history', on).then(applyAsk)} labelClass="" label={' ' + a.labels.history} />
            {a.meetingFolders.length > 0 && chip('meetings', a.labels.meetings, a.meetingFolders.join('\n'))}
            {a.folders.map((f) => chip('f:' + f, f.split(/[\\/]/).filter(Boolean).pop() ?? f, f, () => void invoke('ask:removeFolder', f).then(applyAsk)))}
            <Button variant="link" onClick={() => void invoke('ask:addFolder').then(applyAsk)}>
              {a.labels.addFolder}
            </Button>
          </Row>
          <Hint>{a.brainLine}</Hint>
          <Status data-ask="status">{a.status}</Status>
          {a.answer && (
            <>
              <div className="ask-answer" data-ask="answer">
                {a.answer}
              </div>
              <Row className="hist-acts">
                <Button variant="link" onClick={() => void invoke('ask:copy').then(applyAsk)}>
                  {a.labels.copy}
                </Button>
              </Row>
            </>
          )}
          {a.excerpts.length > 0 && (
            <>
              <div className="muted hint">{a.labels.sources}</div>
              <div className="ask-src" data-ask="sources">
                {/* With an answer only the cited excerpts are open; the rest stay folded. */}
                {a.excerpts.map((x, i) => (
                  <details key={`${i}:${x.n}`} className="ask-ex" open={a.answer ? x.cited : true}>
                    <summary>
                      <b>{`[${x.n}] `}</b>
                      {`${x.title}${x.when ? ' · ' + x.when : ''}`}
                    </summary>
                    <div className="hist-text">{x.text}</div>
                    {x.path && (
                      <Row className="hist-acts">
                        <Button variant="link" onClick={() => void invoke('ask:open', x.path ?? '').then(applyAsk)}>
                          {a.labels.open}
                        </Button>
                      </Row>
                    )}
                  </details>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
