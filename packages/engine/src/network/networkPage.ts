// «Сеть» page state and actions: role Host/Client, the Hermes listener (127.0.0.1 or the whole LAN),
// keep-awake while listening, the remote host address and «Проверить хост». No Electron imports:
// the server, the firewall step, the yes/no box and the health check come in as hooks, so tests run
// with a fake server. Port of SettingsWindow Network page + App.RestartHermes / ApplyKeepAwake /
// HermesStatusText / LanUrls / ToggleLanAsync.
//
// Unlike WPF (which starts Hermes for both roles), Hermes runs only while this PC is the host: a
// client has no model to serve.

import { networkInterfaces } from 'node:os';
import { HERMES_PORT } from '@chawo/core/speechModels';
import { isRussian, t } from '@chawo/core/strings';
import * as Log from '../log';
import type { NetworkRole, SettingsData } from '../settings';
import type { FirewallResult } from './hermesFirewall';
import type { HermesTranscribe } from './hermesServer';

export interface HermesLike {
  readonly listenOnLan: boolean;
  readonly port: number;
  start(): Promise<void>;
  dispose(): Promise<void> | void;
}

export interface NetworkHooks {
  settings: () => SettingsData;
  save: (s: SettingsData) => void;
  push?: () => void;
  /** Role changed: the dictation session drops/reopens its recognizer, other pages refresh. */
  changed?: () => void;
  createServer: (port: number, transcribe: HermesTranscribe, lan: boolean) => HermesLike;
  transcribe: HermesTranscribe;
  /** RemoteSpeech.check */
  check: (s: SettingsData) => Promise<string>;
  firewall?: { tryOpenPort: (port: number) => Promise<FirewallResult>; openConsole: () => void };
  /** Yes/No box; resolves true on Yes. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  /** OK box for the firewall failure. */
  alert?: (title: string, message: string) => Promise<void>;
  keepAwake?: { prevent: () => void; allow: () => void };
  lanUrls?: (port: number) => string;
  platform?: NodeJS.Platform;
  port?: number;
}

export interface NetworkStateDto {
  ru: boolean;
  heading: string;
  intro: string;
  roleLabel: string;
  role: NetworkRole;
  roleChoices: { value: NetworkRole; label: string }[];
  client: boolean;
  host: {
    note: string;
    heading: string;
    status: string;
    lanOn: boolean;
    lanButton: string;
    lanBusy: boolean;
    firewallNote: string;
    keepAwake: boolean;
    keepAwakeLabel: string;
    keepAwakeHint: string;
  };
  remote: {
    note: string;
    hostLabel: string;
    portLabel: string;
    host: string;
    port: number;
    checkLabel: string;
    checking: boolean;
    checkStatus: string;
  };
}

/** Every IPv4 address of this PC that is not loopback, as Hermes URLs (App.LanUrls). */
export function lanUrls(port: number): string {
  try {
    const ips: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if ((a.family === 'IPv4' || (a.family as unknown) === 4) && !a.internal && !a.address.startsWith('127.')) ips.push(a.address);
      }
    }
    if (ips.length > 0) return ips.map((ip) => `http://${ip}:${port}/v1/transcribe`).join(', ');
  } catch {
    /* fall through */
  }
  return `http://<адрес-этого-ПК>:${port}/v1/transcribe`;
}

export function parsePort(text: string | number): number {
  const n = typeof text === 'number' ? text : /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : HERMES_PORT;
}

export class NetworkController {
  private readonly h: NetworkHooks & Required<Pick<NetworkHooks, 'platform' | 'port' | 'lanUrls'>>;
  private hermes: HermesLike | null = null;
  private op: Promise<void> = Promise.resolve();
  private lanBusy = false;
  private checking = false;
  private checkStatus = '';
  private disposed = false;

  constructor(hooks: NetworkHooks) {
    this.h = { platform: process.platform, port: HERMES_PORT, lanUrls, ...hooks };
  }

