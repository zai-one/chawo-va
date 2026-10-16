// Test script for «Свой скрипт»: upper-cases stdin, appends the CHAWO_* variables.
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (s += c));
process.stdin.on('end', () => {
  const tag = process.argv.includes('--tag') ? ` [${process.env.CHAWO_SOURCE}${process.env.CHAWO_FILE ? ' ' + require('path').basename(process.env.CHAWO_FILE) : ''}]` : '';
  process.stdout.write(s.toUpperCase() + tag + '\n\n');
});
