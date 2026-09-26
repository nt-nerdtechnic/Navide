import { existsSync } from 'node:fs'
import { loadPluginDir } from './installedPlugins'
import type { FrontendPluginManager, BundledMiniIdeSource } from './frontendPluginManager'
import { bundledMiniIdeDir, officialPluginArtifactPackageDir } from './frontendPluginManager'
import { UNIVERSAL_PLUGIN_TARGET } from './pluginTarget'

export const MINI_IDE_CONTRIBUTION = 'navide.mini-ide.window'

export function bundledMiniIdeV2Dir(source: BundledMiniIdeSource): string {
  return officialPluginArtifactPackageDir(source, 'navide.mini-ide', UNIVERSAL_PLUGIN_TARGET)
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
