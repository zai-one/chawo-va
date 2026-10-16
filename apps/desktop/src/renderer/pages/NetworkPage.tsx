// «Сеть»: this PC is the Hermes host (recognizes for others) or a client (sends audio to a host).
import { useEffect, useRef, useState } from 'react';
import { Button } from '@chawo/ui/Button';
import { Check, Select } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row } from '@chawo/ui/Layout';
import { TextField } from '@chawo/ui/TextField';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { TITLES } from '../app/pages';
import { applyNetwork, networkStore } from '../app/state';
import { useStore } from '../app/store';
import { McpBox } from './McpBox';

export function NetworkPage() {
  const L = useL();
  const s = useStore(networkStore);
  const host = useRef<HTMLInputElement>(null);
  const port = useRef<HTMLInputElement>(null);
  // A button stays disabled from the click until main answers.
  const [pending, setPending] = useState<'lan' | 'check' | null>(null);
  const run = (what: 'lan' | 'check', job: () => Promise<unknown>) => {
    setPending(what);
    void job().finally(() => setPending(null));
  };
  useEffect(() => {
    void invoke('network:state').then(applyNetwork);
  }, []);
  // Saved when a field loses focus (WPF LostFocus); Enter does the same.
  const commit = () => invoke('network:remote', host.current?.value ?? '', port.current?.value ?? '');
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };
  return (
    <>
      <h1>{L(...TITLES.network)}</h1>
      {s && (
        <>
          <p className="muted">{s.intro}</p>
          <label className="block">{s.roleLabel}</label>
          <Select className="wide" options={s.roleChoices} value={s.role} onChange={(v) => void invoke('network:role', v).then(applyNetwork)} />
          {!s.client ? (
            <Fieldset legend={s.host.heading}>
              <p>{s.host.note}</p>
              <p className="muted line" data-net="hermes-status">
                {s.host.status}
              </p>
              <Row>
                <Button disabled={s.host.lanBusy || pending === 'lan'} onClick={() => run('lan', () => invoke('network:lan').then(applyNetwork))}>
                  {s.host.lanButton}
                </Button>
              </Row>
              {s.host.firewallNote && <Hint>{s.host.firewallNote}</Hint>}
              <Check checked={s.host.keepAwake} onChange={(on) => void invoke('network:keepAwake', on).then(applyNetwork)} label={' ' + s.host.keepAwakeLabel} />
              <Hint indent>{s.host.keepAwakeHint}</Hint>
            </Fieldset>
          ) : (
            <>
              <p>{s.remote.note}</p>
              <div className="form">
                <span>{s.remote.hostLabel}</span>
                <TextField fieldRef={host} value={s.remote.host} spellCheck={false} autoComplete="off" placeholder="192.168.1.20" onCommit={() => void commit().then(applyNetwork)} onKeyDown={blurOnEnter} />
                <span>{s.remote.portLabel}</span>
                <div className="inline">
                  <TextField fieldRef={port} value={String(s.remote.port)} spellCheck={false} autoComplete="off" inputMode="numeric" style={{ width: 120 }} onCommit={() => void commit().then(applyNetwork)} onKeyDown={blurOnEnter} />
                </div>
              </div>
              <Row style={{ marginTop: 12 }}>
                <Button data-net="check" disabled={s.remote.checking || pending === 'check'} onClick={() => run('check', () => commit().then(() => invoke('network:check')).then(applyNetwork))}>
                  {s.remote.checkLabel}
                </Button>
              </Row>
              <p className="muted line" data-net="check-status">
                {s.remote.checkStatus}
              </p>
            </>
          )}
          <McpBox />
        </>
      )}
    </>
  );
}
