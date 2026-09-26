// Keep this bootstrap at the exact legacy entry URL. The Host-only owner
// branch preserves its storage origin without loading the recovery IDE.
if (new URLSearchParams(window.location.search).get('terminal_owner') === '1') {
  void import('./terminalOwner')
} else {
  void import('./recoveryMount')
}
