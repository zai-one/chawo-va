import { beforeEach, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { defaults, type SettingsData } from '../src/settings';
import { pcmToWav } from '../src/tts/ttsClient';
import { addressFor, ttsKeyChoices, voiceTarget, VoiceController } from '../src/tts/voicePage';
import { Gemini, OmniRoute, Xiaomi } from '../src/tts/ttsProviders';
import type { Speech } from '../src/tts/ttsClient';

function setup(edit: (s: SettingsData) => void = () => undefined) {
  const s = defaults();
  edit(s);
  let saves = 0;
  const timers: (() => void)[] = [];
  const played: { speech: Speech; text: string }[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return Response.json({ choices: [{ message: { audio: { data: Buffer.from(pcmToWav(new Uint8Array(4), 24000)).toString('base64') } } }] });
  }) as unknown as typeof fetch;
  const ctl = new VoiceController({
    settings: () => s,
    save: () => saves++,
    fetch: fetchImpl,
    platform: 'win32',
    play: (speech, text) => played.push({ speech, text }),
    timer: { set: (fn) => timers.push(fn) - 1, clear: (h) => (timers[h as number] = () => undefined) },
  });
  return { s, ctl, saves: () => saves, timers, played, calls };
}

describe('«Голос» page', () => {
  beforeEach(() => applyLanguage('Russian'));

  it('starts off; picking a service fills its address, model and voice', () => {
    const { s, ctl } = setup();
    expect(ctl.state().providerId).toBe('');
    expect(ctl.state().ready).toBe(false);
    ctl.setProvider('xiaomi');
    expect(s.TtsProvider).toBe('xiaomi');
    expect(s.TtsEndpointUrl).toBe(Xiaomi.baseUrl);
    expect(s.TtsModel).toBe('mimo-v2.5-tts');
    expect(s.TtsVoice).toBe('mimo_default');
    const st = ctl.state();
    expect(st.url.visible).toBe(true);
    expect(st.note).toMatch(/русский не заявлен/);
    expect(st.key.saved).toBe(false);
    ctl.setProvider('gemini');
    expect(s.TtsEndpointUrl).toBe('');
    expect(ctl.state().url.visible).toBe(false);
    expect(ctl.state().url.value).toBe(Gemini.baseUrl);
  });

  it('shares the key with the Brain by service; the key text never goes to the page', () => {
    const { s, ctl, timers } = setup((x) => (x.ProviderKeys.xiaomi = 'tp-brain'));
    ctl.setProvider('xiaomi');
    expect(ctl.state().key.saved).toBe(true);
    expect(JSON.stringify(ctl.state())).not.toContain('tp-brain');
    expect(ctl.state().ready).toBe(true);
    ctl.setProvider('gemini');
    expect(ctl.state().ready).toBe(false);
    ctl.setKey('AIza-new');
    expect(s.ProviderKeys.gemini).toBeUndefined();
    timers.at(-1)!();
    expect(s.ProviderKeys.gemini).toBe('AIza-new');
    expect(voiceTarget(s)).toMatchObject({ key: 'AIza-new', model: Gemini.models[0], voice: 'Kore' });
  });

  it('a key typed and the service switched at once is saved for the service it was typed for', () => {
    const { s, ctl } = setup();
    ctl.setProvider('openai');
    ctl.setKey('sk-typed');
    ctl.setProvider('gemini');
    expect(s.ProviderKeys.openai).toBe('sk-typed');
    expect(s.ProviderKeys.gemini).toBeUndefined();
  });

  it('Xiaomi takes the cluster of the Brain key; a local gateway needs no key', () => {
    const s = defaults();
    s.CleanupEndpointUrl = 'https://token-plan-ams.xiaomimimo.com/v1/chat/completions';
    expect(addressFor(Xiaomi, s)).toBe('https://token-plan-ams.xiaomimimo.com/v1');
    s.CleanupEndpointUrl = 'http://evil.example/xiaomimimo.com';
    expect(addressFor(Xiaomi, s)).toBe(Xiaomi.baseUrl);
    const { s: s2, ctl } = setup();
    ctl.setProvider('omniroute');
    expect(s2.TtsEndpointUrl).toBe(OmniRoute.baseUrl);
    expect(ctl.state().ready).toBe(true);
    expect(ctl.state().note).not.toMatch(/уходит на/);
    ctl.setUrl('http://203.0.113.5:20128/v1');
    expect(ctl.state().warning).toMatch(/https/);
    expect(ctl.state().note).toMatch(/уходит на 203\.0\.113\.5:20128/);
  });

  it('model, voice, speed, button and key are saved; the dictation key and combos are not offered', () => {
    const { s, ctl } = setup();
    ctl.setProvider('openai');
    ctl.setModel('tts-1-hd');
    ctl.setVoice('my-voice');
    ctl.setSpeed(9);
    ctl.setSelectionButton(false);
    expect(s).toMatchObject({ TtsModel: 'tts-1-hd', TtsVoice: 'my-voice', TtsSpeed: 2, TtsSelectionButton: false });
    expect(ctl.state().voices[0]).toBe('my-voice');
    expect(ttsKeyChoices(0xa3).map((c) => c.vk)).not.toContain(0xa3);
    expect(ttsKeyChoices(0xa3).map((c) => c.vk)).not.toContain(0x10000);
    ctl.setHotkey(0xa3);
    expect(s.TtsHotkeyVk).toBe(0);
    ctl.setHotkey(0x91);
    expect(s.TtsHotkeyVk).toBe(0x91);
    expect(ctl.state().hotkey.vk).toBe(0x91);
  });

  it('the selection button and the key are Windows only', () => {
    const s = defaults();
    const ctl = new VoiceController({ settings: () => s, save: () => undefined, platform: 'linux' });
    expect(ctl.state().selection.visible).toBe(false);
    expect(ctl.state().hotkey.visible).toBe(false);
  });

  it('«Проверить» reads a sentence and hands the sound to the player; errors are in words', async () => {
    const { ctl, played, calls } = setup((x) => (x.ProviderKeys.xiaomi = 'tp-1'));
    await ctl.test();
    expect(ctl.state().test).toMatchObject({ failed: true, running: false });
    expect(ctl.state().test.status).toMatch(/выберите сервис/);
    ctl.setProvider('xiaomi');
    await ctl.test();
    expect(calls).toEqual(['https://token-plan-sgp.xiaomimimo.com/v1/chat/completions']);
    expect(played).toHaveLength(1);
    expect(played[0].speech.mime).toBe('audio/wav');
    expect(ctl.state().test).toMatchObject({ failed: false, status: 'Работает, звук пришёл.' });
  });
});
