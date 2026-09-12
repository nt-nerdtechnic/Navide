import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadPluginDir } from './installedPlugins'
import type { FrontendPluginManager, BundledMiniIdeSource } from './frontendPluginManager'
import { bundledMiniIdeDir } from './frontendPluginManager'

export const MINI_IDE_CONTRIBUTION = 'navide.mini-ide.window'

export function bundledMiniIdeV2Dir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'navide-mini-ide')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'navide-mini-ide')
}

/** The old artifact is a recovery implementation of an installed IDE, never
 * a substitute for installation. Removal/opt-out is checked by the caller. */
export function activateInstalledMiniIdeRecovery(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource,
): { registered: boolean; reason?: string } {
  const selected = manager.getDescriptor('navide.mini-ide')
  const installed = manager.listInstalledPackages().some(item => item.id === 'navide.mini-ide')
  if (!selected || !installed) return { registered: false, reason: 'IDE plugin is not installed' }
  const legacy = loadPluginDir(bundledMiniIdeDir(source))
  if (!legacy.descriptor || legacy.descriptor.id !== 'navide.mini-ide' ||
    !existsSync(legacy.descriptor.entryFile)) {
    return { registered: false, reason: 'installed IDE recovery artifact is unavailable' }
  }
  manager.replaceBuiltinForRecovery(legacy.descriptor)
  return { registered: true }
}
