// «Расшифровка файла»: the queue, the transcript of the last file, a meeting recording, output options,
// the Brain cards, a link (yt-dlp), ffmpeg and the speaker models.
import { useEffect, useRef, useState } from 'react';
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Fieldset, Hint, Progress, Row, Status } from '@chawo/ui/Layout';
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

/** 83 s → "1:23", an hour and more → "1:02:03". */
function clock(seconds: number): string {
  const v = Math.max(0, Math.floor(seconds));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const ss = String(v % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Date.now(), refreshed every second while `on` (the elapsed time of the running file). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

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
          {/* The options, then the button that runs with them, then how far it is — one place to look. */}
          <OutputBox s={s} />
          <RunBox s={s} />
          <TranscriptEditor s={s} />
          <CallStats s={s} />
          <MeetingBox />
          <BriefBox s={s} />
          <ScoreBox s={s} />
          <TranslateBox s={s} />
          <UrlBox s={s} />
          <Fieldset legend="ffmpeg">
            <p className="muted">{s.ffmpeg.line}</p>
            {s.ffmpeg.busy ? (
              <Button onClick={() => void invoke('file:cancelDownload', 'ffmpeg').then(applyFile)}>{L('Отменить', 'Cancel')}</Button>
            ) : (
              !s.ffmpeg.installed &&
              s.ffmpeg.canDownload && (
                <Button
                  disabled={s.busy}
                  title={s.busy ? L('Можно после расшифровки: ffmpeg сейчас может быть занят.', 'Available after the transcription: ffmpeg may be in use now.') : undefined}
                  onClick={() => void invoke('file:ffmpegDownload').then(applyFile)}
                >
                  {L('Скачать ffmpeg', 'Download ffmpeg')}
                </Button>
              )
            )}
          </Fieldset>
          <Fieldset legend={L('Спикеры', 'Speakers')}>
            <SpeakerModels s={s} />
          </Fieldset>
        </>
      )}
    </>
  );
}

/** «Расшифровать» / «Остановить» under the options, with the progress of the running file. */
function RunBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const p = s.progress;
  const now = useNow(p !== null);
  const queued = s.items.filter((i) => i.state === 'Queued').length;
  return (
    <div className="run-box">
      <Row>
        {s.busy ? (
          <Button variant="primary" onClick={() => void invoke('file:stop').then(applyFile)}>
            {L('Остановить', 'Stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={queued === 0}
            title={queued === 0 ? L('Добавьте записи в список выше.', 'Add recordings to the list above.') : undefined}
            onClick={() => void invoke('file:run').then(applyFile)}
          >
            {queued > 1 ? L(`Расшифровать (${queued})`, `Transcribe (${queued})`) : L('Расшифровать', 'Transcribe')}
          </Button>
        )}
        {p && (
          <span className="muted">
            {p.percent !== null && `${Math.floor(p.percent)}% · `}
            {L(`идёт ${clock((now - p.startedAt) / 1000)}`, `${clock((now - p.startedAt) / 1000)} elapsed`)}
          </span>
        )}
      </Row>
      {p && <Progress percent={p.percent} />}
      <Status>{s.status}</Status>
    </div>
  );
}

/** Speaker models: the line, the download with its own progress and «Отменить». */
function SpeakerModels({ s }: { s: FileStateDto }) {
  const L = useL();
  const d = s.diarization;
  const pct = /(\d+)%/.exec(d.line);
  return (
    <>
      <p className="muted">{d.line}</p>
      {d.downloading && <Progress percent={pct ? Number(pct[1]) : null} />}
      {d.downloading ? (
        <Button onClick={() => void invoke('file:cancelDownload', 'diarize').then(applyFile)}>{L('Отменить', 'Cancel')}</Button>
      ) : (
        d.canDownload && (
          <Button onClick={() => void invoke('file:diarizeDownload').then(applyFile)}>{L('Скачать модели (~47 МБ)', 'Download models (~47 MB)')}</Button>
        )
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
            <span className="state">
              {ru ? STATE_RU[it.state] : it.state.toLowerCase()}
              {it.state === 'Running' && s.progress?.percent != null && ` ${Math.floor(s.progress.percent)}%`}
            </span>
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
      {o.diarize && !s.diarization.onDisk && (
        <Hint warn indent>
          {s.diarization.downloading
            ? s.diarization.line
            : L('Нужны модели спикеров (~47 МБ) — без них текст будет без спикеров. ', 'Speaker models (~47 MB) are needed; without them the text has no speakers. ')}
          {s.diarization.canDownload && (
            <Button variant="link" onClick={() => void invoke('file:diarizeDownload').then(applyFile)}>
              {L('Скачать', 'Download')}
            </Button>
          )}
        </Hint>
      )}
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
      {s.url.downloading ? (
        <Button variant="link" onClick={() => void invoke('file:cancelDownload', 'ytdlp').then(applyFile)}>
          {L('Отменить скачивание yt-dlp', 'Cancel the yt-dlp download')}
        </Button>
      ) : (
        s.url.canDownload &&
        (!s.url.installed || s.url.managed) && (
          <Button variant="link" disabled={s.busy} onClick={() => void invoke('file:ytdlpDownload').then(applyFile)}>
            {s.url.managed ? L('Обновить yt-dlp', 'Update yt-dlp') : L('Скачать yt-dlp', 'Download yt-dlp')}
          </Button>
        )
      )}
    </Fieldset>
  );
}
