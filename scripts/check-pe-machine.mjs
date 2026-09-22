#!/usr/bin/env node
// Assert that Windows executables were built for the architecture we think we
// built them for.
//
// Nothing else in the Windows release path can catch a cross-architecture mix:
// electron-builder happily copies whatever `extraResources` points at, so an
// x64 `agent_team_backend.exe` left behind by a previous build would ride into
// the arm64 installer and only surface on a user's machine. The COFF header
// says what the linker actually targeted, so this reads that.
//
// Usage: node scripts/check-pe-machine.mjs <arm64|x64> <exe> [exe...]

import { openSync, readSync, closeSync } from 'node:fs'

// IMAGE_FILE_MACHINE_* from winnt.h.
const MACHINES = { arm64: 0xaa64, x64: 0x8664 }
const NAMES = new Map(Object.entries(MACHINES).map(([name, value]) => [value, name]))

function machineOf(file) {
  const fd = openSync(file, 'r')
  try {
    // DOS header: e_lfanew at 0x3c points at the PE signature.
    const dos = Buffer.alloc(0x40)
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length) {
      throw new Error('file is too short to hold a DOS header')
    }
    if (dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error('not a PE image (no MZ signature)')
    }
    const peOffset = dos.readUInt32LE(0x3c)
    // PE signature (4 bytes) then the COFF header, whose first field is Machine.
    const head = Buffer.alloc(6)
    if (readSync(fd, head, 0, head.length, peOffset) !== head.length) {
      throw new Error('file is truncated before its COFF header')
    }
    if (head.readUInt32LE(0) !== 0x00004550) {
      throw new Error('not a PE image (no PE\\0\\0 signature)')
    }
    return head.readUInt16LE(4)
  } finally {
    closeSync(fd)
  }
}

const [expected, ...files] = process.argv.slice(2)
const want = MACHINES[expected]
if (want === undefined || files.length === 0) {
  console.error('usage: node scripts/check-pe-machine.mjs <arm64|x64> <exe> [exe...]')
  process.exit(2)
}

let failed = false
for (const file of files) {
  let machine
  try {
    machine = machineOf(file)
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    failed = true
    continue
  }
  const name = NAMES.get(machine) ?? `0x${machine.toString(16).padStart(4, '0')}`
  if (machine === want) {
    console.log(`${file}: ${name}`)
  } else {
    console.error(`${file}: built for ${name}, expected ${expected}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
