from prompt_toolkit import prompt
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput

def main():
    inp = create_pipe_input()
    # Send "hello", then Ctrl+V, then Ctrl+J, then "world", then Enter
    inp.send_text("hello\x16\x0aworld\r")
    
    try:
        text = prompt('>', input=inp, output=DummyOutput())
        print(repr(text))
    finally:
        inp.close()

if __name__ == '__main__':
    main()
