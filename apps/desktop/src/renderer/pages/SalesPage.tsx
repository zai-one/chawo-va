// «Продажи»: product catalog, materials folder (local RAG) and the call stand-in.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SalesStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applySales, salesStore } from '../app/state';
import { useStore } from '../app/store';

type SalesRow = SalesStateDto['rows'][number];

function CatalogRow({ r, s, focus }: { r: SalesRow; s: SalesStateDto; focus: boolean }) {
  const code = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const line = useRef<HTMLInputElement>(null);
  const similar = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) code.current?.focus();
  }, [focus]);
  // Saved on every edit; the state is only stored, the fields keep their text and the caret.
  const send = () =>
    void invoke('sales:setRow', r.id, code.current?.value ?? '', name.current?.value ?? '', line.current?.value ?? '', similar.current?.value ?? '').then((st) =>
      salesStore.set(st),
    );
  return (
    <div className="dict-row">
      <TextField fieldRef={code} value={r.Code} spellCheck={false} aria-label={s.codeHeader} onInput={send} />
      <TextField fieldRef={name} value={r.Name} spellCheck={false} aria-label={s.nameHeader} onInput={send} />
      <TextField fieldRef={line} value={r.Line} spellCheck={false} aria-label={s.lineHeader} onInput={send} />
      <TextField fieldRef={similar} value={r.SimilarCode} spellCheck={false} aria-label={s.similarHeader} onInput={send} />
      <Button onClick={() => void invoke('sales:remove', r.id).then(applySales)}>{s.deleteLabel}</Button>
    </div>
  );
}

function CallField({ value, label, fieldRef }: { value: string; label: string; fieldRef: RefObject<HTMLInputElement | null> }) {
  return (
    <label className="stack">
      <span className="muted">{label}</span>
      <TextField fieldRef={fieldRef} value={value} spellCheck={false} autoComplete="off" aria-label={label} />
    </label>
  );
}

export function SalesPage() {
  const L = useL();
  const s = useStore(salesStore);
  // The row just added («Добавить») gets the caret in its code field.
  const [focusId, setFocusId] = useState<number | null>(null);
  const ext = useRef<HTMLInputElement>(null);
  const num = useRef<HTMLInputElement>(null);
  const mgr = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void invoke('sales:state').then(applySales);
  }, []);
  if (!s) return <h1>{L(...TITLES.sales)}</h1>;
  const showCall = () => void invoke('sales:showCall', ext.current?.value ?? '', num.current?.value ?? '', mgr.current?.value ?? '').then(applySales);
  return (
    <>
      <h1>{L(...TITLES.sales)}</h1>
      <p className="muted">{s.intro}</p>
      <p className={s.salesMode ? 'hint' : 'hint warn'}>{s.modeNote}</p>

      {/* Catalog: code, name, short line, similar code; saved on every edit. */}
      <div className="dict sales">
        <div className="dict-row head muted">
          <span>{s.codeHeader}</span>
          <span>{s.nameHeader}</span>
          <span>{s.lineHeader}</span>
          <span>{s.similarHeader}</span>
          <span />
        </div>
        {s.rows.map((r) => (
          <CatalogRow key={r.id} r={r} s={s} focus={r.id === focusId} />
        ))}
      </div>
      <Row>
        <Button
          onClick={() =>
            void invoke('sales:add').then((res) => {
              applySales(res.state);
              setFocusId(res.id);
            })
          }
        >
          {s.addLabel}
        </Button>
      </Row>

      {/* Materials folder (local RAG). */}
      <Fieldset legend={s.ragHeading}>
        <Hint>{s.ragIntro}</Hint>
        <div className="folder-row">
          <TextField value={s.ragFolderText} readOnly spellCheck={false} aria-label={s.ragHeading} />
          <Button onClick={() => void invoke('sales:pickFolder').then(applySales)}>{s.pickLabel}</Button>
          <Button disabled={!s.canClear} onClick={() => void invoke('sales:clearFolder').then(applySales)}>
            {s.clearLabel}
          </Button>
        </div>
        <Hint>{s.ragStatus}</Hint>
      </Fieldset>

      {/* Call stand-in. */}
      <Fieldset legend={s.callHeading}>
        <Hint>{s.callIntro}</Hint>
        <div className="call-row">
          <CallField fieldRef={ext} value={s.call.extension} label={s.extensionHeader} />
          <CallField fieldRef={num} value={s.call.number} label={s.numberHeader} />
          <CallField fieldRef={mgr} value={s.call.manager} label={s.managerHeader} />
        </div>
        <Row>
          <Button onClick={showCall}>{s.showCallLabel}</Button>
        </Row>
        {s.call.status && <Hint>{s.call.status}</Hint>}
      </Fieldset>
    </>
  );
}
