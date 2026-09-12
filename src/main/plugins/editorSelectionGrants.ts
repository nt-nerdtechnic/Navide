import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { resolvePathForContainment } from './workspacePathPolicy'

export interface EditorSelectionOwner {
  instanceId: string
  workspaceId: string
  packageVersion: string
}

interface Selection extends EditorSelectionOwner {
  path: string
  kind: 'file' | 'directory'
}

/** Native picker/Host target provenance. Plugins only receive opaque handles;
 * the active workspace and the selected resource remain distinct authorities. */
export class EditorSelectionGrants {
  private readonly selections = new Map<string, Selection>()

  mint(owner: EditorSelectionOwner, path: string, kind: Selection['kind'], expectedCanonicalPath?: string): { path: string; grant: string } {
    const canonicalPath = resolvePathForContainment(resolve(path))
    if (!canonicalPath) throw new Error('selected resource cannot be safely resolved')
    if (expectedCanonicalPath !== undefined && canonicalPath !== expectedCanonicalPath) {
      throw new Error('selected resource changed before opening')
    }
    const grant = randomUUID()
    this.selections.set(grant, { ...owner, path: canonicalPath, kind })
    return { path: canonicalPath, grant }
  }

  resolve(owner: EditorSelectionOwner, grant: unknown, kind: Selection['kind']): string {
    const selection = typeof grant === 'string' ? this.selections.get(grant) : undefined
    if (!selection || selection.kind !== kind ||
      selection.instanceId !== owner.instanceId || selection.workspaceId !== owner.workspaceId ||
      selection.packageVersion !== owner.packageVersion ||
      resolvePathForContainment(selection.path) !== selection.path) {
      throw new Error('selected resource is not owned by this instance')
    }
    return selection.path
  }

  fileTarget(owner: EditorSelectionOwner, grant: unknown, path: string): { workspacePath: string; relPath: string } {
    const selected = this.resolve(owner, grant, 'file')
    if (resolvePathForContainment(resolve(dirname(selected), path)) !== selected) {
      throw new Error('path does not match the selected file')
    }
    return { workspacePath: dirname(selected), relPath: basename(selected) }
  }

  close(instanceId: string): void {
    for (const [grant, selection] of this.selections) {
      if (selection.instanceId === instanceId) this.selections.delete(grant)
    }
  }
}
