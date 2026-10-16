// «Место на диске» on «Распознавание»: «Найти лишнее» → the list by groups with sizes, safe items ticked
// → «Удалить выбранное» (main asks for confirmation and scans again before deleting).
import { useEffect, useState } from 'react';
import type { CleanupStateDto } from '@chawo/ipc/contract';
import { Button } from '@chawo/ui/Button';
import { Check } from '@chawo/ui/Choice';
import { Fieldset, Hint, Row, Status } from '@chawo/ui/Layout';
import { invoke } from '../bridge';

function preselected(s: CleanupStateDto): Set<string> {
  return new Set(s.groups.flatMap((g) => g.items.filter((i) => i.preselected).map((i) => i.id)));
}

export function CleanupBox() {
  const [s, setS] = useState<CleanupStateDto | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const apply = (next: CleanupStateDto) => {
    setS(next);
    setPicked(preselected(next));
  };
  useEffect(() => {
    void invoke('cleanup:state').then(apply);
  }, []);
  if (!s) return null;
  const all = s.groups.flatMap((g) => g.items);
  const chosen = all.filter((i) => picked.has(i.id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <Fieldset className="cleanup" data-cleanup="box" legend={s.labels.heading}>
      <Hint>{s.hint}</Hint>
      <Row>
        <Button data-cleanup="scan" disabled={s.busy} onClick={() => void invoke('cleanup:scan').then(apply)}>
          {s.scanned ? s.labels.again : s.labels.find}
        </Button>
        {all.length > 0 && (
          <Button variant="primary" data-cleanup="remove" disabled={s.busy || chosen.length === 0} onClick={() => void invoke('cleanup:remove', chosen.map((i) => i.id)).then(apply)}>
            {s.labels.remove}
          </Button>
        )}
      </Row>
      {s.groups.map((g) => (
        <div key={g.group} className="cleanup-group" data-cleanup-group={g.group}>
          <label className="block">{g.title}</label>
          {g.items.map((i) => (
            <Check
              key={i.id}
              data-cleanup-item={i.id}
              checked={picked.has(i.id)}
              onChange={(on) => toggle(i.id, on)}
              labelTitle={i.detail}
              label={
                <>
                  {' ' + i.label} <span className="muted">{i.size}</span>
                </>
              }
            />
          ))}
        </div>
      ))}
      {s.scanned && all.length === 0 && <Hint data-cleanup="nothing">{s.labels.nothing}</Hint>}
      <Status data-cleanup="status">{s.status}</Status>
    </Fieldset>
  );
}
