/*
 * navide-pane: the process every macOS CLI pane runs under.
 *
 * LaunchServices names a process after the nearest ancestor that has
 * registered with it. Everything a pane runs descends from Navide.app, so any
 * tool a pane launches that itself registers (a browser-automation CLI did,
 * on every invocation) surfaced in the Dock as another running "Navide" for
 * as long as it lived — which looks exactly like the app relaunching.
 *
 * This helper sits between the backend and the pane's shell. It registers
 * with LaunchServices from inside its own bundle (Info.plist: LSUIElement),
 * so anything below it is attributed to "Navide Pane", a UI-element app the
 * Dock never shows. The child is spawned with posix_spawnp so the session,
 * controlling terminal, process group and fds the backend arranged are
 * inherited untouched; signals sent to the helper are forwarded, and the
 * child's exit status is the helper's, so the backend's kill and exit
 * bookkeeping does not know the helper is there.
 *
 * Built by scripts/build-pane-helper.mjs into build/pane-helper/, packaged by
 * electron-builder as Contents/Resources/bin/Navide Pane.app. Backend wiring:
 * backend/agent_team_backend/osplat/_darwin.py.
 */

#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile pid_t child_pid = 0;

static void forward(int sig) {
  if (child_pid > 0) kill(child_pid, sig);
}

static void register_with_launch_services(void) {
  /* NSApplicationLoad() is the documented way for a non-Cocoa process to
   * check in with LaunchServices. dlopen keeps AppKit out of the link and
   * the helper still runs (unattributed) if it is ever missing. */
  void *appkit = dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", RTLD_NOW);
  if (!appkit) return;
  int (*load)(void) = (int (*)(void))dlsym(appkit, "NSApplicationLoad");
  if (load) load();
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: navide-pane <program> [args...]\n");
    return 2;
  }
  register_with_launch_services();

  /* Installed before the spawn so nothing is dropped in between; posix_spawn
   * resets caught signals to their defaults in the child, so the shell does
   * not inherit these handlers. */
  struct sigaction sa;
  sa.sa_handler = forward;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  const int forwarded[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
  for (size_t i = 0; i < sizeof(forwarded) / sizeof(forwarded[0]); i++) {
    sigaction(forwarded[i], &sa, NULL);
  }

  pid_t pid = 0;
  int rc = posix_spawnp(&pid, argv[1], NULL, NULL, argv + 1, environ);
  if (rc != 0) {
    fprintf(stderr, "navide-pane: %s: %s\n", argv[1], strerror(rc));
    return rc == ENOENT ? 127 : 126;
  }
  child_pid = pid;

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    /* Die the same way, so the backend sees the signal it expects (e.g.
     * exit=143 for SIGTERM) rather than a made-up exit code. */
    signal(WTERMSIG(status), SIG_DFL);
    raise(WTERMSIG(status));
    return 128 + WTERMSIG(status);
  }
  return 1;
}
