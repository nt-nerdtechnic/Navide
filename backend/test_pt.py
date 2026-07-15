import pexpect
import sys

# We'll spawn a simple prompt_toolkit app
app_code = """
from prompt_toolkit import prompt
text = prompt('> ')
print(repr(text))
"""
with open('app.py', 'w') as f:
    f.write(app_code)

child = pexpect.spawn(sys.executable, ['app.py'])
child.expect('> ')
child.send('hello')
child.send('\x16\x0a') # Ctrl+V Ctrl+J
child.send('world')
child.send('\r')
child.expect(pexpect.EOF)
print(child.before.decode())
