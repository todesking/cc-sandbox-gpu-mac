/*
 * cc-gpu-run launcher.
 *
 * Claude Code starts cc-gpu-run outside its sandbox, with an environment the model
 * can influence. Node honors NODE_OPTIONS, DYLD_* and friends, and /bin/sh honors
 * SHELLOPTS/PS4, so neither may be the entry point. This launcher is a hardened
 * runtime binary (dyld ignores DYLD_* for it); it hands the original environment
 * to cc-gpu-run as opaque data and starts node with a fixed, minimal environment.
 *
 * Build: see scripts/install.ts (GPU_RUN_NODE, GPU_RUN_CLI and GPU_RUN_SELF are
 * absolute paths baked in at install time).
 */
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if !defined(GPU_RUN_NODE) || !defined(GPU_RUN_CLI) || !defined(GPU_RUN_SELF)
#error "GPU_RUN_NODE, GPU_RUN_CLI and GPU_RUN_SELF must be defined"
#endif

extern char **environ;

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *concat(const char *a, const char *b) {
  size_t la = strlen(a), lb = strlen(b);
  char *s = malloc(la + lb + 1);
  if (!s) return NULL;
  memcpy(s, a, la);
  memcpy(s + la, b, lb + 1);
  return s;
}

/* "GPU_RUN_ENV=" + base64(entry0 \0 entry1 \0 ...) */
static char *encode_environ(void) {
  size_t n = 0;
  for (char **e = environ; *e; e++) n += strlen(*e) + 1;
  unsigned char *raw = malloc(n ? n : 1);
  if (!raw) return NULL;
  size_t off = 0;
  for (char **e = environ; *e; e++) {
    size_t l = strlen(*e);
    memcpy(raw + off, *e, l);
    off += l;
    raw[off++] = '\0';
  }
  const char *prefix = "GPU_RUN_ENV=";
  size_t plen = strlen(prefix);
  char *out = malloc(plen + 4 * ((n + 2) / 3) + 1);
  if (!out) return NULL;
  memcpy(out, prefix, plen);
  char *p = out + plen;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = raw[i] << 16;
    if (i + 1 < n) v |= raw[i + 1] << 8;
    if (i + 2 < n) v |= raw[i + 2];
    *p++ = B64[(v >> 18) & 63];
    *p++ = B64[(v >> 12) & 63];
    *p++ = i + 1 < n ? B64[(v >> 6) & 63] : '=';
    *p++ = i + 2 < n ? B64[v & 63] : '=';
  }
  *p = '\0';
  free(raw);
  return out;
}

int main(int argc, char **argv) {
  struct passwd *pw = getpwuid(getuid());
  if (!pw || !pw->pw_dir) {
    fputs("cc-gpu-run: cannot determine home directory\n", stderr);
    return 125;
  }
  char *home = concat("HOME=", pw->pw_dir);
  char *encoded = encode_environ();
  char **nargv = calloc((size_t)argc + 3, sizeof(char *));
  if (!home || !encoded || !nargv) {
    fputs("cc-gpu-run: out of memory\n", stderr);
    return 125;
  }
  char *nenv[] = {
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "LANG=C",
      home,
      encoded,
      "GPU_RUN_LAUNCHER=" GPU_RUN_SELF,
      NULL,
  };
  nargv[0] = GPU_RUN_NODE;
  nargv[1] = "--disable-sigusr1";
  nargv[2] = GPU_RUN_CLI;
  for (int i = 1; i < argc; i++) nargv[i + 2] = argv[i];
  execve(GPU_RUN_NODE, nargv, nenv);
  perror("cc-gpu-run: cannot start node (" GPU_RUN_NODE ")");
  return 125;
}
