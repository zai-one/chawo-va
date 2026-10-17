import { beforeEach, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { clampSpeed, errorState, loadingState, playerPosition, readyState, SPEEDS, titleOf } from '../src/tts/playerModel';

describe('TTS player model', () => {
  beforeEach(() => applyLanguage('Russian'));

  it('opens below-right of the pointer and stays on the screen', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(playerPosition(area, { x: 100, y: 100 }, 360, 130)).toEqual({ x: 116, y: 116 });
    expect(playerPosition(area, { x: 1900, y: 1000 }, 360, 130)).toEqual({ x: 1524, y: 854 });
    const second = { x: 1920, y: 0, width: 1280, height: 1000 };
    expect(playerPosition(second, { x: 1925, y: 5 }, 360, 130)).toEqual({ x: 1941, y: 21 });
  });

  it('speed stays within 0.5–2; the title is the start of the text', () => {
    expect(clampSpeed(3)).toBe(2);
    expect(clampSpeed('x')).toBe(1);
    expect(clampSpeed(1.333)).toBe(1.33);
    expect(titleOf('  один\n два  ')).toBe('один два');
    expect(titleOf('а'.repeat(100))).toHaveLength(80);
    expect(loadingState('Текст', 1.5)).toMatchObject({ phase: 'loading', title: 'Текст', rate: 1.5, speeds: [...SPEEDS] });
    expect(readyState('Текст', 1).message).toBe('');
    expect(errorState('', 'нет ключа', 9)).toMatchObject({ phase: 'error', message: 'нет ключа', rate: 2 });
  });
});
