// «Расшифровка файла»: the queue, the transcript of the last file, a meeting recording, output options,
// the Brain cards, a link (yt-dlp), ffmpeg and the speaker models.
import { useEffect, useRef } from 'react';
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../bridge';
import { useL, useRu } from '../app/i18n';
import { applyMeeting } from '../app/meeting';
import { TITLES } from '../app/pages';
import { applyFile, fileStore } from '../app/state';
import { useStore } from '../app/store';
import { BriefBox } from './file/BriefBox';
import { CallStats } from './file/CallStats';
import { MeetingBox } from './file/MeetingBox';
import { ScoreBox } from './file/ScoreBox';
import { TranscriptEditor } from './file/TranscriptEditor';
import { TranslateBox } from './file/TranslateBox';

type FileExtraFormat = FileStateDto['options']['extra'][number];

const EXTRA_FORMATS: readonly [FileExtraFormat, [string, string]][] = [
  ['vtt', ['Субтитры WebVTT для сайтов и плееров', 'WebVTT subtitles for web players']],
  ['json', ['Фразы со временем для скриптов', 'Timed phrases for scripts']],
  ['md', ['Markdown для заметок', 'Markdown for notes']],
  ['docx', ['Документ Word', 'Word document']],
];

const STATE_RU: Record<FileStateDto['items'][number]['state'], string> = {
  Queued: 'ждёт',
  Running: 'идёт',
  Done: 'готово',
  Failed: 'ошибка',
  Stopped: 'остановлено',
};

const SPEED: [string, string][] = [
  ['Auto', 'Авто'],
  ['Gentle1', '1 поток (бережно)'],
  ['Two', '2'],
  ['Four', '4'],
  ['Max', 'Максимум'],
];

const SPEED_EN: Record<string, string> = { Auto: 'Auto', Gentle1: '1 thread (gentle)', Two: '2', Four: '4', Max: 'Max' };

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What is typed in the link field; kept when the page is closed and opened again. */
let urlDraft = '';

export function FilePage() {
  const L = useL();
  const s = useStore(fileStore);
  useEffect(() => {
    void invoke('file:state').then(applyFile);
    void invoke('meeting:state').then(applyMeeting);
  }, []);
  return (
    <>
      <h1>{L(...TITLES.file)}</h1>
      {s && (
        <>
          <Row>
            <Button onClick={() => void invoke('file:pick', 'files').then(applyFile)}>{L('Добавить файлы…', 'Add files…')}</Button>
            <Button onClick={() => void invoke('file:pick', 'folder').then(applyFile)}>{L('Добавить папку…', 'Add folder…')}</Button>
            {s.busy ? (
              <Button variant="primary" onClick={() => void invoke('file:stop').then(applyFile)}>
                {L('Остановить', 'Stop')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void invoke('file:run').then(applyFile)}>
                {L('Расшифровать', 'Transcribe')}
              </Button>
            )}
            {s.lastOutput && <Button onClick={() => void invoke('file:reveal')}>{L('Открыть папку', 'Open folder')}</Button>}
          </Row>
          <Queue s={s} />
          {s.items.some((i) => i.state !== 'Queued' && i.state !== 'Running') && (
            <Row>
              <Button variant="link" onClick={() => void invoke('file:clearFinished').then(applyFile)}>
                {L('Убрать готовые из списка', 'Clear finished')}
              </Button>
            </Row>
          )}
          <TranscriptEditor s={s} />
          <CallStats s={s} />
          <p className="status">{s.status}</p>
          <MeetingBox />
          <OutputBox s={s} />
          <BriefBox s={s} />
          <ScoreBox s={s} />
          <TranslateBox s={s} />
          <UrlBox s={s} />
          <Fieldset legend="ffmpeg">
            <p className="muted">{s.ffmpeg.line}</p>
            {!s.ffmpeg.installed && s.ffmpeg.canDownload && (
              <Button onClick={() => void invoke('file:ffmpegDownload').then(applyFile)}>{L('Скачать ffmpeg', 'Download ffmpeg')}</Button>
            )}
          </Fieldset>
          <Fieldset legend={L('Спикеры', 'Speakers')}>
            <p className="muted">{s.diarization.line}</p>
            {s.diarization.canDownload && (
              <Button onClick={() => void invoke('file:diarizeDownload').then(applyFile)}>{L('Скачать модели (~47 МБ)', 'Download models (~47 MB)')}</Button>
            )}
          </Fieldset>
        </>
      )}
    </>
  );
}