  private get win(): boolean {
    return this.h.platform === 'win32';
  }

  private push(): void {
    this.h.push?.();
  }

  /** The running listener (tests, status). */
  get server(): HermesLike | null {
    return this.hermes;
  }

  /** Serializes start/stop/restart so a quick toggle cannot leave two listeners. */
  private queue(fn: () => Promise<void>): Promise<void> {
    const next = this.op.then(fn, fn);
    this.op = next.catch(() => undefined);
    return next;
  }

  /** App start: listen when this PC is the host (StartHermes). */
  start(): Promise<void> {
    return this.queue(async () => {
      const s = this.h.settings();
      if (s.NetworkRole === 'Host') await this.restartCore(s.HermesOnLan);
      else await this.stopCore();
    });
  }

  private async stopCore(): Promise<void> {
    const old = this.hermes;
    this.hermes = null;
    if (old) {
      try {
        await old.dispose();
      } catch (e) {
        Log.write(`hermes stop: ${e instanceof Error ? e.message : String(e)}`);
      }
      Log.write('hermes stopped');
    }
    this.applyKeepAwake();
    this.push();
  }

  private async restartCore(lan: boolean): Promise<void> {
    if (this.disposed) return;
    await this.stopCore();
    try {
      const server = this.h.createServer(this.h.port, this.h.transcribe, lan);
      await server.start();
      this.hermes = server;
    } catch (e) {
      Log.write(`hermes failed: ${e instanceof Error ? e.message : String(e)}`);
      this.hermes = null;
      if (lan) {
        try {
          const server = this.h.createServer(this.h.port, this.h.transcribe, false);
          await server.start();
          this.hermes = server;
          const s = this.h.settings();
          s.HermesOnLan = false;
          this.h.save(s);
        } catch (again) {
          Log.write(`hermes localhost failed: ${again instanceof Error ? again.message : String(again)}`);
        }
      }
    }
    this.applyKeepAwake();
    this.push();
  }

  /** RestartHermes(lan). */
  restart(lan: boolean): Promise<void> {
    return this.queue(() => this.restartCore(lan));
  }

  stop(): Promise<void> {
    return this.queue(() => this.stopCore());
  }

  private applyKeepAwake(): void {
    const k = this.h.keepAwake;
    if (!k) return;
    if (this.h.settings().KeepAwakeWhileListening && this.hermes !== null) k.prevent();
    else k.allow();
  }

  hermesStatusText(): string {
    const port = this.hermes?.port ?? this.h.port;
    if (this.h.settings().NetworkRole === 'Client' && !this.hermes) {
      return t('Этот ПК — клиент: приём звука от других компьютеров выключен.', 'This PC is a client: audio from other computers is off.');
    }
    if (!this.hermes) return t('Расшифровщик не запущен.', 'The decoder is not running.');
    if (!this.hermes.listenOnLan) {
      return t(`Слушаю только этот компьютер: http://127.0.0.1:${port}/v1/transcribe. Другие машины сюда не попадут, пока вы не откроете порт.`,
        `Listening on this PC only: http://127.0.0.1:${port}/v1/transcribe. Other machines cannot reach it until you open the port.`);
    }
    const urls = this.h.lanUrls(port);
    return t(`Слушаю всю локальную сеть, порт ${port} (адрес 0.0.0.0). С других компьютеров: ${urls}. Звук приходит сюда и здесь же расшифровывается, в интернет он не уходит. Любой в этой сети может прислать запись.`,
      `Listening on the local network, port ${port} (0.0.0.0). From another computer: ${urls}. Audio is transcribed here and is not uploaded. Anyone on this network can send a recording.`);
  }

