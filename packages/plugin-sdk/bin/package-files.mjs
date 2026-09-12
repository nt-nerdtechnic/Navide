import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'

const FILE_TYPE_MASK = 0o170000n
const REGULAR_FILE_TYPE = 0o100000n

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    type: stat.mode & FILE_TYPE_MASK,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.type === right.type &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function assertRegularFile(identity, filePath) {
  if (identity.type !== REGULAR_FILE_TYPE) {
    throw new Error(`package entry '${filePath}' must be a regular file`)
  }
}

function assertSameIdentity(expected, actual, filePath) {
  if (!sameFileIdentity(expected, actual)) {
    throw new Error(`package entry '${filePath}' changed while it was being read`)
  }
}

/**
 * Read a package file without following a replaced final path component.
 *
 * `O_NOFOLLOW` makes the kernel refuse a symlink outright. Windows has no such
 * flag; there the `lstat` before the open still rejects a symlink at the path,
 * and comparing that identity with the opened descriptor's `fstat` catches a
 * swap in between, so the guarantee holds without the flag.
 */
export function readRegularFileNoFollow(filePath) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

  const before = fileIdentity(lstatSync(filePath, { bigint: true }))
  assertRegularFile(before, filePath)

  let descriptor
  try {
    const flags =
      constants.O_RDONLY |
      noFollow |
      (typeof constants.O_CLOEXEC === 'number' ? constants.O_CLOEXEC : 0)
    descriptor = openSync(filePath, flags)

    const opened = fileIdentity(fstatSync(descriptor, { bigint: true }))
    assertRegularFile(opened, filePath)
    assertSameIdentity(before, opened, filePath)

    const bytes = readFileSync(descriptor)

    const afterRead = fileIdentity(fstatSync(descriptor, { bigint: true }))
    assertSameIdentity(opened, afterRead, filePath)
    const afterPath = fileIdentity(lstatSync(filePath, { bigint: true }))
    assertSameIdentity(afterRead, afterPath, filePath)
    return bytes
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
