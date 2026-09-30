<script setup lang="ts">
// Extensions inventory: the bundled packages and the installed plugins, with
// their trust/capability badges. Browsing and installing live on the separate
// Marketplace page; the execution policy that governs what any of them may run
// is the editable block above this pane on the same settings page.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../../shared/executionPolicy'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { confirmUninstall, ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import { useNotify } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from './PluginTrustDialog.vue'
import PackUninstallDialog from './PackUninstallDialog.vue'

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

// The main process keeps its refusals in English for its logs; the known ones
// are shown translated, matched by their stable wording. Anything else is shown
// as the Host wrote it.
const HOST_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^plugin transaction already in progress for (?<id>.+)$/, 'transactionInProgress'],
  [/^plugin (?<id>\S+) has no completed activation to roll back$/, 'noCompletedActivation'],
  [/^previous package is unavailable for rollback(?:: (?<detail>.+))?$/s, 'previousUnavailable'],
  [/^previous package artifact identity changed before rollback$/, 'previousChanged'],
  [/^active package grant is unavailable for (?<id>.+)$/, 'grantUnavailable'],
  [/^factory package rollback is unavailable$/, 'factoryUnavailable'],
  [/^Bundled Git cannot be restored while NAVIDE_GIT_RECOVERY=legacy is forcing legacy recovery$/, 'gitLegacyRecovery'],
  [/^Factory package restoration failed: (?<detail>.+)$/s, 'factoryRestoreFailed'],
]

function pluginErrorMessage(err: unknown): string {
  const message = ipcErrorMessage(err)
  for (const [pattern, key] of HOST_REFUSALS) {
    const match = pattern.exec(message)
    if (!match) continue
    const groups = match.groups
    const text = t(`settings.extensions.rollback.errors.${key}`, { id: groups?.id ?? '' })
    return groups?.detail ? `${text} (${groups.detail})` : text
  }
  return message
}

async function remove(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  if (!(await confirmUninstall(t, notify, id))) return
  await api.remove(id)
  await refreshInstalled()
}

// Returning an installed package to what it displaced: the previous version, or
// the App-bundled factory package for the ids that ship with Navide. The Host
// decides which of the two applies; the row only offers the button when the Host
// says a rollback is available.
async function rollback(id: string, kind: 'factory' | 'previous', version?: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  const confirmed = await notify.confirm(
    kind === 'factory'
      ? t('settings.extensions.rollback.confirmFactory', { id })
      : t('settings.extensions.rollback.confirmPrevious', {
          id,
          version: version ?? t('settings.extensions.rollback.previousVersion'),
        }),
    {
      title: t('settings.extensions.rollback.title'),
      confirmText: t('settings.extensions.rollback.confirm'),
      danger: true,
    },
  )
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await api.rollback(id)
    await refreshInstalled()
    void pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
    // A rollback can fail after the Host already switched packages, so the
    // row is redrawn from the Host rather than left offering a stale action.
    await refreshInstalled().catch((refreshErr: unknown) => {
      console.warn('[extensions] inventory refresh after a failed rollback failed:', refreshErr)
    })
  } finally {
    busy.value = false
  }
}

