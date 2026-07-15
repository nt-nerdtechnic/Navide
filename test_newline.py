import pexpect
import sys

child = pexpect.spawn('bash', ['--noprofile', '--norc'])
child.expect(r'\$')
child.send('echo "hello')
child.send('\x16\x0a') # Ctrl+V Ctrl+J
child.send('world"')
child.sendline()

child.expect(r'\$')
print(child.before.decode())
