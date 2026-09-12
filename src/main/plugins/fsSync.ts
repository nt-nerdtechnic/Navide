/**
 * Durability primitives shared by the Host's atomic-write stores.
 *
 * Every store writes a temporary file, fsyncs it, renames it over the target
 * and then fsyncs the parent directory so the rename itself survives a power
 * loss. Two steps of that dance are POSIX-shaped and fail on Windows:
 *
 * - `FlushFileBuffers` needs a handle opened with write access, so a file
 *   reopened read-only just to fsync it fails with EPERM. Opening it
 *   read-write flushes the same bytes on every platform.
 * - A directory handle cannot be flushed at all (EPERM again). NTFS journals
 *   directory metadata itself, so the step is skipped there rather than
 *   emulated; the POSIX behaviour is unchanged.
 */
import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isWindows } from '../../shared/osplat'

/** The synchronous `node:fs` subset the helpers touch, so stores that already
 * inject a recording filesystem seam can route the directory flush through it. */
export interface SyncFileOps {
  openSync(path: string, flags: number, mode?: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
}

const nodeOps: SyncFileOps = { openSync, fsyncSync, closeSync }

/** Flush an already-written file's contents to disk. */
export function fsyncFileSync(path: string, ops: SyncFileOps = nodeOps): void {
  const fd = ops.openSync(path, constants.O_RDWR)
  try {
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
}

/**
 * Flush a directory entry (a completed rename, unlink or mkdir) to disk.
 * No-op on Windows, where a directory handle cannot be fsynced.
 */
export function syncDirectorySync(
  directory: string,
  options: { ops?: SyncFileOps; flags?: number } = {},
): void {
  if (isWindows()) return
  const ops = options.ops ?? nodeOps
  const fd = ops.openSync(directory, options.flags ?? constants.O_RDONLY)
  try {
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
}

/** Promise flavour of {@link syncDirectorySync} for the async stores. */
export async function syncDirectory(directory: string): Promise<void> {
  if (isWindows()) return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
