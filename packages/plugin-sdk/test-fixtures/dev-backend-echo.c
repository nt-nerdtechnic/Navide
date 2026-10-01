/*
 * Tiny Backend Wire v1 child for the `navide-plugin dev-backend` tests. It
 * reads one JSON-RPC frame per line and only understands the frames the dev
 * launcher sends; string parsing is deliberately naive.
 *   navide/health            -> {"ok":true}
 *   subscriptions/listen     -> acknowledged notification
 *   navide/call echo.ping    -> {"pong":true}
 *   navide/call echo.emit    -> event echo.changed, then {"emitted":true}
 *   navide/call echo.bridge  -> asks the Host for filesystem.read_file and
 *                               reports whether it was denied
 *   navide/call echo.escape  -> tries to read SECRET_PATH (set at compile time)
 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef SECRET_PATH
#define SECRET_PATH "/nonexistent"
#endif

static char subscription[128] = "";

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

static void reply(const char *id, const char *value) {
  printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"resultType\":\"complete\",\"value\":%s,"
         "\"_meta\":{\"io.modelcontextprotocol/serverInfo\":{\"name\":\"acme.echo\",\"version\":\"1.0.0\"}}}}\n",
         id, value);
  fflush(stdout);
}

int main(void) {
  char line[65536];
  while (fgets(line, sizeof(line), stdin)) {
    char id[128];
    if (!field(line, "\"id\":\"", id, sizeof(id))) continue;
    if (strstr(line, "\"method\":\"navide/health\"")) {
      reply(id, "{\"ok\":true}");
    } else if (strstr(line, "\"method\":\"subscriptions/listen\"")) {
      snprintf(subscription, sizeof(subscription), "%s", id);
      printf("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/subscriptions/acknowledged\",\"params\":{\"_meta\":"
             "{\"io.modelcontextprotocol/subscriptionId\":\"%s\"},\"notifications\":{\"dev.navide/pluginEvents\":"
             "[\"echo.changed\"]}}}\n", id);
      fflush(stdout);
    } else if (strstr(line, "\"name\":\"echo.ping\"")) {
      reply(id, "{\"pong\":true}");
    } else if (strstr(line, "\"name\":\"echo.emit\"")) {
      printf("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/navide/event\",\"params\":{\"_meta\":"
             "{\"io.modelcontextprotocol/subscriptionId\":\"%s\"},\"event\":\"echo.changed\",\"payload\":{\"n\":1}}}\n",
             subscription);
      fflush(stdout);
      reply(id, "{\"emitted\":true}");
    } else if (strstr(line, "\"name\":\"echo.bridge\"")) {
      printf("{\"jsonrpc\":\"2.0\",\"id\":\"bridge:1\",\"method\":\"navide/host/call\",\"params\":{\"origin\":"
             "{\"kind\":\"call\",\"requestId\":\"%s\"},\"port\":\"filesystem\",\"operation\":\"read_file\","
             "\"arguments\":{\"rel_path\":\"a.txt\"}}}\n", id);
      fflush(stdout);
      char answer[65536];
      int denied = fgets(answer, sizeof(answer), stdin) && strstr(answer, "CAPABILITY_DENIED");
      reply(id, denied ? "{\"denied\":true}" : "{\"denied\":false}");
    } else if (strstr(line, "\"name\":\"echo.escape\"")) {
      int fd = open(SECRET_PATH, O_RDONLY);
      reply(id, fd >= 0 ? "{\"readSecret\":true}" : "{\"readSecret\":false}");
      if (fd >= 0) close(fd);
    } else {
      printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}\n", id);
      fflush(stdout);
    }
  }
  return 0;
}
