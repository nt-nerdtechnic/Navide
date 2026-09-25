/*
 * navide-fn-key: reports presses of the fn (🌐) key to Navide.
 *
 * Browsers never deliver fn as a key event, so the renderer cannot see it.
 * This helper installs a listen-only CGEventTap (it never consumes or alters
 * an event) on flagsChanged and keyDown, runs the "lone fn" rule from
 * fn_logic.h, and prints one JSON object per line on stdout:
 *
 *   {"event":"ready","fnUsage":N}      tap installed; N = the "Press 🌐 key to"
 *                                       setting (0 = Do Nothing, -1 = unknown)
 *   {"event":"down"} / {"event":"up"}  a lone fn press and its release
 *   {"event":"chord"}                  fn became a modifier (fn+arrow...):
 *                                       drop whatever DOWN started; no UP follows
 *   {"event":"reenabled","reason":R}   macOS disabled the tap and it was re-armed
 *   {"event":"permission","granted":false}  no Input Monitoring access; exit 3
 *
 * `--check` prints {"event":"status","granted":B,"fnUsage":N} and exits;
 * `--request` asks macOS for Input Monitoring access first (the system shows
 * its prompt or adds the app to the list), then does the same.
 *
 * The callback only decides and writes a few bytes: a slow callback gets the
 * tap disabled by the system. The helper exits when stdin closes, so it never
 * outlives the Navide main process that spawned it.
 *
 * Built by scripts/build-fn-key-helper.mjs into build/fn-key/, packaged by
 * electron-builder as Contents/Resources/bin/navide-fn-key. It is a plain
 * executable, not a bundle, so macOS attributes its Input Monitoring access to
 * Navide itself. Main-process side: src/main/fn-key-helper.ts.
 */

#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "fn_logic.h"

#define EXIT_NO_PERMISSION 3
#define EXIT_TAP_FAILED 4

static CFMachPortRef tap = NULL;
static fn_state state = {false, false};

static void emit(const char *line) {
  size_t len = strlen(line);
  while (len > 0) {
    ssize_t n = write(STDOUT_FILENO, line, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      _exit(0); /* the reader is gone */
    }
    line += n;
    len -= (size_t)n;
  }
}

static int fn_usage(void) {
  int value = -1;
  CFPropertyListRef v = CFPreferencesCopyAppValue(CFSTR("AppleFnUsageType"), CFSTR("com.apple.HIToolbox"));
  if (v) {
    if (CFGetTypeID(v) == CFNumberGetTypeID()) CFNumberGetValue((CFNumberRef)v, kCFNumberIntType, &value);
    CFRelease(v);
  }
  return value;
}

static void print_status(void) {
  char line[96];
  snprintf(line, sizeof line, "{\"event\":\"status\",\"granted\":%s,\"fnUsage\":%d}\n",
           CGPreflightListenEventAccess() ? "true" : "false", fn_usage());
  emit(line);
}

static CGEventRef on_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  (void)proxy;
  (void)info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    /* A fn release may have been missed while the tap was off; the renderer
     * also ends a held take on blur, and the next lone press starts clean. */
    state.down = false;
    state.lone = false;
    if (type == kCGEventTapDisabledByUserInput && !CGPreflightListenEventAccess()) {
      emit("{\"event\":\"permission\",\"granted\":false}\n");
      exit(EXIT_NO_PERMISSION);
    }
    CGEventTapEnable(tap, true);
    emit(type == kCGEventTapDisabledByTimeout ? "{\"event\":\"reenabled\",\"reason\":\"timeout\"}\n"
                                              : "{\"event\":\"reenabled\",\"reason\":\"user-input\"}\n");
    return event;
  }
  int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  switch (fn_step(&state, (uint32_t)type, keycode, (uint64_t)CGEventGetFlags(event))) {
    case FN_EMIT_DOWN: emit("{\"event\":\"down\"}\n"); break;
    case FN_EMIT_UP: emit("{\"event\":\"up\"}\n"); break;
    case FN_EMIT_CHORD: emit("{\"event\":\"chord\"}\n"); break;
    case FN_EMIT_NONE: break;
  }
  return event;
}

static void *watch_stdin(void *arg) {
  (void)arg;
  char buf[64];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
    if (n == 0 || (n < 0 && errno != EINTR)) exit(0);
  }
  return NULL;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc > 1 && strcmp(argv[1], "--check") == 0) {
    print_status();
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "--request") == 0) {
    CGRequestListenEventAccess();
    print_status();
    return 0;
  }
  if (argc > 1) {
    fprintf(stderr, "usage: navide-fn-key [--check | --request]\n");
    return 2;
  }

  if (!CGPreflightListenEventAccess()) {
    emit("{\"event\":\"permission\",\"granted\":false}\n");
    return EXIT_NO_PERMISSION;
  }

  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown);
  tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, on_event, NULL);
  if (!tap) {
    fprintf(stderr, "navide-fn-key: CGEventTapCreate failed\n");
    return EXIT_TAP_FAILED;
  }
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);

  pthread_t watcher;
  pthread_create(&watcher, NULL, watch_stdin, NULL);

  char line[64];
  snprintf(line, sizeof line, "{\"event\":\"ready\",\"fnUsage\":%d}\n", fn_usage());
  emit(line);
  CFRunLoopRun();
  return 0;
}
