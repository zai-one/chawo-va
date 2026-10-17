// «Озвучить» next to a selection: a click asks main to read the selection aloud. Reports its size.
import type { PillApi } from '@chawo/ipc/contract';

(() => {
  const api = (window as unknown as { chawoPill: PillApi }).chawoPill;
  const pill = document.getElementById('pill') as HTMLButtonElement;
  const report = () => {
    const r = pill.getBoundingClientRect();
    api.size(r.width + 12, r.height + 12);
  };
  pill.addEventListener('click', () => api.speak());
  pill.addEventListener('mouseleave', () => api.leave());
  api.onState((s) => {
    (document.getElementById('label') as HTMLElement).textContent = s.label;
    pill.ariaLabel = s.label;
    requestAnimationFrame(report);
  });
  new ResizeObserver(report).observe(pill);
})();
