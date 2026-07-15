const pty = require('node-pty');
const p = pty.spawn('bash', ['--noprofile', '--norc'], { cols: 80, rows: 24 });
let out = '';
p.onData(data => { out += data; });
setTimeout(() => {
  p.write('echo "hello');
  p.write('\x16\x0a'); // Ctrl+V Ctrl+J
  p.write('world"');
  p.write('\r');
}, 500);
setTimeout(() => {
  console.log(JSON.stringify(out));
  p.kill();
}, 1000);
