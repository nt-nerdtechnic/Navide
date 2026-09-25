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
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { confirmUninstall, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import { useNotify } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from './PluginTrustDialog.vue'

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
// Updates for installed Registry packages; the Update button reuses the
// Marketplace's verified install flow (and its trust dialog).
const pluginUpdates = usePluginUpdates()
const updatesById = computed(
  () => new Map(pluginUpdates.updates.value.map((update) => [update.id, update]))
)
const updateFlow = usePluginInstallFlow()
const notify = useNotify()

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
  if (!(await confirmUninstall(t, notify, id))) return
  await api.remove(id)
  await refreshInstalled()
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
  void pluginUpdates.refresh()
})
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>
    <p v-if="updateFlow.error.value" class="ext-error" role="alert">{{ updateFlow.error.value }}</p>

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
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.manifestPermissions'), value: formatManifestPermissions(p.installed.manifestPermissions) }) }}
            </span>
            <span
              v-if="p.installed?.packageVersion"
              class="ext-package-grant"
              :class="{ 'ext-package-grant-none': !p.installed.packageVersionGrant }"
            >
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.packageVersionGrant'), value: formatPackageGrant(p.installed.packageVersionGrant) }) }}
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
      <p v-if="pluginUpdates.count.value" class="ext-updates-summary" role="status">
        {{ $t('settings.extensions.marketplace.updatesCount', { count: pluginUpdates.count.value }) }}
      </p>
      <ul class="ext-list">
        <li v-for="p in nonFactoryInstalled" :key="p.id" class="ext-installed" :data-id="p.id">
          <span class="ext-id">{{ p.id }}</span>
          <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: p.packageVersion }) }}</span>
          <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
            {{ $t('settings.extensions.sensitive') }}: {{ p.sensitive.join(', ') }}
          </span>
          <span class="ext-requires">{{ p.requires.join(', ') }}</span>
          <span v-if="p.warning" class="ext-badge ext-dev-warning">{{ p.warning }}</span>
          <span v-if="updatesById.get(p.id)" class="ext-badge ext-update-badge">
            {{ $t('settings.extensions.marketplace.updateAvailableVersion', { version: updatesById.get(p.id)?.latestVersion ?? '' }) }}
          </span>
          <!-- Actions sit on the row's first line; the permission details wrap below. -->
          <button
            v-if="updatesById.get(p.id)"
            class="ext-update nv-btn nv-btn--primary nv-btn--sm"
            :disabled="updateFlow.busy.value"
            @click="updateFlow.install(updatesById.get(p.id)!.namespace, updatesById.get(p.id)!.name, updatesById.get(p.id)!.latestVersion)"
          >
            {{ $t('settings.extensions.marketplace.update') }}
          </button>
          <button class="ext-remove nv-btn nv-btn--sm" @click="remove(p.id)">
            {{ $t('settings.extensions.marketplace.uninstall') }}
          </button>
          <div v-if="p.manifestPermissions || p.packageVersion" class="ext-permission-details">
            <span v-if="p.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.manifestPermissions'), value: formatManifestPermissions(p.manifestPermissions) }) }}
            </span>
            <span
              v-if="p.packageVersion"
              class="ext-package-grant"
              :class="{ 'ext-package-grant-none': !p.packageVersionGrant }"
            >
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.packageVersionGrant'), value: formatPackageGrant(p.packageVersionGrant) }) }}
            </span>
          </div>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">{{ $t('settings.extensions.empty') }}</li>
      </ul>
    </section>

    <PluginTrustDialog
      v-if="updateFlow.pendingConfirm.value"
      :pending="updateFlow.pendingConfirm.value"
      :step="updateFlow.pendingStep.value"
      @confirm-publisher="updateFlow.confirmPublisher"
      @confirm-risk="updateFlow.confirmRisk"
      @cancel="updateFlow.cancel"
    />
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
.ext-error {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-sm);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-xs);
  white-space: pre-wrap;
  word-break: break-word;
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
/* No grant is the common case for a version nobody has granted anything yet;
   keep it readable but quieter than an actual grant. */
.ext-package-grant-none {
  color: var(--text-muted, #888);
  font-style: italic;
}
.ext-badge.ext-sensitive {
  color: #c77400;
  font-size: var(--font-2xs);
}
.ext-badge.ext-dev-warning {
  color: #c77400;
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
.ext-updates-summary {
  margin: 4px 0 0;
  color: var(--accent-fg);
  font-size: var(--font-xs);
}
.ext-badge.ext-update-badge {
  color: var(--accent-fg);
  font-size: var(--font-2xs);
}
.ext-update,
.ext-remove,
.ext-restore {
  margin-left: auto;
}
.ext-update + .ext-remove {
  margin-left: 0;
}
</style>
