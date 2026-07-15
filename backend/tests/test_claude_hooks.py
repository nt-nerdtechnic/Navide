from agent_team_backend.claude_hooks import _build_curl_command


def test_stop_hook_discards_http_response_body() -> None:
    command = _build_curl_command("/tmp/agent-team-port", "stop")

    assert "curl -fsS -m 2 -o /dev/null -X POST" in command
