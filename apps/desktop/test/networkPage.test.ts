import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import * as Settings from '@chawo/engine/settings';
import { NetworkController, lanUrls, parsePort, type HermesLike, type NetworkHooks } from '@chawo/engine/network/networkPage';
import { HermesServer } from '@chawo/engine/network/hermesServer';
import * as KeepAwake from '../src/main/network/keepAwake';
import { tryOpenPort, firewallScript, openConsole } from '@chawo/engine/network/hermesFirewall';

beforeAll(() => applyLanguage('Russian'));
afterAll(() => applyLanguage('Russian'));

class FakeServer implements HermesLike {
  started = false;
  disposed = false;
  constructor(readonly port: number, readonly listenOnLan: boolean, private readonly fail: boolean) {}
  async start() {
    if (this.fail) throw new Error('EACCES');
    this.started = true;
  }
  dispose() {
    this.disposed = true;
  }
}

function make(over: Partial<NetworkHooks> = {}, edit?: (s: Settings.SettingsData) => void, failLan = false) {
  const s = Settings.defaults();
  edit?.(s);
  const servers: FakeServer[] = [];
  let saves = 0;
  let changed = 0;
  const awake: string[] = [];
  const confirms: string[] = [];
  const ctl = new NetworkController({
    settings: () => s,
    save: () => void saves++,
    changed: () => void changed++,
    createServer: (port, _tr, lan) => {
      const f = new FakeServer(port, lan, failLan && lan);
      servers.push(f);
      return f;
    },
    transcribe: () => ({ modelLoaded: false, text: null, model: '', device: '', provider: '', seconds: 0, error: null }),
    check: async (x) => `checked ${x.RemoteHost}:${x.RemotePort}`,
    keepAwake: { prevent: () => void awake.push('prevent'), allow: () => void awake.push('allow') },
    confirm: async (_t, m) => {
      confirms.push(m);
      return true;
    },
    lanUrls: (p) => `http://192.168.1.9:${p}/v1/transcribe`,
    platform: 'linux',
    ...over,
  });
  return { s, ctl, servers, awake, confirms, saves: () => saves, changed: () => changed };
}

