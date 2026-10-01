/*
 * Backend Wire v1 child that tries to outlive its sandbox: at start it does
 * fork -> setsid -> fork, so the grandchild is reparented to launchd and is no
 * longer a descendant of the process the Host spawned. The grandchild writes
 * its pid to $HOME/grandchild.pid (HOME is the sandbox data directory) and
 * then, per $GRANDCHILD_MODE, holds memory ("memory"), spins ("cpu") or idles.
 * The root answers navide/health and the method df.ping.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void grandchild(void) {
  char path[4096];
  snprintf(path, sizeof(path), "%s/grandchild.pid", getenv("HOME") ? getenv("HOME") : ".");
  const char *mode = getenv("GRANDCHILD_MODE") ? getenv("GRANDCHILD_MODE") : "idle";
  if (strcmp(mode, "memory") == 0) {
    size_t size = 96u * 1024u * 1024u;
    char *block = malloc(size);
    if (block) memset(block, 1, size);
  }
  FILE *file = fopen(path, "w");
  if (file) {
    fprintf(file, "%d\n", getpid());
    fclose(file);
  }
  volatile unsigned long spin = 0;
  for (;;) {
    if (strcmp(mode, "cpu") == 0) spin++;
    else sleep(1);
  }
}

static int field(const char *line, const char *key, char *out, size_t size) {
  const char *start = strstr(line, key);
  if (!start) return 0;
  start += strlen(key);
  const char *end = strchr(start, '"');
  if (!end || (size_t)(end - start) >= size) return 0;
  memcpy(out, start, (size_t)(end - start));
  out[end - start] = '\0';
  return 1;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  pid_t first = fork();
  if (first == 0) {
    setsid();
    if (fork() == 0) grandchild();
    _exit(0);
  }
  if (first > 0) waitpid(first, NULL, 0);

  char line[65536];
  while (fgets(line, sizeof(line), stdin)) {
    char id[128];
    if (!field(line, "\"id\":\"", id, sizeof(id))) continue;
    const char *value = strstr(line, "\"method\":\"navide/health\"") ? "{\"ok\":true}"
      : strstr(line, "\"name\":\"df.ping\"") ? "{\"pong\":true}" : NULL;
    if (value) {
      printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"resultType\":\"complete\",\"value\":%s,"
             "\"_meta\":{\"io.modelcontextprotocol/serverInfo\":{\"name\":\"acme.df\",\"version\":\"1.0.0\"}}}}\n",
             id, value);
    } else {
      printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}\n", id);
    }
    fflush(stdout);
  }
  return 0;
}
