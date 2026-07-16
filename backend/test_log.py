import json

def get_history_lines(path):
    with open(path, "r") as f:
        return f.readlines()
