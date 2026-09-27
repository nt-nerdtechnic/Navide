/**
 * `vi.mock` factories that turn only the flush syscall into a no-op, for test
 * files whose stores fsync many times per test but whose assertions cannot
 * observe durability.
 *
 * A flush is the one filesystem call whose latency spikes on a contended CI
 * disk: on the shared Windows runner a burst of slow FlushFileBuffers calls has
 * pushed 150-300ms tests past the 5s timeout, and a test that flushes large
 * files slows every other worker's flushes too. Everything around the flush
 * still runs for real (the open with its handle mode, write, rename, close).
 * The flush contract itself (write-access handles, no directory handles on
 * Windows, POSIX directory flushes, flush-before-rename order) is covered by
 * fsSync.test.ts, fsSyncWindowsStores.test.ts and the stores' own ordering
 * tests, which keep real flushes; never use these factories there.
 *
 * Load this module lazily inside the `vi.mock` factory, because `vi.mock` is
 * hoisted above the file's imports; src/main/plugins/pluginStorage.test.ts
 * shows the two-line form for `node:fs` and `node:fs/promises`.
 */
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'

export function withoutFsyncSync(actual: typeof NodeFs): typeof NodeFs & { default: typeof NodeFs } {
  const patched: typeof NodeFs = { ...actual, fsyncSync: () => {}, fdatasyncSync: () => {} }
  return { ...patched, default: patched }
}

export function withoutHandleSync(
  actual: typeof NodeFsPromises,
): typeof NodeFsPromises & { default: typeof NodeFsPromises } {
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    handle.sync = async () => {}
    handle.datasync = async () => {}
    return handle
  }) as typeof actual.open
  const patched: typeof NodeFsPromises = { ...actual, open }
  return { ...patched, default: patched }
}
