// Poses as ChawoNative.exe for nativeHelper tests: same stdin/stdout line protocol.
// Test-only extras: `emit <line>` echoes a line; `die` exits with code 3.
// FAKE_HELPER_MODE: 'hookfail' (hook not installed), 'silent' (never ready), 'crash' (exit at once).
const mode = process.env.FAKE_HELPER_MODE || '';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const out = (l) => process.stdout.write(l + '\n');
if (mode === 'crash') process.exit(2);
const args = process.argv.slice(2);
const hk = args[args.indexOf('--hotkey') + 1];
out('log ' + b64('started hotkey=' + hk));
if (mode === 'hookfail') out('hookfail ' + b64('SetWindowsHookEx failed: 5'));
if (mode !== 'silent') out('ready 1');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const p = line.split(' ');
    out('log ' + b64('got ' + p.slice(0, p[0] === 'insert' ? 5 : 3).join(' ')));
    switch (p[0]) {
      case 'insert': {
        const text = Buffer.from(p[5] || '', 'base64').toString('utf8');
        out('log ' + b64('text ' + text));
        if (text === 'SLOW') break; // never answers
        if (text === 'ERR') { out(`err ${p[1]} error`); break; }
        out(`ok ${p[1]} ${text === 'BLOCK' ? 'Blocked' : 'Done'}`);
        break;
      }
      case 'copysel': out(`sel ${p[1]} ${process.env.FAKE_SEL ? b64(process.env.FAKE_SEL) : '-'}`); break;
      case 'selread': {
        const sel = process.env.FAKE_SEL;
        if (sel === 'HANG') break; // a hung app: never answers
        const reply = () => out(`sel ${p[1]} ${sel ? b64(sel) : '-'}`);
        if (process.env.FAKE_SEL_DELAY) setTimeout(reply, Number(process.env.FAKE_SEL_DELAY));
        else reply();
        break;
      }
      case 'fg': out(`fg ${p[1]} ${b64('notepad')}`); break;
      case 'ping': out(`pong ${p[1]}`); break;
      case 'emit': out(p.slice(1).join(' ')); break;
      case 'die': process.exit(3);
      case 'quit': process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