async function restartPlugin(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restart(id)
    await refreshInstalled()
    void pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// D2: the per-extension "Get pre-releases" switch. It only changes which
// versions the update check offers; updating still goes through the normal
// verified install flow and its trust dialog.
async function setPrerelease(id: string, enabled: boolean): Promise<void> {
  const api = pluginsApi()
  if (!api?.setPrerelease) return
  busy.value = true
  error.value = ''
  try {
    await api.setPrerelease(id, enabled)
    await refreshInstalled()
    await pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// Installed Extension Packs. A pack is a record over its members, which are
// listed (and removable) as ordinary extensions below.
const packs = ref<InstalledPackRecord[]>([])
const uninstallingPack = ref<InstalledPackRecord | null>(null)

async function refreshPacks(): Promise<void> {
  const api = pluginsApi()
  if (!api?.listPacks) return
  try {
    packs.value = await api.listPacks()
  } catch {
    packs.value = []
  }
}

// D8: remove the pack; remove only the members the user ticked.
async function uninstallPack(members: string[]): Promise<void> {
  const api = pluginsApi()
  const pack = uninstallingPack.value
  if (!api?.removePack || !pack) return
  busy.value = true
  error.value = ''
  try {
    for (const id of members) await api.remove(id)
    await api.removePack(pack.id)
    uninstallingPack.value = null
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
    await refreshInstalled()
    await refreshPacks()
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
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refreshInstalled()
  void pluginUpdates.refresh()
  void refreshPacks()
})
// A pack installed from the Marketplace page shows up here without a remount.
watch(installed, () => void refreshPacks())
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
          <span v-if="p.installed?.pendingCandidateVersion" class="ext-badge ext-candidate">
            {{ $t('settings.extensions.candidateReady', { version: p.installed.pendingCandidateVersion }) }}
          </span>
          <button
            v-if="p.optedOut"
            class="ext-restore"
            :disabled="busy"
            @click="restoreFactoryPackage(p.id)"
          >
            {{ $t('settings.extensions.restore') }}
          </button>
          <!-- A rollback leaves the displaced package staged over the bundled
               one, and this row is the only place it is still listed. -->
          <button
            v-else-if="p.installed?.pendingCandidateVersion"
            class="ext-restart nv-btn nv-btn--sm"
            :disabled="busy || updateFlow.busy.value"
            @click="restartPlugin(p.id)"
          >
            {{ $t('settings.extensions.restartPlugin') }}
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
        <li v-for="pack in packs" :key="`pack:${pack.id}`" class="ext-installed ext-pack" :data-pack-id="pack.id">
          <span class="ext-id">{{ pack.displayName || pack.id }}</span>
          <span v-if="pack.displayName" class="ext-requires ext-pack-id">{{ pack.id }}</span>
          <span class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: pack.version }) }}</span>
          <span class="ext-badge ext-pack-badge">{{ $t('settings.extensions.pack.membersBadge', { count: pack.members.length }) }}</span>
          <button
            class="ext-pack-remove nv-btn nv-btn--sm"
            :disabled="busy || updateFlow.busy.value"
            @click="uninstallingPack = pack"
          >
            {{ $t('settings.extensions.marketplace.uninstall') }}
          </button>
          <div class="ext-permission-details">
            <span class="ext-pack-includes">{{ $t('settings.extensions.pack.includes', { members: pack.members.join(' · ') }) }}</span>
          </div>
        </li>
        <li v-for="p in nonFactoryInstalled" :key="p.id" class="ext-installed" :data-id="p.id">
          <span class="ext-id">{{ p.id }}</span>
          <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: p.packageVersion }) }}</span>
          <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
            {{ $t('settings.extensions.sensitive') }}: {{ p.sensitive.join(', ') }}
          </span>
          <span class="ext-requires">{{ p.requires.join(', ') }}</span>
          <span v-if="p.warning" class="ext-badge ext-dev-warning">{{ p.warning }}</span>
          <!-- Label only: the Host keeps running the package (no silent disable). -->
          <span
            v-if="p.engineCompatible === false"
            class="ext-badge ext-incompatible"
            :title="$t('settings.extensions.incompatibleReason', { version: p.minNavideVersion ?? '' })"
          >
            {{ $t('settings.extensions.incompatibleInstalled', { version: p.minNavideVersion ?? '' }) }}
          </span>
          <span v-if="p.pendingCandidateVersion" class="ext-badge ext-candidate">
            {{ $t('settings.extensions.candidateReady', { version: p.pendingCandidateVersion }) }}
          </span>
          <span v-else-if="updatesById.get(p.id)" class="ext-badge ext-update-badge">
            {{ $t('settings.extensions.marketplace.updateAvailableVersion', { version: updatesById.get(p.id)?.latestVersion ?? '' }) }}
          </span>
          <!-- Actions sit on the row's first line; the permission details wrap below. -->
          <button
            v-if="!p.pendingCandidateVersion && updatesById.get(p.id)"
            class="ext-update nv-btn nv-btn--primary nv-btn--sm"
            :disabled="updateFlow.busy.value || busy"
            @click="updateFlow.install(updatesById.get(p.id)!.namespace, updatesById.get(p.id)!.name, updatesById.get(p.id)!.latestVersion)"
          >
            {{ $t('settings.extensions.marketplace.update') }}
          </button>
          <button
            v-if="p.pendingCandidateVersion"
            class="ext-restart nv-btn nv-btn--sm"
            :disabled="busy || updateFlow.busy.value"
            @click="restartPlugin(p.id)"
          >
            {{ $t('settings.extensions.restartPlugin') }}
          </button>
          <button
            v-if="p.rollbackKind"
            class="ext-rollback nv-btn nv-btn--sm"
            :disabled="busy || updateFlow.busy.value"
            @click="rollback(p.id, p.rollbackKind, p.rollbackToVersion)"
          >
            {{
              p.rollbackKind === 'factory'
                ? $t('settings.extensions.rollback.toBundled')
                : $t('settings.extensions.rollback.toVersion', { version: p.rollbackToVersion })
            }}
          </button>
          <button class="ext-remove nv-btn nv-btn--sm" :disabled="busy || updateFlow.busy.value" @click="remove(p.id)">
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
            <span v-if="p.engineCompatible === false" class="ext-incompatible-reason">
              {{ $t('settings.extensions.incompatibleReason', { version: p.minNavideVersion ?? '' }) }}
            </span>
          </div>
          <label v-if="p.getsPrereleases !== undefined" class="ext-prerelease-toggle">
            <input
              type="checkbox"
              :checked="p.getsPrereleases"
              :disabled="busy || updateFlow.busy.value"
              @change="setPrerelease(p.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ $t('settings.extensions.getPrereleases') }}
          </label>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">{{ $t('settings.extensions.empty') }}</li>
      </ul>
    </section>

    <PackUninstallDialog
      v-if="uninstallingPack"
      :pack="uninstallingPack"
      :busy="busy"
      @confirm="uninstallPack"
      @cancel="uninstallingPack = null"
    />
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
.ext-updates-summary {
  margin: 4px 0 0;
  color: var(--accent-fg);
  font-size: var(--font-xs);
}
.ext-badge.ext-update-badge {
  color: var(--accent-fg);
  font-size: var(--font-2xs);
}
.ext-badge.ext-incompatible {
  color: var(--danger-bright);
  font-size: var(--font-2xs);
}
.ext-badge.ext-pack-badge {
  color: var(--accent-fg);
  font-size: var(--font-2xs);
}
.ext-prerelease-toggle {
  flex: 1 1 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.ext-update,
.ext-remove,
.ext-pack-remove,
.ext-restore,
.ext-rollback,
.ext-restart {
  margin-left: auto;
}
.ext-update + .ext-remove,
.ext-rollback + .ext-remove,
.ext-restart + .ext-rollback,
.ext-restart + .ext-remove {
  margin-left: 0;
}
</style>
