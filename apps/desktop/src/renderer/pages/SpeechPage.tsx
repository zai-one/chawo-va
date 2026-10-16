// «Распознавание»: speech models (download / select / delete), where speech runs, VAD and idle unload.
import { useEffect } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check, Radio, Select } from '@chawo/ui/Choice';
import { Card, Hint, Progress, Row } from '@chawo/ui/Layout';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applySpeech, speechStore } from '../app/state';
import { useStore } from '../app/store';

export function SpeechPage() {
  const L = useL();
  const s = useStore(speechStore);
  useEffect(() => {
    void invoke('speech:state').then(applySpeech);
  }, []);
  if (!s) return <h1>{L(...TITLES.speech)}</h1>;
  const busy = s.download?.running === true;
  const d = s.download;
  const threads = [
    { value: '0', label: L(`Все ядра (${s.cores})`, `All cores (${s.cores})`) },
    ...Array.from({ length: s.cores }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
  ];
  return (
    <>
      <h1>{L(...TITLES.speech)}</h1>
      <p className="muted">{s.intro}</p>
      <label className="block">{L('Речевые модели', 'Speech models')}</label>
      <div className="models">
        {s.models.map((m) => (
          <div key={m.kind} className="model">
            <label title={m.path ?? ''}>
              <Radio name="speech-model" checked={m.selected} disabled={busy} onSelect={() => void invoke('speech:select', m.kind).then(applySpeech)} />
              {' ' + m.label}
            </label>
            {m.onDisk ? (
              <span className="disk">{L('на диске', 'on disk')}</span>
            ) : (
              <Button
                disabled={busy || s.client}
                title={s.client ? L('Клиент не скачивает модель.', 'A client does not download a model.') : undefined}
                onClick={() => void invoke('speech:download', m.kind).then(applySpeech)}
              >
                {L('Скачать', 'Download')}
              </Button>
            )}
            {m.canDelete && (
              <Button title={m.deleteTip} disabled={busy && s.download?.kind === m.kind} onClick={() => void invoke('speech:delete', m.kind).then(applySpeech)}>
                {L('Удалить', 'Delete')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <Hint>{s.note}</Hint>

      {d ? (
        <Card failed={d.failed}>
          <div>{s.models.find((m) => m.kind === d.kind)?.label ?? d.kind}</div>
          {d.running && <Progress percent={d.percent} />}
          <p className="status muted">{d.text}</p>
          <Row>
            {d.running ? (
              <Button onClick={() => void invoke('speech:cancel').then(applySpeech)}>{L('Отмена', 'Cancel')}</Button>
            ) : (
              <>
                {d.failed && !s.client && (
                  <Button variant="primary" onClick={() => void invoke('speech:download', d.kind).then(applySpeech)}>
                    {L('Повторить', 'Retry')}
                  </Button>
                )}
                <Button variant="link" onClick={() => void invoke('speech:dismiss').then(applySpeech)}>
                  {L('Скрыть', 'Hide')}
                </Button>
              </>
            )}
          </Row>
        </Card>
      ) : (
        !s.client &&
        s.models.some((m) => !m.onDisk) && <Hint>{L('Пока кнопка «Скачать» не нажата, в сеть ничего не уходит.', 'Nothing goes out on the network until you press Download.')}</Hint>
      )}

      <label className="block">{L('Где считать речь', 'Where speech runs')}</label>
      <Select options={s.deviceChoices} value={s.device} onChange={(v) => void invoke('speech:device', v as 'Gpu' | 'Cpu').then(applySpeech)} />

      {s.device === 'Cpu' && (
        <>
          <label className="block">{L('Потоки процессора для диктовки', 'Processor threads for dictation')}</label>
          <Select options={threads} value={String(s.cpuThreads)} onChange={(v) => void invoke('speech:threads', Number(v)).then(applySpeech)} />
          <Hint>{s.threadsHint}</Hint>
        </>
      )}

      {s.vad && (
        <>
          <Check labelClass="block" checked={s.vad.enabled} onChange={(on) => void invoke('speech:vad', on).then(applySpeech)} label={L(' Обрезать тишину (VAD)', ' Trim silence (VAD)')} />
          <Hint>
            {s.vad.note}
            {s.vad.canDownload && (
              <>
                {' '}
                <Button variant="link" onClick={() => void invoke('speech:vadDownload').then(applySpeech)}>
                  {L('Скачать (2 МБ)', 'Download (2 MB)')}
                </Button>
              </>
            )}
          </Hint>
        </>
      )}

      <label className="block">{L('Выгружать модели при простое', 'Unload models when idle')}</label>
      <Select
        options={s.idleChoices.map((c) => ({ value: String(c.value), label: c.label }))}
        value={String(s.idleMinutes)}
        onChange={(v) => void invoke('speech:idle', Number(v)).then(applySpeech)}
      />
      <Hint>{s.idleHint}</Hint>

      <p className="muted line">{s.status}</p>
    </>
  );
}
