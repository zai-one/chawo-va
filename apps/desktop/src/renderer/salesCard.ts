// The sales card's drawing (SalesCardWindow.ShowModel): who/script for a call, the «похоже» badge,
// the catalog name and line, and the materials snippet. Text goes in via textContent only. Reports its
// size to main.
import type { SalesCardApi } from '@chawo/ipc/contract';

(() => {
  const api = (window as unknown as { chawoSalesCard: SalesCardApi }).chawoSalesCard;
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const card = $('card');
  const set = (id: string, text: string, show: boolean) => {
    const n = $(id);
    n.textContent = text;
    n.hidden = !show;
  };
  const report = () => {
    const r = card.getBoundingClientRect();
    // 16 px margin on each side for the shadow.
    api.size(r.width + 32, r.height + 32);
  };
  $('close').addEventListener('click', () => api.dismiss());
  api.onState((s) => {
    set('callHead', s.callHead, s.hasCall);
    set('who', s.who, s.hasCall);
    set('script', s.script, s.hasCall && s.script.length > 0);
    set('badge', s.badge, s.hasHit && s.kind === 'Similar');
    set('name', s.name, s.hasHit);
    set('line', s.line, s.hasHit && s.line.length > 0);
    set('ragLabel', s.ragLabel, s.hasHit && s.rag.length > 0);
    set('rag', s.rag, s.hasHit && s.rag.length > 0);
    requestAnimationFrame(report);
  });
  new ResizeObserver(report).observe(card);
})();