function Queue({ s }: { s: FileStateDto }) {
  const L = useL();
  const ru = useRu();
  return (
    <div className="queue">
      {s.items.length === 0 && (
        <div className="empty muted">
          {L('Перетащите сюда записи или папку. Текст сохранится рядом с файлом (.txt).', 'Drop recordings or a folder here. The text is saved next to each file (.txt).')}
        </div>
      )}
      {s.items.map((it) => {
        const out = it.outputPath;
        return (
          <div key={it.id} className={`item ${it.state.toLowerCase()}`} title={it.path}>
            <span className="name">{fileName(it.path)}</span>
            <span className="state">{ru ? STATE_RU[it.state] : it.state.toLowerCase()}</span>
            <span className="note muted">{it.note}</span>
            {/* Actions share the last grid column, so «Показать» + «Слушать» + × stay on one line. */}
            <span className="acts">
              {out && (
                <>
                  <Button variant="link" onClick={() => void invoke('file:reveal', out)}>
                    {L('Показать', 'Show')}
                  </Button>
                  <Button variant="link" onClick={() => void invoke('file:openEditor', out).then(applyFile)}>
                    {L('Слушать', 'Listen')}
                  </Button>
                </>
              )}
              {it.state !== 'Running' && (
                <Button variant="link" className="x" onClick={() => void invoke('file:remove', it.id).then(applyFile)}>
                  ×
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OutputBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const ru = useRu();
  const o = s.options;
  return (
    <Fieldset legend={L('Вывод', 'Output')}>
      <Check labelClass="" checked={o.timestamps} onChange={(on) => void invoke('file:options', { timestamps: on }).then(applyFile)} label={L(' Метки времени [чч:мм:сс] в .txt', ' Timestamps [hh:mm:ss] in .txt')} />
      <Row>
        {L('Ещё сохранять рядом: ', 'Also save beside it: ')}
        {/* One row for every extra file; .srt keeps its own WPF setting, the others share FileExtraFormats. */}
        <span className="formats">
          <Check labelClass="" labelTitle={L('Субтитры SubRip', 'SubRip subtitles')} checked={o.srt} onChange={(on) => void invoke('file:options', { srt: on }).then(applyFile)} label=" .srt" />
          {EXTRA_FORMATS.map(([f, tip]) => (
            <Check
              key={f}
              labelClass=""
              labelTitle={L(tip[0], tip[1])}
              checked={o.extra.includes(f)}
              onChange={(on) => {
                const next = EXTRA_FORMATS.map(([x]) => x).filter((x) => (x === f ? on : o.extra.includes(x)));
                void invoke('file:options', { extra: next }).then(applyFile);
              }}
              label={` .${f}`}
            />
          ))}
        </span>
      </Row>
      <Check labelClass="" checked={o.diarize} onChange={(on) => void invoke('file:options', { diarize: on }).then(applyFile)} label={L(' Разделять спикеров', ' Separate speakers')} />
      <label>
        {L('Скорость длинных записей ', 'Long recording speed ')}
        <Select
          options={SPEED.map(([v, r]) => ({ value: v, label: ru ? r : SPEED_EN[v] }))}
          value={o.parallelism}
          onChange={(v) => void invoke('file:options', { parallelism: v }).then(applyFile)}
        />
      </label>
    </Fieldset>
  );
}

/** «По ссылке»: yt-dlp downloads the audio, then it is transcribed like a dropped file. */
function UrlBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const link = useRef<HTMLInputElement>(null);
  const go = () => {
    const text = link.current?.value ?? urlDraft;
    if (!text.trim()) return;
    void invoke('file:url', text).then((st) => {
      if (st.url.busy) {
        urlDraft = '';
        // The field keeps what is typed across pushes and is focused after Enter, so it is cleared here.
        if (link.current) link.current.value = '';
      }
      applyFile(st);
    });
  };
  return (
    <Fieldset legend={L('По ссылке', 'From a link')}>
      <Row>
        <TextField
          id="file-url"
          fieldRef={link}
          value={urlDraft}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://www.youtube.com/watch?v=…"
          onInput={(v) => (urlDraft = v)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <Button disabled={s.url.busy || !s.url.installed} onClick={go}>
          {L('Скачать и расшифровать', 'Download and transcribe')}
        </Button>
      </Row>
      <Hint>
        {L(
          `Ссылку откроет yt-dlp — только этот шаг идёт через интернет. Звук сохранится в ${s.url.folder}, текст — рядом, расшифровка на этом компьютере.`,
          `yt-dlp opens the link — only this step uses the internet. The audio is saved to ${s.url.folder} with the text beside it; transcription runs on this computer.`,
        )}
      </Hint>
      <p className="muted">{s.url.line}</p>
      {s.url.canDownload && (!s.url.installed || s.url.managed) && (
        <Button variant="link" disabled={s.busy} onClick={() => void invoke('file:ytdlpDownload').then(applyFile)}>
          {s.url.managed ? L('Обновить yt-dlp', 'Update yt-dlp') : L('Скачать yt-dlp', 'Download yt-dlp')}
        </Button>
      )}
    </Fieldset>
  );
}
