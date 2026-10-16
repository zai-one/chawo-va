// The floating pill's drawing (OverlayWindow.Tick / ShowListening / ShowRecognizing / ShowText): thin bars
// that jump with the voice while listening, a calm ripple while recognizing, a short text for hints, and
// the live draft under the bars. Plain DOM; text goes in via textContent only. Reports its size to main.
// Script, not a module: everything stays inside one function so names never clash with renderer.ts.

interface OverlayPillState { visible: boolean; mode: 'listening' | 'recognizing' | 'text'; label: string; caption: string; live: string }
interface OverlayPillApi {
  onState(fn: (s: OverlayPillState) => void): void;
  onLevel(fn: (v: number) => void): void;
  size(w: number, h: number): void;
}

(() => {
  const api = (window as unknown as { chawoOverlay: OverlayPillApi }).chawoOverlay;
  const BAR_COUNT = 13;
  const BAR_WIDTH = 3;
  const BAR_MAX = 22;
  // Chawo accent ramp: coral-red → sunset-orange (same as WPF).
  const palette: [string, string][] = [
    ['#EF5143', '#C9382B'], ['#EF5143', '#C9382B'], ['#F26A4A', '#C9382B'], ['#F58352', '#B56A12'],
    ['#F89A58', '#B56A12'], ['#FFB261', '#B56A12'], ['#FFB261', '#B56A12'], ['#FFB261', '#B56A12'],
    ['#FFB261', '#B56A12'], ['#FFB261', '#B56A12'], ['#FFB261', '#B56A12'], ['#FFB261', '#B56A12'],
    ['#FFB261', '#B56A12'],
  ];
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const pill = $('pill');
  const bars = $('bars');
  const label = $('label');
  const caption = $('caption');
  const live = $('live');
  const els: HTMLElement[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement('i');
    const [top, bottom] = palette[i % palette.length];
    b.style.background = `linear-gradient(${top}, ${bottom})`;
    bars.appendChild(b);
    els.push(b);
  }
  const heights = new Float32Array(BAR_COUNT);
  let level = 0;
  let smoothed = 0;
  let mode: OverlayPillState['mode'] = 'text';
  let ripple = 0;
  let timer: number | null = null;

  const tick = () => {
    if (mode === 'recognizing') {
      // Gentle wave rolling across the bars: the app is alive, the text is coming.
      ripple += 0.28;
      for (let i = 0; i < BAR_COUNT; i++) {
        const s = 0.5 + 0.5 * Math.sin(ripple - i * 0.55);
        els[i].style.height = `${BAR_WIDTH + (0.18 + 0.32 * s) * (BAR_MAX - BAR_WIDTH)}px`;
      }
      return;
    }
    // fast attack, slow release: keeps the bars lively without flicker
    smoothed = level > smoothed ? smoothed + (level - smoothed) * 0.65 : smoothed * 0.82;
    level *= 0.9;
    for (let i = 0; i < BAR_COUNT; i++) {
      const center = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
      const target = smoothed * (0.3 + 0.7 * center) * (0.65 + 0.35 * Math.random());
      heights[i] = target > heights[i] ? target : heights[i] * 0.72;
      els[i].style.height = `${BAR_WIDTH + heights[i] * (BAR_MAX - BAR_WIDTH)}px`;
    }
  };
  const run = (on: boolean) => {
    if (on && timer === null) timer = window.setInterval(tick, 33);
    else if (!on && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
  const report = () => {
    const r = pill.getBoundingClientRect();
    api.size(r.width + 28, r.height + 28); // 14 px margin each side for the shadow
  };

  api.onLevel((v) => {
    if (typeof v === 'number' && Number.isFinite(v)) level = Math.max(level, Math.min(1, Math.max(0, v)));
  });
  api.onState((s) => {
    const was = mode;
    mode = s.mode;
    if (!s.visible) {
      run(false);
      return;
    }
    const text = s.mode === 'text';
    bars.hidden = text;
    label.hidden = !text;
    label.textContent = s.label;
    caption.hidden = text || s.caption.length === 0;
    caption.textContent = s.caption;
    live.hidden = text || s.live.length === 0;
    live.textContent = s.live;
    if (s.mode === 'listening' && was !== 'listening') {
      heights.fill(0);
      smoothed = 0;
      level = 0;
    }
    if (s.mode === 'recognizing' && was !== 'recognizing') ripple = 0;
    run(!text);
    requestAnimationFrame(report);
  });
})();
