const pty = require('./node_modules/node-pty');
const p = pty.spawn('bash', ['--noprofile', '--norc'], { cols: 80, rows: 24 });
let out = '';
p.onData(data => { out += data; });
setTimeout(() => {
  p.write('echo "hello');
  p.write('\x1b[200~\r\x1b[201~');
  p.write('world"');
  p.write('\r');
}, 500);
setTimeout(() => {
  console.log(JSON.stringify(out));
  p.kill();
}, 1000);