  state(): NetworkStateDto {
    const s = this.h.settings();
    const port = this.h.port;
    const client = s.NetworkRole === 'Client';
    const lanOn = this.hermes?.listenOnLan ?? s.HermesOnLan;
    return {
      ru: isRussian(),
      heading: t('Сеть', 'Network'),
      intro: t('Хост распознаёт на этом компьютере и принимает подключения. Клиент отправляет звук на другой компьютер и модель не скачивает.',
        'The host recognizes on this PC and accepts connections. A client sends audio to another PC and does not download a model.'),
      roleLabel: t('Роль', 'Role'),
      role: s.NetworkRole,
      roleChoices: [
        { value: 'Host', label: t('Хост: этот компьютер распознаёт сам и принимает подключения', 'Host: this PC recognizes on its own and accepts connections') },
        { value: 'Client', label: t('Клиент: звук уходит на другой компьютер', 'Client: audio goes to another PC') },
      ],
      client,
      host: {
        note: t(`Этот компьютер распознаёт сам и принимает подключения. Диктовка здесь не выключается. Порт ${port}. Пока кнопку ниже не нажать, подключения только с этого компьютера (127.0.0.1). После кнопки — со всех адресов (0.0.0.0), тот же порт.`,
          `This PC recognizes on its own and accepts connections. Dictation stays on. Port ${port}. Until you press the button below, connections are from this PC only (127.0.0.1). After the button, every address (0.0.0.0), same port.`),
        heading: t('Приём звука от других компьютеров', 'Audio from other computers'),
        status: this.hermesStatusText(),
        lanOn,
        lanButton: lanOn
          ? t('Снова слушать только этот компьютер', 'Listen on this PC only again')
          : this.win
            ? t('Открыть порт в брандмауэре и слушать сеть', 'Open the firewall port and listen on the network')
            : t('Слушать всю локальную сеть', 'Listen on the whole local network'),
        lanBusy: this.lanBusy,
        firewallNote: this.win
          ? ''
          : t(`Брандмауэр системы программа не трогает. Если он включён (ufw, firewalld, macOS), разрешите входящий TCP ${port} сами.`,
            `The app does not touch the system firewall. If one is on (ufw, firewalld, macOS), allow inbound TCP ${port} yourself.`),
        keepAwake: s.KeepAwakeWhileListening,
        keepAwakeLabel: t('Не давать компьютеру засыпать, пока он слушает', 'Keep this PC awake while it listens'),
        keepAwakeHint: t('Только пока программа открыта и слушает. Выключить компьютер или усыпить его вручную можно как обычно. После перезапуска программы галочка снимается.',
          'Only while the app is open and listening. You can still shut down or sleep the PC by hand. The box is cleared when the app restarts.'),
      },
      remote: {
        note: t('Звук уходит на другой компьютер: http://адрес:порт/v1/transcribe. Местная речевая модель не запускается и не скачивается. Если хост молчит, будет короткая ошибка.',
          'Audio goes to another PC: http://address:port/v1/transcribe. The local speech model is not started and is not downloaded. If the host is down, you get a short error.'),
        hostLabel: t('Адрес хоста', 'Host address'),
        portLabel: t('Порт', 'Port'),
        host: s.RemoteHost,
        port: parsePort(s.RemotePort),
        checkLabel: t('Проверить хост', 'Check the host'),
        checking: this.checking,
        checkStatus: this.checking
          ? t('Проверяю хост…', 'Checking the host…')
          : this.checkStatus || t('Проверка только спрашивает /v1/health. Модель не скачивается.', 'The check only asks /v1/health. No model is downloaded.'),
      },
    };
  }

  /** Role_Changed: save, tell the other pages, start or stop the listener. */
  async setRole(role: NetworkRole): Promise<void> {
    const s = this.h.settings();
    if ((role !== 'Host' && role !== 'Client') || role === s.NetworkRole) return;
    s.NetworkRole = role;
    this.h.save(s);
    Log.write(`network role ${role}`);
    this.checkStatus = '';
    this.h.changed?.();
    this.push();
    await this.start();
  }

