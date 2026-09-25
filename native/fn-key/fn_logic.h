/*
 * The "lone fn" decision, kept free of CoreGraphics so fn_logic_test.c can
 * drive it with plain numbers.
 *
 * A take may start only on a lone fn press: fn going down by itself, with no
 * other modifier held. If anything else happens while it is held (a key, or
 * another modifier), fn is being used as a modifier (fn+arrow, fn+F-key,
 * fn+Delete...) and the press becomes a CHORD: whoever started a take on DOWN
 * drops it, and no UP follows for that press.
 */
#ifndef NAVIDE_FN_LOGIC_H
#define NAVIDE_FN_LOGIC_H

#include <stdbool.h>
#include <stdint.h>

/* CGEventType values. */
#define FN_EV_KEY_DOWN 10u
#define FN_EV_FLAGS_CHANGED 12u

/* CGEventFlags bits. */
#define FN_FLAG_SHIFT 0x00020000ull
#define FN_FLAG_CONTROL 0x00040000ull
#define FN_FLAG_ALTERNATE 0x00080000ull
#define FN_FLAG_COMMAND 0x00100000ull
#define FN_FLAG_SECONDARY_FN 0x00800000ull
#define FN_FLAG_OTHER_MODIFIERS (FN_FLAG_SHIFT | FN_FLAG_CONTROL | FN_FLAG_ALTERNATE | FN_FLAG_COMMAND)

/* kVK_Function, and the keycode some keyboards report for the Globe key. */
#define FN_KEYCODE_FUNCTION 63
#define FN_KEYCODE_GLOBE 179

typedef enum { FN_EMIT_NONE, FN_EMIT_DOWN, FN_EMIT_UP, FN_EMIT_CHORD } fn_emit;

typedef struct {
  bool down; /* fn is held (whatever else is) */
  bool lone; /* ...and nothing else has happened since it went down */
} fn_state;

static inline fn_emit fn_step(fn_state *s, uint32_t type, int64_t keycode, uint64_t flags) {
  if (type == FN_EV_KEY_DOWN) {
    if (s->down && s->lone) {
      s->lone = false;
      return FN_EMIT_CHORD;
    }
    return FN_EMIT_NONE;
  }
  if (type != FN_EV_FLAGS_CHANGED) return FN_EMIT_NONE;

  bool fn_now = (flags & FN_FLAG_SECONDARY_FN) != 0;
  bool others = (flags & FN_FLAG_OTHER_MODIFIERS) != 0;
  if (fn_now && !s->down) {
    s->down = true;
    s->lone = !others && (keycode == FN_KEYCODE_FUNCTION || keycode == FN_KEYCODE_GLOBE);
    return s->lone ? FN_EMIT_DOWN : FN_EMIT_NONE;
  }
  if (!fn_now && s->down) {
    bool was_lone = s->lone;
    s->down = false;
    s->lone = false;
    return was_lone ? FN_EMIT_UP : FN_EMIT_NONE;
  }
  if (fn_now && s->lone && others) {
    s->lone = false;
    return FN_EMIT_CHORD;
  }
  return FN_EMIT_NONE;
}

#endif
