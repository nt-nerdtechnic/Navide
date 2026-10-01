/*
 * Sandbox escape probe for pluginBackendSandbox tests. Each check prints one
 * line "<name>=ok" or "<name>=denied:<errno>". Paths and the loopback port are
 * passed through the environment by the test; nothing here is trusted input.
 */
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void report(const char *name, int ok, int err) {
  if (ok) printf("%s=ok\n", name);
  else printf("%s=denied:%d\n", name, err);
  fflush(stdout);
}

static void check_read(const char *name, const char *path) {
  int fd = path ? open(path, O_RDONLY) : -1;
  report(name, fd >= 0, path ? errno : EINVAL);
  if (fd >= 0) close(fd);
}

static void check_write(const char *name, const char *path) {
  int fd = path ? open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600) : -1;
  report(name, fd >= 0, path ? errno : EINVAL);
  if (fd >= 0) close(fd);
}

static void check_list(const char *name, const char *path) {
  DIR *dir = path ? opendir(path) : NULL;
  int ok = dir != NULL && readdir(dir) != NULL;
  report(name, ok, path ? errno : EINVAL);
  if (dir) closedir(dir);
}

static void check_stat(const char *name, const char *path) {
  struct stat info;
  int result = path ? stat(path, &info) : -1;
  report(name, result == 0, path ? errno : EINVAL);
}

static void check_connect(const char *name, const char *ip, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    report(name, 0, errno);
    return;
  }
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)port);
  inet_pton(AF_INET, ip, &address.sin_addr);
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  report(name, result == 0, errno);
  close(fd);
}

static void check_resolve(const char *name, const char *host) {
  struct addrinfo *info = NULL;
  int result = getaddrinfo(host, "80", NULL, &info);
  report(name, result == 0, result);
  if (info) freeaddrinfo(info);
}

static void check_exec(const char *name, const char *path, char *const argv[]) {
  pid_t child = fork();
  if (child < 0) {
    report(name, 0, errno);
    return;
  }
  if (child == 0) {
    execv(path, argv);
    _exit(100 + (errno & 0x7f));
  }
  int status = 0;
  waitpid(child, &status, 0);
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  report(name, code == 0, code >= 100 ? code - 100 : code);
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "noop") == 0) return 0;
  const char *port = getenv("PROBE_PORT");
  char data_file[4096];
  snprintf(data_file, sizeof(data_file), "%s/probe-write", getenv("PROBE_DATA") ? getenv("PROBE_DATA") : "");

  check_read("read_package", getenv("PROBE_SELF"));
  check_write("write_data", data_file);
  check_read("read_secret", getenv("PROBE_SECRET"));
  check_list("list_real_home", getenv("PROBE_REAL_HOME"));
  check_write("write_outside", getenv("PROBE_OUTSIDE"));
  check_connect("connect_loopback", "127.0.0.1", port ? atoi(port) : 9);
  check_connect("connect_internet", "1.1.1.1", 53);
  check_resolve("resolve_dns", "example.com");
  char *self_argv[] = {(char *)getenv("PROBE_SELF"), "noop", NULL};
  check_exec("exec_self", getenv("PROBE_SELF"), self_argv);
  char *shell_argv[] = {"/bin/sh", "-c", "exit 0", NULL};
  check_exec("exec_shell", "/bin/sh", shell_argv);
  check_stat("stat_sensitive", getenv("PROBE_SENSITIVE"));
  check_stat("stat_home_other", getenv("PROBE_HOME_OTHER"));
  const char *copy = getenv("PROBE_DATA_COPY");
  if (copy) {
    int in = open(getenv("PROBE_SELF"), O_RDONLY);
    int out = open(copy, O_WRONLY | O_CREAT | O_TRUNC, 0700);
    char buffer[65536];
    ssize_t count;
    while (in >= 0 && out >= 0 && (count = read(in, buffer, sizeof(buffer))) > 0) write(out, buffer, (size_t)count);
    if (in >= 0) close(in);
    if (out >= 0) close(out);
    char *copy_argv[] = {(char *)copy, "noop", NULL};
    check_exec("exec_data_copy", copy, copy_argv);
  }
  return 0;
}