describe('NetworkController («Сеть»)', () => {
  it('Host: start() listens on 127.0.0.1; status text and labels as in WPF', async () => {
    const { ctl, servers } = make();
    await ctl.start();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ port: 17831, listenOnLan: false, started: true });
    const st = ctl.state();
    expect(st.client).toBe(false);
    expect(st.role).toBe('Host');
    expect(st.heading).toBe('Сеть');
    expect(st.roleChoices.map((c) => c.value)).toEqual(['Host', 'Client']);
    expect(st.host.status).toBe('Слушаю только этот компьютер: http://127.0.0.1:17831/v1/transcribe. Другие машины сюда не попадут, пока вы не откроете порт.');
    expect(st.host.lanButton).toBe('Слушать всю локальную сеть');
    expect(st.host.firewallNote).toMatch(/^Брандмауэр системы программа не трогает/);
    expect(st.remote.checkStatus).toBe('Проверка только спрашивает /v1/health. Модель не скачивается.');
  });

  it('switching to Client stops Hermes and tells the other pages; back to Host starts it again', async () => {
    const { s, ctl, servers, saves, changed } = make();
    await ctl.start();
    await ctl.setRole('Client');
    expect(s.NetworkRole).toBe('Client');
    expect(saves()).toBe(1);
    expect(changed()).toBe(1);
    expect(servers[0].disposed).toBe(true);
    expect(ctl.server).toBeNull();
    expect(ctl.state().client).toBe(true);
    await ctl.setRole('Client'); // no-op
    expect(saves()).toBe(1);
    await ctl.setRole('Host');
    expect(servers).toHaveLength(2);
    expect(ctl.server).toBe(servers[1]);
  });

  it('Client at app start: nothing listens', async () => {
    const { ctl, servers } = make({}, (x) => { x.NetworkRole = 'Client'; });
    await ctl.start();
    expect(servers).toHaveLength(0);
  });

  it('remote host/port: trimmed, bad port → 17831, saved only on change', () => {
    const { s, ctl, saves } = make({}, (x) => { x.NetworkRole = 'Client'; });
    ctl.setRemote('  192.168.1.20 ', 'abc');
    expect(s.RemoteHost).toBe('192.168.1.20');
    expect(s.RemotePort).toBe(17831);
    expect(saves()).toBe(1);
    ctl.setRemote('192.168.1.20', '17831');
    expect(saves()).toBe(1);
    ctl.setRemote('192.168.1.20', '9000');
    expect(s.RemotePort).toBe(9000);
    expect(ctl.state().remote).toMatchObject({ host: '192.168.1.20', port: 9000 });
    expect(parsePort('70000')).toBe(17831);
    expect(parsePort(' 80 ')).toBe(80);
  });

  it('checkHost shows «Проверяю хост…» while it runs, then the answer', async () => {
    let release!: (v: string) => void;
    const { ctl } = make({ check: () => new Promise<string>((r) => (release = r)) }, (x) => { x.NetworkRole = 'Client'; x.RemoteHost = 'h'; });
    const p = ctl.checkHost();
    expect(ctl.state().remote).toMatchObject({ checking: true, checkStatus: 'Проверяю хост…' });
    release('Хост отвечает, модель загружена.');
    await p;
    expect(ctl.state().remote).toMatchObject({ checking: false, checkStatus: 'Хост отвечает, модель загружена.' });
  });

  it('toggleLan on Linux: asks, no firewall step, rebinds 0.0.0.0 and saves; off goes back to 127.0.0.1', async () => {
    let fw = 0;
    const { s, ctl, servers, confirms } = make({
      firewall: { tryOpenPort: async () => { fw++; return { ok: true, error: '', attempted: true }; }, openConsole: () => void fw++ },
    });
    await ctl.start();
    await ctl.toggleLan();
    expect(confirms[0]).toMatch(/^Chawo Voice Assistant начнёт принимать записи со всех компьютеров в локальной сети: порт 17831, адрес 0\.0\.0\.0\. Брандмауэр системы программа не трогает/);
    expect(fw).toBe(0);
    expect(s.HermesOnLan).toBe(true);
    expect(servers.at(-1)).toMatchObject({ listenOnLan: true, started: true });
    expect(servers[0].disposed).toBe(true);
    const st = ctl.state();
    expect(st.host.lanButton).toBe('Снова слушать только этот компьютер');
    expect(st.host.status).toBe('Слушаю всю локальную сеть, порт 17831 (адрес 0.0.0.0). С других компьютеров: http://192.168.1.9:17831/v1/transcribe. Звук приходит сюда и здесь же расшифровывается, в интернет он не уходит. Любой в этой сети может прислать запись.');
    await ctl.toggleLan();
    expect(s.HermesOnLan).toBe(false);
    expect(servers.at(-1)).toMatchObject({ listenOnLan: false, started: true });
    expect(confirms).toHaveLength(1);
  });

  it('toggleLan: «Нет» keeps the listener as it was', async () => {
    const { s, ctl, servers } = make({ confirm: async () => false });
    await ctl.start();
    await ctl.toggleLan();
    expect(s.HermesOnLan).toBe(false);
    expect(servers).toHaveLength(1);
    expect(ctl.state().host.lanBusy).toBe(false);
  });

  it('toggleLan on Windows: firewall rule first; a failure opens the console, says so, still listens', async () => {
    const steps: string[] = [];
    const alerts: string[] = [];
    const { s, ctl, servers, confirms } = make({
      platform: 'win32',
      firewall: {
        tryOpenPort: async (p) => { steps.push(`open ${p}`); return { ok: false, error: 'netsh exit 1', attempted: true }; },
        openConsole: () => void steps.push('console'),
      },
      alert: async (_t, m) => void alerts.push(m),
    });
    await ctl.start();
    expect(ctl.state().host.lanButton).toBe('Открыть порт в брандмауэре и слушать сеть');
    expect(ctl.state().host.firewallNote).toBe('');
    await ctl.toggleLan();
    expect(confirms[0]).toMatch(/^Порт 17831 откроется в брандмауэре Windows/);
    expect(steps).toEqual(['open 17831', 'console']);
    expect(alerts[0]).toBe('Правило брандмауэра не добавилось (netsh exit 1). Открыл консоль брандмауэра: разрешите входящий TCP 17831. Слушать сеть всё равно пробую.');
    expect(s.HermesOnLan).toBe(true);
    expect(servers.at(-1)!.listenOnLan).toBe(true);
  });

  it('LAN bind fails → falls back to 127.0.0.1 and clears HermesOnLan (RestartHermes)', async () => {
    const { s, ctl, servers } = make({}, (x) => { x.HermesOnLan = true; }, true);
    await ctl.start();
    expect(servers.map((x) => x.listenOnLan)).toEqual([true, false]);
    expect(ctl.server).toBe(servers[1]);
    expect(s.HermesOnLan).toBe(false);
  });

  it('keep awake: only while listening and the box is on; dispose lets the PC sleep', async () => {
    const { ctl, awake } = make();
    await ctl.start();
    expect(awake.at(-1)).toBe('allow');
    ctl.setKeepAwake(true);
    expect(awake.at(-1)).toBe('prevent');
    expect(ctl.state().host.keepAwake).toBe(true);
    await ctl.setRole('Client');
    expect(awake.at(-1)).toBe('allow');
    await ctl.setRole('Host');
    expect(awake.at(-1)).toBe('prevent');
    await ctl.dispose();
    expect(awake.at(-1)).toBe('allow');
    expect(ctl.server).toBeNull();
  });

  it('works with the real HermesServer on a free port', async () => {
    const { ctl } = make({ createServer: (_p, tr, lan) => new HermesServer(0, tr, lan) });
    await ctl.start();
    const port = ctl.server!.port;
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(await r.json()).toMatchObject({ ok: true, model_loaded: false, listen: '127.0.0.1' });
    await ctl.dispose();
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  });

  it('lanUrls lists IPv4 addresses or the placeholder', () => {
    expect(lanUrls(17831)).toMatch(/^http:\/\/.+:17831\/v1\/transcribe/);
  });
});

