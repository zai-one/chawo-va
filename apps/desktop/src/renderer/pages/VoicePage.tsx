// «Голос»: the service that reads text aloud, its key, model, voice and speed, and how reading starts
// (the button next to a selection, a key). The key typed here is never shown back.
import { useEffect } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Hint, Row } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import type { VoiceStateDto } from '@chawo/ipc/contract';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applyVoice, voiceStore } from '../app/state';
import { useStore } from '../app/store';

/** Service fields; keyed by provider, so a switch starts from that service's values. */
function ServiceBlock({ s }: { s: VoiceStateDto }) {
  const L = useL();
  return (
    <div className="form">
      <span>{L('Ключ API', 'API key')}</span>
      <div>
        <TextField
          type="password"
          value=""
          placeholder={s.key.placeholder}
          spellCheck={false}
          autoComplete="off"
          data-voice="key"
          onInput={(text) => void invoke('voice:key', text).then(applyVoice)}
        />
        {s.key.link && (
          <Button variant="link" disabled={!s.key.linkEnabled} onClick={() => void invoke('voice:keysLink')}>
            {s.key.link}
          </Button>
        )}
      </div>
      {s.url.visible && (
        <>
          <span>{L('Адрес', 'Address')}</span>
          <TextField value={s.url.value} placeholder={s.url.placeholder} spellCheck={false} data-voice="url" onCommit={(url) => void invoke('voice:url', url).then(applyVoice)} />
        </>
      )}
      <span>{L('Модель', 'Model')}</span>
      <div>
        <TextField value={s.model} spellCheck={false} list="voice-models" data-voice="model" onCommit={(m) => void invoke('voice:model', m).then(applyVoice)} />
        <datalist id="voice-models">
          {s.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <span>{L('Голос', 'Voice')}</span>
      <div>
        <TextField value={s.voice} spellCheck={false} list="voice-voices" data-voice="voice" onCommit={(v) => void invoke('voice:voice', v).then(applyVoice)} />
        <datalist id="voice-voices">
          {s.voices.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        {s.voiceHint && <Hint data-voice="voice-hint">{s.voiceHint}</Hint>}
      </div>
      <span>{L('Скорость', 'Speed')}</span>
      <Select
        options={s.speeds.map((x) => ({ value: String(x.value), label: x.label }))}
        value={String(s.speed)}
        onChange={(v) => void invoke('voice:speed', Number(v)).then(applyVoice)}
      />
    </div>
  );
}

export function VoicePage() {
  const L = useL();
  const s = useStore(voiceStore);
  useEffect(() => {
    void invoke('voice:state').then(applyVoice);
  }, []);
  if (!s) return <h1>{L(...TITLES.voice)}</h1>;
  const on = s.providerId !== '';
  return (
    <>
      <h1>{L(...TITLES.voice)}</h1>
      <p className="muted">{s.hint}</p>
      <Row>
        <span>{L('Сервис', 'Service')}</span>
        <Select data-voice="provider" options={s.providers.map((p) => ({ value: p.id, label: p.label }))} value={s.providerId} onChange={(id) => void invoke('voice:provider', id).then(applyVoice)} />
      </Row>
      {s.note && <Hint>{s.note}</Hint>}
      {on && <ServiceBlock key={s.providerId} s={s} />}
      {s.warning && <Hint warn>{s.warning}</Hint>}
      {on && (
        <>
          <Row className="voice-test">
            <Button variant="primary" data-voice="test" disabled={s.test.running} onClick={() => void invoke('voice:test').then(applyVoice)}>
              {L('Проверить', 'Try it')}
            </Button>
          </Row>
          {s.test.status && (
            <Hint line warn={s.test.failed} data-voice="status">
              {s.test.status}
            </Hint>
          )}
        </>
      )}
      {on && s.selection.visible && (
        <>
          <Check checked={s.selection.on} onChange={(v) => void invoke('voice:selection', v).then(applyVoice)} label={' ' + L('Кнопка «Озвучить» у выделенного текста', '«Read aloud» button at selected text')} />
          <Hint indent>{s.selection.hint}</Hint>
        </>
      )}
      {on && s.hotkey.visible && (
        <>
          <Row>
            <span>{L('Клавиша «Озвучить»', '«Read aloud» key')}</span>
            <Select
              options={s.hotkey.choices.map((c) => ({ value: String(c.value), label: c.label }))}
              value={String(s.hotkey.vk)}
              onChange={(v) => void invoke('voice:hotkey', Number(v)).then(applyVoice)}
            />
          </Row>
          <Hint>{s.hotkey.hint}</Hint>
        </>
      )}
    </>
  );
}
