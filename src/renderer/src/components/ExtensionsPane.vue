<script setup lang="ts">
// Extensions inventory: the bundled packages and the installed plugins, with
// their trust/capability badges. Browsing and installing live on the separate
// Marketplace page; the execution policy that governs what any of them may run
// is the editable block above this pane on the same settings page.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../../shared/executionPolicy'
import { usePluginInventory } from '../composables/usePluginInventory'

const { t } = useI18n()

function pluginsApi() {
  return window.agentTeam?.plugins
}

// One inventory for both plugin pages: an install committed on Marketplace has
// to show up in the list below without this pane being remounted.
const { installed, factoryPackages, refresh: refreshInstalled } = usePluginInventory()
const factoryRows = computed(() => factoryPackages.value.map((factoryPackage) => ({
  ...factoryPackage,
  installed: installed.value.find((plugin) => plugin.id === factoryPackage.id) ?? null,
})))
const nonFactoryInstalled = computed(() =>
  installed.value.filter((plugin) => plugin.provenance !== 'factory-bundled')
)
const busy = ref(false)
const error = ref('')

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : t('settings.extensionsPolicy.none')
}

function formatManifestPermissions(permissions: ManifestPermissionsSummary): string {
  const parts = [`${t('settings.extensionsPolicy.system')}: ${formatList(permissions.system)}`]
  if (permissions.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${permissions.shell}`)
  return parts.join('; ')
}

function formatPackageGrant(grant: PackageVersionGrantSummary | null | undefined): string {
  if (!grant) return t('settings.extensionsPolicy.noMatchingGrant')
  const parts = [
    `${t('settings.extensionsPolicy.version')} ${grant.packageVersion}`,
    `${t('settings.extensionsPolicy.system')}: ${formatList(grant.system)}`,
  ]
  if (grant.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${grant.shell}`)
  if (grant.highRiskShellConfirmed !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.highRiskShellConfirmed')}: ${grant.highRiskShellConfirmed ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  if (grant.storage !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.storage')}: ${grant.storage ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  return parts.join('; ')
}

async function remove(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  await api.remove(id)
  await refreshInstalled()
}

async function restartPlugin(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restart(id)
    await refreshInstalled()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function restoreFactoryPackage(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restoreFactoryPackage(id)
    await refreshInstalled()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refreshInstalled()
})
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>

    <section class="ext-section">
      <h3>{{ $t('settings.extensions.bundled') }}</h3>
      <ul class="ext-list">
        <li
          v-for="p in factoryRows"
          :key="p.id"
          class="ext-installed ext-factory"
          :data-factory-id="p.id"
        >
          <span class="ext-id">{{ p.id === 'navide.git' ? $t('settings.extensions.bundledGit') : p.id }}</span>
          <span v-if="p.installed?.packageVersion ?? p.version" class="ext-requires">
            {{ p.installed?.packageVersion ?? p.version }}
          </span>
          <span class="ext-badge" :class="p.active ? 'ext-active' : 'ext-removed'">
            {{
              p.active
                ? $t('settings.extensions.state.active')
                : p.optedOut
                  ? $t('settings.extensions.state.removed')
                  : $t('settings.extensions.state.unavailable')
            }}
          </span>
          <div v-if="p.installed?.manifestPermissions || p.installed?.packageVersion" class="ext-permission-details">
            <span v-if="p.installed?.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.manifestPermissions') }}: {{ formatManifestPermissions(p.installed.manifestPermissions) }}
            </span>
            <span v-if="p.installed?.packageVersion" class="ext-package-grant">
              {{ $t('settings.extensionsPolicy.packageVersionGrant') }}: {{ formatPackageGrant(p.installed.packageVersionGrant) }}
            </span>
          </div>
          <button
            v-if="p.optedOut"
            class="ext-restore"
            :disabled="busy"
            @click="restoreFactoryPackage(p.id)"
          >
            {{ $t('settings.extensions.restore') }}
          </button>
        </li>
      </ul>
    </section>

    <section class="ext-section">
      <h3>{{ $t('settings.extensions.installed') }}</h3>
      <ul class="ext-list">
        <li v-for="p in nonFactoryInstalled" :key="p.id" class="ext-installed" :data-id="p.id">
          <span class="ext-id">{{ p.id }}</span>
          <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensionsPolicy.version') }} {{ p.packageVersion }}</span>
          <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
            {{ $t('settings.extensions.sensitive') }}: {{ p.sensitive.join(', ') }}
          </span>
          <span class="ext-requires">{{ p.requires.join(', ') }}</span>
          <span v-if="p.warning" class="ext-badge ext-dev-warning">{{ p.warning }}</span>
          <span v-if="p.pendingCandidateVersion" class="ext-badge ext-candidate">
            Update {{ p.pendingCandidateVersion }} is ready
          </span>
          <div v-if="p.manifestPermissions || p.packageVersion" class="ext-permission-details">
            <span v-if="p.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.manifestPermissions') }}: {{ formatManifestPermissions(p.manifestPermissions) }}
            </span>
            <span v-if="p.packageVersion" class="ext-package-grant">
              {{ $t('settings.extensionsPolicy.packageVersionGrant') }}: {{ formatPackageGrant(p.packageVersionGrant) }}
            </span>
          </div>
          <button
            v-if="p.pendingCandidateVersion"
            class="ext-restart"
            :disabled="busy"
            @click="restartPlugin(p.id)"
          >
            Restart Plugin
          </button>
          <button class="ext-remove" :disabled="busy" @click="remove(p.id)">{{ $t('settings.extensions.remove') }}</button>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">{{ $t('settings.extensions.empty') }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.extensions-pane {
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the block above it on the same page; the page body owns the scroll, so this
     pane is a plain block. */
  padding: 0 22px 12px;
  font-size: var(--font-sm);
}
.ext-section {
  margin-bottom: 20px;
}
.ext-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.ext-installed {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-muted);
  flex-wrap: wrap;
}
.ext-id {
  font-weight: 600;
}
.ext-requires {
  color: var(--text-muted, #888);
  font-size: var(--font-xs);
}
.ext-permission-details {
  flex: 1 1 100%;
  display: grid;
  gap: 2px;
  margin: 2px 0 2px 4px;
  color: var(--text-secondary, #888);
  font-size: var(--font-2xs);
  line-height: 1.4;
}
.ext-badge.ext-sensitive {
  color: #c77400;
  font-size: var(--font-2xs);
}
.ext-badge.ext-dev-warning {
  color: #c77400;
  font-size: var(--font-2xs);
}
.ext-badge.ext-candidate {
  color: #2f6f9f;
  font-size: var(--font-2xs);
}
.ext-badge.ext-active {
  color: #1a7f37;
  font-size: 11px;
}
.ext-badge.ext-removed {
  color: #c77400;
  font-size: 11px;
}
.ext-remove,
.ext-restore,
.ext-restart {
  margin-left: auto;
}
/* These buttons declare nothing of their own — they are native browser
 * buttons. Hover therefore darkens what the platform already painted instead
 * of replacing the fill: an overlay colour here would flip a light native
 * button to a dark one on hover, which is a bigger change than the missing
 * feedback it fixes. */
.ext-remove,
.ext-restart {
  transition: filter var(--motion-fast) var(--ease-out);
}
.ext-remove:hover:not(:disabled),
.ext-restart:hover:not(:disabled) {
  filter: brightness(0.93);
}
</style>
