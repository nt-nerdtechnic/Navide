/** Existing Registry target wire values bound to the current Host runtime. */
export const UNIVERSAL_PLUGIN_TARGET = 'universal'

export function currentPluginHostTarget(): string {
  return `${process.platform}-${process.arch}`
}

export function isPluginTargetCompatible(
  target: unknown,
  expectedTarget = currentPluginHostTarget()
): target is string {
  return target === UNIVERSAL_PLUGIN_TARGET || target === expectedTarget
}

export function assertPluginTargetCompatible(
  target: unknown,
  expectedTarget = currentPluginHostTarget()
): asserts target is string {
  if (!isPluginTargetCompatible(target, expectedTarget)) {
    throw new Error(`plugin target '${String(target)}' is not compatible with host target '${expectedTarget}'`)
  }
}

/**
 * Pick the artifact this Host installs among one version's per-target rows:
 * the exact Host target first, then `universal`. The Registry publishes a
 * version either as one universal artifact or as platform artifacts, so at
 * most one of the two ever matches. The signed envelope's target is still
 * checked against the Host target at install time.
 */
export function selectPluginArtifact<T extends { version: string; target: string }>(
  artifacts: readonly T[],
  expectedTarget = currentPluginHostTarget()
): T {
  const selected =
    artifacts.find((artifact) => artifact.target === expectedTarget) ??
    artifacts.find((artifact) => artifact.target === UNIVERSAL_PLUGIN_TARGET)
  if (selected) return selected
  const available = artifacts.map((artifact) => artifact.target).join(', ') || 'none'
  throw new Error(
    `version ${artifacts[0]?.version ?? '(unknown)'} has no artifact for host target '${expectedTarget}' (available: ${available})`
  )
}