  /** Remote_LostFocus: a bad port falls back to 17831; saved only when something changed. */
  setRemote(host: string, port: string | number): void {
    const s = this.h.settings();
    const h = String(host ?? '').trim();
    const p = parsePort(port);
    if (h === s.RemoteHost && p === s.RemotePort) {
      this.push();
      return;
    }
    s.RemoteHost = h;
    s.RemotePort = p;
    this.h.save(s);
    this.checkStatus = '';
    this.h.changed?.();
    this.push();
  }

  /** «Проверить хост»: only GET /v1/health. */
  async checkHost(): Promise<string> {
    if (this.checking) return this.checkStatus;
    this.checking = true;
    this.push();
    try {
      this.checkStatus = await this.h.check(this.h.settings());
    } catch (e) {
      this.checkStatus = e instanceof Error ? e.message : String(e);
    } finally {
      this.checking = false;
      this.push();
    }
    return this.checkStatus;
  }

  /** The checkbox. Kept for this run only (settings.json always stores false, like WPF). */
  setKeepAwake(on: boolean): void {
    const s = this.h.settings();
    if (s.KeepAwakeWhileListening === on) return;
    s.KeepAwakeWhileListening = on;
    this.applyKeepAwake();
    this.push();
  }

  /** ToggleLanAsync: LAN on asks first (and on Windows adds the firewall rule); LAN off just rebinds. */
  async toggleLan(): Promise<void> {
    if (this.lanBusy) return;
    const s = this.h.settings();
    if (s.NetworkRole !== 'Host') return;
    this.lanBusy = true;
    this.push();
    try {
      if (this.hermes?.listenOnLan === true) {
        s.HermesOnLan = false;
        this.h.save(s);
        await this.restart(false);
        return;
      }
      const port = this.h.port;
      const message = this.win
        ? t(`Порт ${port} откроется в брандмауэре Windows (система спросит разрешение администратора), и Chawo Voice Assistant начнёт принимать записи со всех компьютеров в локальной сети. Адрес 0.0.0.0. В интернет звук не отправляется, но любой в этой сети сможет прислать файл на расшифровку. Продолжить?`,
          `Port ${port} will be opened in Windows Firewall (Windows will ask for administrator permission) and Chawo Voice Assistant will accept recordings from every computer on the local network, on 0.0.0.0. Audio is not uploaded, but anyone on this network can send a file to transcribe. Continue?`)
        : t(`Chawo Voice Assistant начнёт принимать записи со всех компьютеров в локальной сети: порт ${port}, адрес 0.0.0.0. Брандмауэр системы программа не трогает: если он включён, разрешите входящий TCP ${port} сами. В интернет звук не отправляется, но любой в этой сети сможет прислать файл на расшифровку. Продолжить?`,
          `Chawo Voice Assistant will accept recordings from every computer on the local network: port ${port}, address 0.0.0.0. The app does not touch the system firewall: if one is on, allow inbound TCP ${port} yourself. Audio is not uploaded, but anyone on this network can send a file to transcribe. Continue?`);
      const yes = this.h.confirm ? await this.h.confirm(t('Слушать сеть', 'Listen on the network'), message) : false;
      if (!yes) return;
      if (this.win && this.h.firewall) {
        const r = await this.h.firewall.tryOpenPort(port);
        if (!r.ok) {
          Log.write(`firewall rule failed: ${r.error}`);
          this.h.firewall.openConsole();
          await this.h.alert?.(t('Брандмауэр', 'Firewall'),
            t(`Правило брандмауэра не добавилось (${r.error}). Открыл консоль брандмауэра: разрешите входящий TCP ${port}. Слушать сеть всё равно пробую.`,
              `The firewall rule was not added (${r.error}). The firewall console is open: allow inbound TCP ${port}. Trying to listen on the network anyway.`));
        } else this.h.firewall.openConsole();
      }
      s.HermesOnLan = true;
      this.h.save(s);
      await this.restart(true);
    } finally {
      this.lanBusy = false;
      this.push();
    }
  }

  /** Quit: close the listener and let the PC sleep again. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue(() => this.stopCore());
    this.h.keepAwake?.allow();
  }
}
