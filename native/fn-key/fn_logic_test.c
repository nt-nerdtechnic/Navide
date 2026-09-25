/* Tests for fn_logic.h. Built and run by scripts/build-fn-key-helper.mjs --test
 * (and from src/main/fn-key-helper.test.ts on macOS). Exit status 0 = pass. */
#include <stdio.h>

#include "fn_logic.h"

static int failures = 0;

#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      fprintf(stderr, "%s:%d: FAILED: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

#define FN FN_FLAG_SECONDARY_FN
#define FLAGS FN_EV_FLAGS_CHANGED
#define KEY FN_EV_KEY_DOWN

int main(void) {
  /* Lone press and release. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, 0) == FN_EMIT_UP);
  }
  /* The Globe keycode counts as fn too. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_GLOBE, FN) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_GLOBE, 0) == FN_EMIT_UP);
  }
  /* fn+arrow: a key while fn is held makes it a chord, and no UP follows. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, KEY, 126, FN) == FN_EMIT_CHORD);
    EXPECT(fn_step(&s, KEY, 126, FN) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, 0) == FN_EMIT_NONE);
    /* The next lone press works again. */
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, 0) == FN_EMIT_UP);
  }
  /* Another modifier pressed while fn is held: chord. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, FLAGS, 59, FN | FN_FLAG_CONTROL) == FN_EMIT_CHORD);
    EXPECT(fn_step(&s, FLAGS, 59, FN) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, 0) == FN_EMIT_NONE);
  }
  /* fn pressed while another modifier is already down: never a take. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, 55, FN_FLAG_COMMAND) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN | FN_FLAG_COMMAND) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN_FLAG_COMMAND) == FN_EMIT_NONE);
  }
  /* A key down with no fn held (arrow keys carry the fn flag themselves). */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, KEY, 126, FN) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, 56, FN_FLAG_SHIFT) == FN_EMIT_NONE);
  }
  /* The fn flag set by a keycode that is not fn: not a lone fn press. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, 56, FN) == FN_EMIT_NONE);
    EXPECT(fn_step(&s, FLAGS, 56, 0) == FN_EMIT_NONE);
  }
  /* Caps Lock does not spoil a lone press. */
  {
    fn_state s = {0};
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, FN | 0x00010000ull) == FN_EMIT_DOWN);
    EXPECT(fn_step(&s, FLAGS, FN_KEYCODE_FUNCTION, 0x00010000ull) == FN_EMIT_UP);
  }

  if (failures) {
    fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  printf("fn_logic: all tests passed\n");
  return 0;
}