describe('HermesFirewall / KeepAwake', () => {
  it('not Windows: nothing is run, ok', async () => {
    let spawned = 0;
    const spawn = (() => { spawned++; throw new Error('no'); }) as never;
    expect(await tryOpenPort(17831, { platform: 'linux', spawn })).toEqual({ ok: true, error: '', attempted: false });
    openConsole({ platform: 'linux', spawn });
    expect(spawned).toBe(0);
  });

  it('the netsh script matches WPF', () => {
    const bat = firewallScript(17831);
    expect(bat).toContain('netsh advfirewall firewall delete rule name="Giga Pisar Hermes" >nul 2>&1\r\n');
    expect(bat).toContain('netsh advfirewall firewall add rule name="Chawo Voice Assistant" dir=in action=allow protocol=TCP localport=17831\r\n');
    expect(bat.endsWith('exit /b %ERRORLEVEL%\r\n')).toBe(true);
  });

  it('Windows: one elevated powershell; exit code decides', async () => {
    const { EventEmitter } = await import('node:events');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'chawo-fw-'));
    const calls: { cmd: string; args: string[] }[] = [];
    const fake = (code: number) => ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), { kill: () => true, unref: () => undefined });
      setTimeout(() => child.emit('exit', code), 1);
      return child;
    }) as never;
    try {
      expect(await tryOpenPort(17831, { platform: 'win32', spawn: fake(0), tempDir: () => tmp })).toEqual({ ok: true, error: '', attempted: true });
      expect(calls[0].cmd).toBe('powershell.exe');
      expect(calls[0].args.at(-1)).toContain('-Verb RunAs -WindowStyle Hidden -Wait -PassThru');
      expect(await tryOpenPort(17831, { platform: 'win32', spawn: fake(1223), tempDir: () => tmp })).toEqual({ ok: false, error: 'netsh exit 1223', attempted: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('KeepAwake uses the injected blocker and is a no-op without one', () => {
    const started = new Set<number>();
    let next = 1;
    const types: string[] = [];
    KeepAwake.setBlocker({
      start: (t) => { types.push(t); started.add(next); return next++; },
      stop: (id) => void started.delete(id),
      isStarted: (id) => started.has(id),
    });
    KeepAwake.preventSleep();
    KeepAwake.preventSleep();
    expect(types).toEqual(['prevent-app-suspension']);
    expect(KeepAwake.isPreventing()).toBe(true);
    KeepAwake.allowSleep();
    expect(KeepAwake.isPreventing()).toBe(false);
    KeepAwake.setBlocker(null);
    KeepAwake.preventSleep();
    expect(KeepAwake.isPreventing()).toBe(false);
    KeepAwake.setBlocker(undefined);
    KeepAwake.preventSleep(); // outside Electron: require('electron') is a path string → no-op
    expect(KeepAwake.isPreventing()).toBe(false);
  });
});
