// «Для отдельных программ» on «Мозг»: one card per rule, the first matching rule from the top wins.
import { Button } from '@chawo/ui/Button';
import { Select } from '@chawo/ui/Choice';
import { Card, Hint, Row } from '@chawo/ui/Layout';
import { TextArea, TextField } from '@chawo/ui/TextField';
import type { BrainStateDto } from '@chawo/ipc/contract';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';
import { applyBrain } from '../app/state';

export function AppRules({ v }: { v: BrainStateDto['appRules'] }) {
  const L = useL();
  return (
    <>
      <label className="block">{v.heading}</label>
      <Hint>{v.hint}</Hint>
      {/* Index keys: the fields follow the new values when a rule is removed or raised. */}
      {v.rules.map((r, i) => (
        <Card key={i} className={`app-rule${r.hit ? ' hit' : ''}${r.active ? '' : ' inactive'}`} data-rule={String(i)}>
          <div className="card-head">
            <TextField
              data-rule="match"
              value={r.match}
              spellCheck={false}
              placeholder={v.matchPlaceholder}
              onCommit={(match) => void invoke('brain:updateRule', i, { match }).then(applyBrain)}
            />
            {i > 0 && (
              <Button variant="link" onClick={() => void invoke('brain:raiseRule', i).then(applyBrain)}>
                ↑
              </Button>
            )}
            <Button variant="link" onClick={() => void invoke('brain:removeRule', i).then(applyBrain)}>
              {L('Удалить', 'Delete')}
            </Button>
          </div>
          <Row>
            {v.editVisible && <Select data-rule="edit" options={v.editChoices} value={r.edit} onChange={(edit) => void invoke('brain:updateRule', i, { edit }).then(applyBrain)} />}
            <Select data-rule="simple" options={v.simpleChoices} value={r.simple} onChange={(simple) => void invoke('brain:updateRule', i, { simple }).then(applyBrain)} />
          </Row>
          {r.instructionVisible && (
            <TextArea
              data-rule="instruction"
              value={r.instruction}
              spellCheck={false}
              rows={3}
              placeholder={v.instructionPlaceholder}
              onCommit={(instruction) => void invoke('brain:updateRule', i, { instruction }).then(applyBrain)}
            />
          )}
        </Card>
      ))}
      {v.last && <Hint line>{v.last}</Hint>}
      <Row>
        {v.canAdd && (
          <>
            <Button data-rule="add" onClick={() => void invoke('brain:addRule', '').then(applyBrain)}>
              {L('Добавить правило', 'Add a rule')}
            </Button>
            {v.lastMatch && (
              <Button data-rule="add-last" onClick={() => void invoke('brain:addRule', v.lastMatch).then(applyBrain)}>
                {L(`Добавить для ${v.lastMatch}`, `Add for ${v.lastMatch}`)}
              </Button>
            )}
          </>
        )}
      </Row>
    </>
  );
}
