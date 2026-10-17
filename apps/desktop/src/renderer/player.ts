// The TTS player: play / pause, seek, time, speed, close. The audio arrives as bytes from main and plays
// from a Blob URL (this page cannot reach the network). Speed changes go back to main as the new default.
import type { PlayerApi, PlayerState } from '@chawo/ipc/contract';

(() => {
  const api = (window as unknown as { chawoPlayer: PlayerApi }).chawoPlayer;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const card = $('card');
  const audio = $<HTMLAudioElement>('audio');
  const play = $<HTMLButtonElement>('play');
  const playIcon = document.getElementById('playIcon') as unknown as SVGPathElement;
  const seek = $<HTMLInputElement>('seek');
  const time = $('time');
  const total = $('total');
  const rate = $<HTMLSelectElement>('rate');
  const message = $('message');
  const controls = $('controls');
  let url = '';
  let seeking = false;
  let labels: PlayerState['labels'] | null = null;

  const fillSpeeds = (speeds: number[]) => {
    if (rate.options.length === speeds.length) return;
    rate.replaceChildren();
    for (const v of speeds) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = `${String(v).replace('.', ',')}×`;
      rate.append(o);
    }
  };
  const clock = (sec: number) => {
    const s = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const showPlaying = () => {
    const on = !audio.paused && !audio.ended;
    playIcon.setAttribute('d', on ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
    if (labels) play.title = play.ariaLabel = on ? labels.pause : labels.play;
  };
  const showTime = () => {
    time.textContent = clock(audio.currentTime);
    total.textContent = clock(audio.duration);
    if (!seeking && audio.duration > 0) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  };
  const report = () => {
    const r = card.getBoundingClientRect();
    api.size(r.width + 28, r.height + 28);
  };

  play.addEventListener('click', () => {
    if (audio.ended) audio.currentTime = 0;
    if (audio.paused) void audio.play();
    else audio.pause();
  });
  seek.addEventListener('input', () => {
    seeking = true;
    if (audio.duration > 0) time.textContent = clock((Number(seek.value) / 1000) * audio.duration);
  });
  seek.addEventListener('change', () => {
    if (audio.duration > 0) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    seeking = false;
  });
  rate.addEventListener('change', () => {
    audio.playbackRate = Number(rate.value);
    api.rate(Number(rate.value));
  });
  for (const ev of ['play', 'pause', 'ended']) audio.addEventListener(ev, showPlaying);
  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata']) audio.addEventListener(ev, showTime);
  $('close').addEventListener('click', () => {
    audio.pause();
    api.close();
  });
  $('settings').addEventListener('click', () => api.settings());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      audio.pause();
      api.close();
    } else if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      play.click();
    }
  });

  api.onState((s) => {
    labels = s.labels;
    $('title').textContent = s.title;
    $('close').title = $('close').ariaLabel = s.labels.close;
    rate.title = rate.ariaLabel = s.labels.speed;
    $('settings').textContent = s.labels.settings;
    message.textContent = s.message;
    message.hidden = s.message === '';
    message.classList.toggle('error', s.phase === 'error');
    controls.hidden = s.phase !== 'ready';
    if (s.phase !== 'ready') {
      audio.pause();
      if (url) URL.revokeObjectURL(url);
      url = '';
      audio.removeAttribute('src');
    }
    fillSpeeds(s.speeds);
    const r = s.speeds.includes(s.rate) ? s.rate : 1;
    rate.value = String(r);
    showPlaying();
    requestAnimationFrame(report);
  });
  api.onAudio((bytes, mime) => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    audio.src = url;
    audio.playbackRate = Number(rate.value) || 1;
    audio.defaultPlaybackRate = audio.playbackRate;
    seek.value = '0';
    void audio.play().catch(() => showPlaying());
  });
  new ResizeObserver(report).observe(card);
})();
