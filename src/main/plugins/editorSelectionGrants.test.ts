import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EditorSelectionGrants, type EditorSelectionOwner } from './editorSelectionGrants'

const temporaryRoots: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

const owner: EditorSelectionOwner = {
  instanceId: 'instance-a',
  workspaceId: 'workspace-a',
  packageVersion: '1.0.0',
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('EditorSelectionGrants', () => {
  it('resolves only the exact selected file and rejects sibling paths', () => {
    const workspace = temporaryDirectory('navide-selection-')
    const selectedPath = join(workspace, 'selected.txt')
    writeFileSync(selectedPath, 'selected')
    writeFileSync(join(workspace, 'sibling.txt'), 'sibling')
    const selections = new EditorSelectionGrants()
    const selected = selections.mint(owner, selectedPath, 'file')

    expect(readFileSync(selected.path, 'utf8')).toBe('selected')
    expect(selections.resolve(owner, selected.grant, 'file')).toBe(selected.path)
    expect(selections.fileTarget(owner, selected.grant, 'selected.txt')).toEqual({
      workspacePath: dirname(selected.path),
      relPath: 'selected.txt',
    })
    expect(() => selections.fileTarget(owner, selected.grant, 'sibling.txt')).toThrow(
      'path does not match the selected file',
    )
  })

  it.each([
    ['instance', { ...owner, instanceId: 'instance-b' }],
    ['workspace', { ...owner, workspaceId: 'workspace-b' }],
    ['package version', { ...owner, packageVersion: '2.0.0' }],
  ] as const)('rejects a grant from another %s', (_label, otherOwner) => {
    const workspace = temporaryDirectory('navide-selection-owner-')
    const path = join(workspace, 'selected.txt')
    writeFileSync(path, 'selected')
    const selections = new EditorSelectionGrants()
    const selected = selections.mint(owner, path, 'file')

    expect(() => selections.resolve(otherOwner, selected.grant, 'file')).toThrow(
      'selected resource is not owned by this instance',
    )
  })

  it('rejects a grant when the selected path is retargeted or removed', () => {
    const workspace = temporaryDirectory('navide-selection-symlink-')
    const first = join(workspace, 'first.txt')
    const second = join(workspace, 'second.txt')
    const link = join(workspace, 'selected.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    symlinkSync(first, link)
    const selections = new EditorSelectionGrants()
    const selected = selections.mint(owner, link, 'file')

    unlinkSync(link)
    symlinkSync(second, link)
    expect(selections.resolve(owner, selected.grant, 'file')).toBe(selected.path)
    expect(() => selections.fileTarget(owner, selected.grant, 'second.txt')).toThrow(
      'path does not match the selected file',
    )

    unlinkSync(first)
    symlinkSync(second, first)
    expect(() => selections.resolve(owner, selected.grant, 'file')).toThrow(
      'selected resource is not owned by this instance',
    )
  })

  it('rejects a symlink that changed before the grant is minted', () => {
    const workspace = temporaryDirectory('navide-selection-before-mint-')
    const first = join(workspace, 'first.txt')
    const second = join(workspace, 'second.txt')
    const link = join(workspace, 'selected.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    symlinkSync(first, link)
    const selections = new EditorSelectionGrants()

    expect(() => selections.mint(owner, link, 'file', realpathSync(second))).toThrow(
      'selected resource changed before opening',
    )
    expect((selections as unknown as { selections: Map<string, unknown> }).selections.size).toBe(0)
  })

  it('closes all grants for one instance while retaining another instance', () => {
    const workspace = temporaryDirectory('navide-selection-close-')
    const firstPath = join(workspace, 'first.txt')
    const secondPath = join(workspace, 'second.txt')
    writeFileSync(firstPath, 'first')
    writeFileSync(secondPath, 'second')
    const otherOwner = { ...owner, instanceId: 'instance-b' }
    const selections = new EditorSelectionGrants()
    const first = selections.mint(owner, firstPath, 'file')
    const second = selections.mint(otherOwner, secondPath, 'file')

    selections.close(owner.instanceId)
    expect(() => selections.resolve(owner, first.grant, 'file')).toThrow(
      'selected resource is not owned by this instance',
    )
    expect(selections.resolve(otherOwner, second.grant, 'file')).toBe(second.path)
  })
})
