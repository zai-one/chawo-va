// «Расшифровка»: timed phrases; click seeks the source audio (chawo-media://), double-click fixes a phrase.
import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { FileEditorSegmentDto, FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Fieldset, Hint, Row, Status } from '@chawo/ui/Layout';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyFile } from '../../app/state';
import { activePhrases, ensureEditorAudio, pauseAudio, playFrom, subscribeAudio } from './editorAudio';

function formatSegTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TranscriptEditor({ s }: { s: FileStateDto }) {
  const L = useL();
  const ed = s.editor;
  const txt = ed.txtPath;
  if (ed.available && ed.mediaUrl && ed.segments.length > 0) {
    return (
      <Fieldset className="transcript-editor" legend={L('Расшифровка', 'Transcript')}>
        <Phrases key={ed.mediaUrl} mediaUrl={ed.mediaUrl} segments={ed.segments} />
        {ed.note && (
<Status data-editor="note">{ed.note}</Status>
        )}
        {txt && (
          <Row>
            <Button variant="link" onClick={() => void invoke('file:reveal', txt)}>
              {L('Показать файл', 'Show file')}
            </Button>
          </Row>
        )}
      </Fieldset>
    );
  }
  const why =
    ed.reason === 'no-timings'
      ? L('Нет меток времени. Включите «Метки времени» или сохранение .srt / .json и расшифруйте снова.', 'No timings. Enable timestamps or .srt / .json and transcribe again.')
      : ed.reason === 'no-audio'
        ? L('Фразы есть, но исходный звук рядом не найден.', 'Phrases are here, but the source audio was not found beside them.')
        : ed.txtPath
          ? L('Расшифровка ещё без фраз со временем.', 'The transcript has no timed phrases yet.')
          : L('После расшифровки здесь появятся фразы — нажмите, чтобы слушать с этого места.', 'After transcription, phrases appear here — click to play from that time.');
  return (
    <Fieldset className="transcript-editor" legend={L('Расшифровка', 'Transcript')}>
      <Hint>{why}</Hint>
      {(ed.txtPath || s.lastOutput) && (
        <Row>
          <Button variant="link" onClick={() => void invoke('file:openEditor', ed.txtPath || s.lastOutput || undefined).then(applyFile)}>
            {L('Открыть расшифровку', 'Open transcript')}
          </Button>
        </Row>
      )}
    </Fieldset>
  );
}

/** The shared <audio>, the hint and the phrase rows. */
function Phrases({ mediaUrl, segments }: { mediaUrl: string; segments: FileEditorSegmentDto[] }) {
  const L = useL();
  const audio = ensureEditorAudio(mediaUrl);
  const slot = useRef<HTMLDivElement>(null);
  // The one manual DOM step: the cached <audio> is not React's, so it keeps its play position.
  useLayoutEffect(() => {
    slot.current?.replaceChildren(audio);
    return () => audio.remove();
  }, [audio]);
  const subscribe = useCallback((cb: () => void) => subscribeAudio(audio, cb), [audio]);
  const active = useSyncExternalStore(subscribe, () => activePhrases(audio, segments));
  const on = new Set(active ? active.split(',').map(Number) : []);
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <>
      <div ref={slot} style={{ display: 'contents' }} />
      <Hint>
        {L(
          'Нажмите фразу — воспроизведение с этого места. Двойной щелчок — исправить (поправки слов попадут в «Словарь» → «Из исправлений»).',
          'Click a phrase to play from that time. Double-click to fix it (word fixes go to Dictionary → From your fixes).',
        )}
      </Hint>
      <div className="phrases">
        {segments.map((seg, i) => {
          if (editing === i) return <PhraseEdit key={i} index={i} text={seg.text} onClose={() => setEditing(null)} />;
          const sp = typeof seg.speaker === 'number' ? L(`Спикер ${seg.speaker + 1}`, `Speaker ${seg.speaker + 1}`) + ' · ' : '';
          return (
            <button
              key={i}
              type="button"
              className={on.has(i) ? 'phrase active' : 'phrase'}
              onClick={() => playFrom(audio, seg.start)}
              onDoubleClick={() => {
                pauseAudio(audio);
                // At once: the input must be in the DOM when the dblclick event returns (the e2e driver looks for it).
                flushSync(() => setEditing(i));
              }}
            >
              <span className="phrase-time">{formatSegTime(seg.start)}</span>
              <span className="phrase-body">{sp + seg.text}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Fix the phrase in place (Enter or blur saves, Esc cancels); the fix also teaches «Словарь». */
function PhraseEdit({ index, text, onClose }: { index: number; text: string; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const save = useEffectEvent((v: string) => {
    if (v.trim() && v.trim() !== text.trim()) {
      void invoke('file:editPhrase', index, v).then((st) => {
        applyFile(st);
        onClose();
      });
    } else onClose();
  });
  const cancel = useEffectEvent(() => onClose());
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      if (keep) save(input.value);
      else cancel();
    };
    // Native listeners: a script's non-bubbling keydown never reaches React's root listener.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    };
    const blur = () => finish(true);
    input.addEventListener('keydown', key);
    input.addEventListener('blur', blur);
    input.focus();
    return () => {
      done = true;
      input.removeEventListener('keydown', key);
      input.removeEventListener('blur', blur);
    };
  }, []);
  return <input ref={ref} type="text" defaultValue={text} spellCheck className="phrase-edit" data-editor="phraseEdit" />;
}
