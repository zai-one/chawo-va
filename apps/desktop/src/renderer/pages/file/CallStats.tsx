// «Статистика разговора» (как у Gong): доля речи по спикерам полосками, темп, вопросы, монологи и
// трекеры слов. Считает main-процесс по тем же фразам, что карточка «Расшифровка»; клик по фразе
// трекера — воспроизведение с этого места, если звук рядом найден. Только локально.
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextArea } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyFile } from '../../app/state';
import { ensureEditorAudio, playFrom } from './editorAudio';

/** mm:ss / h:mm:ss for the stats card. */
function statClock(seconds: number): string {
  const v = Math.max(0, Math.round(seconds));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const ss = String(v % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function CallStats({ s }: { s: FileStateDto }) {
  const L = useL();
  const cs = s.callStats;
  const st = cs.stats;
  if (!st || st.phrases === 0) return null;
  const spName = (id: number) => (id < 0 ? L('Речь', 'Speech') : L(`Спикер ${id + 1}`, `Speaker ${id + 1}`));
  const ed = s.editor;
  // The same <audio> as the transcript card, so both share one play position.
  const mediaUrl = ed.available && ed.mediaUrl ? ed.mediaUrl : null;
  const m = st.longestMonologue;
  return (
    <Fieldset className="call-stats" data-stats="card" legend={L('Статистика разговора', 'Call stats')}>
      <Hint>
        {L(
          `Длительность ${statClock(st.durationSeconds)}, речь ${statClock(st.talkSeconds)}, слов ${st.words}.` + (st.diarized ? ` Смен говорящего: ${st.turns} (${st.turnsPerMinute}/мин).` : ''),
          `Duration ${statClock(st.durationSeconds)}, speech ${statClock(st.talkSeconds)}, ${st.words} words.` + (st.diarized ? ` Speaker switches: ${st.turns} (${st.turnsPerMinute}/min).` : ''),
        )}
      </Hint>
      {!st.diarized && (
        <Hint>
          {L(
            'Спикеры не размечены: включите «Разделять по спикерам» и расшифруйте снова, чтобы увидеть долю речи каждого.',
            "No speaker labels: turn on «Split by speakers» and transcribe again to see each speaker's share.",
          )}
        </Hint>
      )}
      <div className="talk-bars">
        {st.speakers.map((sp) => {
          const pct = Math.round(sp.share * 100);
          return (
            <div key={sp.speaker} className="talk-row" data-speaker={String(sp.speaker)}>
              <span className="talk-name">{spName(sp.speaker)}</span>
              <span className="talk-bar">
                <span className="talk-fill" style={{ width: `${Math.max(1, pct)}%` }} />
              </span>
              <span className="talk-pct">{`${pct}%`}</span>
              <span className="muted talk-meta">
                {L(
                  `${statClock(sp.talkSeconds)} · ${sp.wpm} сл/мин · вопросов ${sp.questions} · монолог до ${statClock(sp.longestMonologueSeconds)}`,
                  `${statClock(sp.talkSeconds)} · ${sp.wpm} wpm · ${sp.questions} questions · monologue up to ${statClock(sp.longestMonologueSeconds)}`,
                )}
              </span>
            </div>
          );
        })}
      </div>
      {m && m.seconds >= 60 && (
        <Hint warn>
          {L(
            `Самый длинный монолог: ${spName(m.speaker)}, ${statClock(m.seconds)} (с ${statClock(m.start)}). Монологов дольше минуты: ${st.longMonologues}.`,
            `Longest monologue: ${spName(m.speaker)}, ${statClock(m.seconds)} (at ${statClock(m.start)}). Monologues over a minute: ${st.longMonologues}.`,
          )}
        </Hint>
      )}
      <label>{L('Трекеры слов', 'Keyword trackers')}</label>
      {/* Trackers: count chips; a chip with hits opens the matching phrases. */}
      <div className="trackers">
        {st.trackers.map((tr, ti) => (
          <details key={ti} className="tracker" data-tracker={tr.name}>
            <summary>
              <span className="tracker-name">{tr.name}</span>
              <span className={tr.count > 0 ? 'tracker-count hit' : 'tracker-count'}>{String(tr.count)}</span>
            </summary>
            {tr.hits.length === 0 && <Hint>{L(`Не встретилось: ${tr.terms.join(', ')}`, `Not found: ${tr.terms.join(', ')}`)}</Hint>}
            {tr.hits.map((h, i) => {
              const who = typeof h.speaker === 'number' ? spName(h.speaker) + ' · ' : '';
              return (
                <button key={i} type="button" className="phrase" disabled={!mediaUrl} onClick={() => mediaUrl && playFrom(ensureEditorAudio(mediaUrl), h.start)}>
                  <span className="phrase-time">{statClock(h.start)}</span>
                  <span className="phrase-body">{who + h.text}</span>
                </button>
              );
            })}
          </details>
        ))}
      </div>
      {/* Tracker editor: one line per tracker, «Название: слово, слов*»; empty = built-in. */}
      <details className="tracker-config">
        <summary>{L('Настроить трекеры', 'Edit trackers')}</summary>
        <Hint>
          {L(
            'По строке на трекер: «Название: слово, слов*, фраза из слов». «*» — любое окончание, ё = е. В терминале: chawo-va stats файл.txt',
            'One line per tracker: «Name: word, wor*, a phrase». «*» = any ending, ё = е. In the terminal: chawo-va stats file.txt',
          )}
        </Hint>
        <TextArea
          rows={6}
          spellCheck={false}
          data-stats="trackers"
          value={cs.trackers}
          placeholder={cs.defaultTrackers}
          onCommit={(v) => void invoke('file:callTrackers', v).then(applyFile)}
        />
        <Row>
          <Button variant="link" onClick={() => void invoke('file:callTrackers', '').then(applyFile)}>
            {L('Вернуть встроенные', 'Restore built-in')}
          </Button>
        </Row>
      </details>
    </Fieldset>
  );
}
