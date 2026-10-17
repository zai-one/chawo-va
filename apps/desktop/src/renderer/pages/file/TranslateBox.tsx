// «Перевести» — offline translation of the last transcript via the same Brain (IDEAS №15).
import { useRef } from 'react';
import type { FileStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Card, Fieldset, Hint } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyFile } from '../../app/state';
import { SpeakButton } from '../SpeakButton';

const LANG_LIST_ID = 'translate-langs';

export function TranslateBox({ s }: { s: FileStateDto }) {
  const L = useL();
  const tr = s.translate;
  const lang = useRef<HTMLInputElement>(null);
  return (
    <Fieldset className="translate-box" legend={L('Перевод', 'Translation')}>
      <Hint>
        {tr.available
          ? L(`Мозг: ${tr.where}. Пишет .translate.txt рядом с расшифровкой. В диктовке: «Чаво, переведи на …».`,
            `Brain: ${tr.where}. Writes .translate.txt beside the transcript. In dictation: “Chawo, translate to …”.`)
          : L('Нужен Мозг: скачайте локальную модель на «Мозге» или настройте свой сервер.', 'Needs the Brain: download a local model on Brain, or set up your own server.')}
      </Hint>
      <div className="row inline">
        <label>{L('На язык ', 'Into ')}</label>
        <TextField
          fieldRef={lang}
          id="translate-to"
          list={LANG_LIST_ID}
          value={tr.target}
          spellCheck={false}
          autoComplete="off"
          placeholder={L('авто: русский → английский, иначе → русский', 'auto: Russian → English, else → Russian')}
          onCommit={(v) => void invoke('file:translateTarget', v).then(applyFile)}
        />
        <datalist id={LANG_LIST_ID}>
          {tr.languages.map((l) => (
            <option key={l.code} value={l.label} />
          ))}
        </datalist>
        <Button disabled={s.busy || tr.busy || !tr.available || !s.lastOutput} onClick={() => void invoke('file:runTranslate', lang.current?.value ?? '').then(applyFile)}>
          {L('Перевести последнюю расшифровку', 'Translate the last transcript')}
        </Button>
      </div>
      {tr.text && (
        <Card className="result translate-card">
          <div className="card-head">
            <strong>{L('Перевод', 'Translation')}</strong>
            <span className="row inline">
              <SpeakButton text={tr.text} />
              {tr.path ? (
                <Button variant="link" onClick={() => void invoke('file:reveal', tr.path!)}>
                  {L('Показать файл', 'Show file')}
                </Button>
              ) : (
                <span />
              )}
            </span>
          </div>
          <pre className="last-text">{tr.text}</pre>
        </Card>
      )}
    </Fieldset>
  );
}
