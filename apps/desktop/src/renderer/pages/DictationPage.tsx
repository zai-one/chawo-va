// «Диктовка»: mode, the in-window hold button with its level meter, keys, microphone and the update check.
// The microphone itself lives in app/dictation.ts; this page only reads its stores and calls it.
import { useEffect, useState } from 'react';
import type { DictationStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Hint, Status } from '@chawo/ui/Layout';
import { invoke } from '../bridge';
import { applyDictation, cancelTake, holdDown, holdStore, holdUp, meterStore, refreshMicDevices } from '../app/dictation';
import { useL } from '../app/i18n';
import { isPage, showPage, TITLES } from '../app/pages';
import { dictationStore } from '../app/state';
import { useStore } from '../app/store';

type TextPart = NonNullable<DictationStateDto['noModel']>[number];

/** Text with links to other pages («Сеть», «Распознавание»). */
function Parts({ parts }: { parts: readonly TextPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <Button key={i} variant="link" className="inline-link" onClick={() => isPage(p.page) && showPage(p.page)}>
            {p.link}
          </Button>
        ),
      )}
    </>
  );
}

/** Bars next to the hold button; only this re-renders on every level push. */
function Meter() {
  const meter = useStore(meterStore);
  return (
    <div className="meter" data-d="meter">
      {meter.map((v, i) => (
        <span key={i} style={{ height: `${Math.round(8 + 92 * v)}%` }} />
      ))}
    </div>
  );
}

function HoldButton({ s }: { s: DictationStateDto }) {
  const L = useL();
  const pressed = useStore(holdStore);
  const listening = pressed || s.phase === 'Listening';
  const cls = ['hold', listening && 'pressed', s.phase === 'Recognizing' && 'busy'].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      data-d="hold"
      disabled={!s.holdEnabled && !pressed}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-gone pointer */
        }
        holdDown();
      }}
      onKeyDown={(e) => {
        if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
          e.preventDefault();
          holdDown();
        }
      }}
      onKeyUp={(e) => {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          void holdUp();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {pressed && s.phase !== 'Listening' ? L('Говорите… отпустите, чтобы распознать', 'Speak… release to recognize') : s.holdLabel}
    </button>
  );
}

export function DictationPage() {
  const L = useL();
  const s = useStore(dictationStore);
  // «Проверить обновления» stays disabled from the click until main answers.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    void invoke('dictation:state').then(applyDictation).then(() => refreshMicDevices());
  }, []);
  return (
    <>
      <h1>{L(...TITLES.dictation)}</h1>
      {s && (
        <>
          <p className="muted">{s.intro}</p>
          {s.startCard && (
            <div className="card start">
              <div className="card-head">
                <strong>{s.startCard.title}</strong>
                <Button variant="link" onClick={() => void invoke('dictation:dismissStart').then(applyDictation)}>
                  {s.startCard.close}
                </Button>
              </div>
              {s.startCard.steps.map((step, i) => (
                <p key={i} className="step">
                  <Parts parts={step} />
                </p>
              ))}
            </div>
          )}

          <label className="block">{L('Режим', 'Mode')}</label>
          <Select options={s.modeChoices} value={s.mode} onChange={(v) => void invoke('dictation:mode', v).then(applyDictation)} />
          <Hint>{s.modeHint}</Hint>

          {/* Phase line + Stop (WPF), then the in-window hold button with the level meter. */}
          <div className="card phase">
            <span className="phase-line" data-d="phase">
              {s.phaseLine}
            </span>
            <Button data-d="stop" title={s.stopTip} disabled={!s.stopEnabled} onClick={() => cancelTake()}>
              {s.stopLabel}
            </Button>
          </div>
          <div className="hold-row">
            <HoldButton s={s} />
            <Meter />
          </div>
          <Hint>{s.holdHint}</Hint>

          <Status data-d="status">{s.status}</Status>
          {s.noModel && (
            <Hint line>
              <Parts parts={s.noModel} />
            </Hint>
          )}
          <div className="card result" data-d="last" hidden={!s.lastText}>
            <div className="muted hint">{s.lastTextLabel}</div>
            <div className="last-text">{s.lastText}</div>
          </div>

          <div className="form wide">
            <span>{L('Клавиша диктовки', 'Dictation key')}</span>
            <Select
              options={s.hotkeyChoices.map((c) => ({ value: String(c.value), label: c.label }))}
              value={String(s.hotkey)}
              onChange={(v) => void invoke('dictation:hotkey', Number(v)).then(applyDictation)}
            />
            <span>{L('Как вставлять текст', 'How to insert text')}</span>
            <Select options={s.insertChoices} value={s.insertMode} onChange={(v) => void invoke('dictation:insert', v).then(applyDictation)} />
          </div>
          {s.keyNote && <Hint>{s.keyNote}</Hint>}

          <label className="block">{L('Микрофон', 'Microphone')}</label>
          <Select className="wide" options={s.micChoices} value={s.micId} onChange={(v) => void invoke('dictation:mic', v).then(applyDictation)} />
          <Hint>{s.micHint}</Hint>

          <Check checked={s.showOverlay} onChange={(on) => void invoke('dictation:overlay', on).then(applyDictation)} label={' ' + s.overlayLabel} labelTitle={s.overlayTip} />
          <Check data-d="cues" checked={s.soundCues} onChange={(on) => void invoke('dictation:cues', on).then(applyDictation)} label={' ' + s.soundCuesLabel} labelTitle={s.soundCuesTip} />
          <Check data-d="wake" checked={s.wakeWord} onChange={(on) => void invoke('dictation:wake', on).then(applyDictation)} label={' ' + s.wakeLabel} labelTitle={s.wakeTip} />
          {s.wakeNote && <Hint data-d="wake-note">{s.wakeNote}</Hint>}

          {/* Manual update check (WPF CheckUpdatesButton at the bottom of Dictation). Check only; opens the release page if the user confirms. */}
          <Button
            data-d="updates"
            title={s.checkUpdatesTip}
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void invoke('dictation:checkUpdates').then(applyDictation).finally(() => setChecking(false));
            }}
          >
            {s.checkUpdatesLabel}
          </Button>
          {s.version && <Hint>{`${s.versionLabel} ${s.version}`}</Hint>}
        </>
      )}
    </>
  );
}
