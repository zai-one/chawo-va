// «Встреча» on the file page: record mic (+ computer sound); the capture itself lives in app/meeting.ts.
import type { MeetingStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../../bridge';
import { useL } from '../../app/i18n';
import { applyMeeting, meetingFinish, meetingLive, meetingStart } from '../../app/meeting';
import { meetingStore } from '../../app/state';
import { useStore } from '../../app/store';

const clockText = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const bars = (v: number) => '▮'.repeat(Math.min(8, Math.round(Math.sqrt(Math.min(1, v)) * 8))).padEnd(8, '·');

export function MeetingBox() {
  const L = useL();
  const m = useStore(meetingStore);
  if (!m) return null;
  const why = m.offer?.reasons.length ? m.offer.reasons.slice(0, 3).join(' · ') : L('приложения или календарь', 'apps or calendar');
  return (
    <Fieldset className="meeting" legend={L('Встреча', 'Meeting')}>
      {m.offer && !m.recording && (
        <div className="meeting-offer">
          <p className="offer-title">{L('Похоже, идёт встреча — записать?', 'Looks like a meeting — record it?')}</p>
          <Hint>{why}</Hint>
          <Row>
            <Button variant="primary" onClick={() => void meetingStart()}>
              {L('Записать', 'Record')}
            </Button>
            <Button variant="link" onClick={() => void invoke('meeting:offerSnooze').then(applyMeeting)}>
              {L('Не сейчас', 'Not now')}
            </Button>
            <Button variant="link" onClick={() => void invoke('meeting:offerNever').then(applyMeeting)}>
              {L('Больше не предлагать', 'Do not offer again')}
            </Button>
          </Row>
        </div>
      )}
      {m.recording ? (
        <>
          <RecLine m={m} />
          <Row>
            <Button variant="primary" onClick={() => void meetingFinish(false)}>
              {L('Остановить и расшифровать', 'Stop and transcribe')}
            </Button>
            <Button variant="link" onClick={() => void meetingFinish(true)}>
              {L('Отменить', 'Cancel')}
            </Button>
          </Row>
        </>
      ) : (
        <>
          <Row>
            <Button onClick={() => void meetingStart()}>{L('Записать встречу', 'Record a meeting')}</Button>
          </Row>
          {m.systemSupported && (
            <Check
              labelClass=""
              checked={m.systemOn}
              onChange={(on) => void invoke('meeting:system', on).then(applyMeeting)}
              label={L(' Со звуком компьютера (собеседники в Zoom, Teams, Telegram)', ' With the computer sound (people in Zoom, Teams, Telegram)')}
            />
          )}
          <Check
            id="meeting-auto-detect"
            checked={m.autoDetect}
            onChange={(on) => void invoke('meeting:autoDetect', on).then(applyMeeting)}
            label={' ' + L('Предлагать запись, если похоже на встречу', 'Offer to record when a meeting looks active')}
          />
          {m.autoDetect && (
            <>
              <Check
                id="meeting-auto-apps"
                checked={m.autoDetectApps}
                onChange={(on) => void invoke('meeting:autoDetectApps', on).then(applyMeeting)}
                label={' ' + L('Смотреть Zoom, Teams, Телемост и др. (Windows/Linux)', 'Watch Zoom, Teams, Telemost, etc. (Windows/Linux)')}
              />
              <Row className="cal-row">
                <TextField
                  id="meeting-auto-cal"
                  className="grow"
                  placeholder={L('Файл или папка .ics (необязательно)', '.ics file or folder (optional)')}
                  value={m.autoDetectCalendar}
                  onCommit={(v) => void invoke('meeting:autoDetectCalendar', v.trim()).then(applyMeeting)}
                />
                <Button variant="link" onClick={() => void invoke('meeting:pickCalendar').then(applyMeeting)}>
                  {L('Обзор…', 'Browse…')}
                </Button>
              </Row>
              <Hint>
                {L(
                  'Выкл. по умолчанию. Не запускает запись сама — только спрашивает. «Не сейчас» — пауза ~20 мин. Календарь только локальный .ics (RRULE/EXDATE, без отменённых), без облака.',
                  'Off by default. Never starts recording by itself — only asks. “Not now” snoozes ~20 min. Calendar is a local .ics only (RRULE/EXDATE, skips cancelled), no cloud.',
                )}
              </Hint>
            </>
          )}
          <Hint>{L(`Запись остаётся только на этом компьютере: ${m.folder}. Текст сохранится рядом.`, `The recording stays on this PC only: ${m.folder}. The text is saved next to it.`)}</Hint>
        </>
      )}
      {m.note && <p className="muted">{m.note}</p>}
    </Fieldset>
  );
}

/** «● Запись 00:01:23 · микрофон ▮▮▮…»: clock and levels tick from meetingLive twice a second. */
function RecLine({ m }: { m: MeetingStateDto }) {
  const L = useL();
  const live = useStore(meetingLive);
  return (
    <p className="rec">
      <span className="dot">● </span>
      <span>{L('Запись ', 'Recording ')}</span>
      <span data-m="clock">{clockText((live.now - m.startedAt) / 1000)}</span>
      <span className="muted">{L(' · микрофон ', ' · mic ')}</span>
      <span className="lv" data-m="mic">
        {bars(live.levels[0])}
      </span>
      {m.capturing === 'mic+system' && (
        <>
          <span className="muted">{L(' · компьютер ', ' · computer ')}</span>
          <span className="lv" data-m="sys">
            {bars(live.levels[1])}
          </span>
        </>
      )}
    </p>
  );
}
