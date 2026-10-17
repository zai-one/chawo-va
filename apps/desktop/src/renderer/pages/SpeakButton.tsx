// «Озвучить» next to a text in the window: main reads it through the service picked on «Голос» and
// plays it in the floating player (which also says when no service is set up yet).
import { Button } from '@chawo/ui/Button';
import { invoke } from '../bridge';
import { useL } from '../app/i18n';

export function SpeakButton({ text }: { text: string }) {
  const L = useL();
  return (
    <Button variant="link" data-voice="speak" disabled={!text.trim()} onClick={() => void invoke('voice:speak', text)}>
      {L('Озвучить', 'Read aloud')}
    </Button>
  );
}
