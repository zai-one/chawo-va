import { beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { HINT_MS, OverlayModel, overlayPosition, tail, type OverlayState } from '../src/overlay/overlayModel';

beforeAll(() => applyLanguage('Russian'));

function make() {
  const timers: { fn: () => void; ms: number }[] = [];
  const states: OverlayState[] = [];
  const m = new OverlayModel((s) => states.push(s), { setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  return { m, timers, states, fire: () => timers.splice(0).forEach((t) => t.fn()) };
}

describe('OverlayModel (OverlayWindow state)', () => {
  it('listening shows the bars with «Слушаю…», recognizing keeps the line, hide clears it', () => {
    const { m, states } = make();
    m.showListening();
    expect(m.state).toEqual({ visible: true, mode: 'listening', label: '', caption: '', live: 'Слушаю…' });
    m.showPartial('привет');
    m.showRecognizing();
    expect(m.state).toMatchObject({ visible: true, mode: 'recognizing', live: 'привет' });
    m.hideNow();
    expect(m.state).toMatchObject({ visible: false, live: '' });
    expect(states.length).toBe(4);
  });

  it('a draft is ignored while hidden or showing text, and an empty draft keeps the previous line', () => {
    const { m } = make();
    m.showPartial('x');
    expect(m.state.live).toBe('');
    m.showListening();
    m.showPartial('раз');
    m.showPartial('   ');
    expect(m.state.live).toBe('раз');
    m.showStatus('Причёсываю…');
    m.showPartial('два');
    expect(m.state).toMatchObject({ mode: 'text', label: 'Причёсываю…', live: '' });
  });

  it('tail keeps the last 280 characters with an ellipsis', () => {
    expect(tail('  коротко ')).toBe('коротко');
    const long = 'а'.repeat(100) + 'б'.repeat(300);
    const t = tail(long);
    expect(t.length).toBe(280);
    expect(t.startsWith('…б')).toBe(true);
  });

  it('a hint hides by itself after 2.2 s unless a newer state came', () => {
    const { m, timers, fire } = make();
    m.showHint('Тишина на входе');
    expect(m.state).toMatchObject({ visible: true, mode: 'text', label: 'Тишина на входе' });
    expect(timers[0].ms).toBe(HINT_MS);
    fire();
    expect(m.state.visible).toBe(false);

    m.showHint('первый');
    m.showListening(); // a new take started meanwhile
    fire();
    expect(m.state).toMatchObject({ visible: true, mode: 'listening' });

    m.showHint('старый');
    m.showStatus('Запускаю нейронку…'); // a status stays until the next state
    fire();
    expect(m.state).toMatchObject({ visible: true, label: 'Запускаю нейронку…' });
  });

  it('a caption shows only while listening and goes away by itself', () => {
    const { m, fire } = make();
    m.showCaption('Выделено 5 знаков');
    expect(m.state.caption).toBe('');
    m.showListening();
    m.showCaption('Выделено 5 знаков');
    expect(m.state.caption).toBe('Выделено 5 знаков');
    fire();
    expect(m.state.caption).toBe('');
  });
});

describe('overlayPosition (OverlayWindow.Place without the caret)', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  it('bottom centre of the work area, 40 px above its bottom edge', () => {
    expect(overlayPosition(area, 120, 58, null)).toEqual({ x: 900, y: 1040 - 58 - 40 });
  });
  it('a pinned top-left is kept, but clamped onto the screen', () => {
    expect(overlayPosition(area, 120, 58, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(overlayPosition(area, 120, 58, { x: 1900, y: -50 })).toEqual({ x: 1800, y: 0 });
    expect(overlayPosition({ x: 1920, y: 0, width: 1280, height: 1000 }, 200, 80, { x: 5000, y: 990 })).toEqual({ x: 3000, y: 920 });
  });
});
