<script setup lang="ts">
// Marketplace view: browses the registry, shows an extension's detail page and
// installs / updates / uninstalls it. Split out of ExtensionsPane so the
// Extensions page can carry the execution policy and the local inventory,
// while browsing and installing lives on its own page.
//
// Sensitive capabilities, an unknown publisher and native backend executables
// trigger the confirmation dialog after verification but before the package is
// written (usePluginInstallFlow). All privileged work is brokered through the
// main process via `window.agentTeam.plugins`; this component holds no secrets
// and never touches package bytes. README text is rendered as Vue text nodes
// (no v-html), so a package cannot inject markup into the settings window.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { InlineText, renderLines } from '../editor/markdownRender'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import PluginTrustDialog from './PluginTrustDialog.vue'

type Sort = 'downloads' | 'updated' | 'rating'

// Installing writes to the inventory the Extensions page renders, so it goes
// through the shared store rather than a list of this pane's own.
const inventory = usePluginInventory()
const pluginUpdates = usePluginUpdates()
const flow = usePluginInstallFlow()
const { locale } = useI18n()
const numberFormat = computed(() => new Intl.NumberFormat(locale.value))
function formatCount(value: number): string {
  return numberFormat.value.format(value)
}

function pluginsApi() {
  return window.agentTeam?.plugins
}

const results = ref<MarketplaceExtension[]>([])
const query = ref('')
const sort = ref<Sort>('downloads')
const listState = ref<'loading' | 'ready' | 'error'>('loading')
const listError = ref('')

const selected = ref<MarketplaceExtension | null>(null)
const detail = ref<MarketplaceExtensionDetail | null>(null)
const detailState = ref<'loading' | 'ready' | 'error'>('loading')
const detailError = ref('')

const installedById = computed(
  () => new Map(inventory.installed.value.map((plugin) => [plugin.id, plugin]))
)
const updatesById = computed(
  () => new Map(pluginUpdates.updates.value.map((update) => [update.id, update]))
)

function idOf(ext: { namespace: string; name: string }): string {
  return `${ext.namespace}.${ext.name}`
}

async function search(): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  listState.value = 'loading'
  listError.value = ''
  try {
    const res = await api.marketplaceSearch(query.value || undefined, sort.value)
    results.value = res.items
    listState.value = 'ready'
  } catch (err) {
    listError.value = ipcErrorMessage(err)
    listState.value = 'error'
  }
}

async function openDetail(ext: MarketplaceExtension): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  selected.value = ext
  detail.value = null
  detailState.value = 'loading'
  detailError.value = ''
  try {
    detail.value = await api.marketplaceDetail({ namespace: ext.namespace, name: ext.name })
    detailState.value = 'ready'
  } catch (err) {
    detailError.value = ipcErrorMessage(err)
    detailState.value = 'error'
  }
}

function closeDetail(): void {
  selected.value = null
  detail.value = null
}

// The row install would pick: the main process names the newest version with
// an artifact for this Host and marks which rows it can install, so the
// renderer never chooses among per-target rows itself.
const installableVersionInfo = computed(() => {
  const d = detail.value
  if (!d?.latest_installable_version) return null
  return (
    d.versions.find(
      (v) => v.version === d.latest_installable_version && v.installable && !v.yanked
    ) ?? null
  )
})
// What the header shows: the installable row, else (nothing for this Host) the
// Registry's latest row, for display only.
const latestVersionInfo = computed(() => {
  const d = detail.value
  if (!d) return null
  return (
    installableVersionInfo.value ??
    d.versions.find((v) => v.version === d.latest_version && !v.yanked) ??
    null
  )
})
const latestTargets = computed(() => {
  const d = detail.value
  if (!d) return ''
  return d.versions
    .filter((v) => v.version === d.latest_version && !v.yanked)
    .map((v) => v.target)
    .join(', ')
})

const readmeLines = computed(() => (detail.value?.readme ? renderLines(detail.value.readme) : []))

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

onMounted(() => {
  void inventory.refresh()
  void pluginUpdates.refresh()
  void search()
})
</script>

<template>
  <div class="marketplace-pane">
    <p v-if="flow.error.value" class="ext-error" role="alert">{{ flow.error.value }}</p>

    <!-- Detail view -->
    <section v-if="selected" class="mkt-detail" :data-detail-id="idOf(selected)">
      <button class="mkt-back nv-btn nv-btn--ghost nv-btn--sm" @click="closeDetail">
        ← {{ $t('settings.extensions.marketplace.back') }}
      </button>

      <p v-if="detailState === 'loading'" class="mkt-loading nv-loading">
        {{ $t('settings.extensions.marketplace.loadingDetail') }}
      </p>
      <div v-else-if="detailState === 'error'" class="ext-error mkt-detail-error" role="alert">
        <span>{{ $t('settings.extensions.marketplace.detailFailed', { error: detailError }) }}</span>
        <button class="mkt-retry nv-btn nv-btn--sm" @click="openDetail(selected)">
          {{ $t('settings.extensions.marketplace.retry') }}
        </button>
      </div>

      <template v-else-if="detail">
        <header class="mkt-detail-head">
          <div class="mkt-detail-title">
            <h3>{{ detail.display_name || detail.name }}</h3>
            <span class="mkt-muted">{{ idOf(detail) }}</span>
          </div>
          <div class="mkt-meta">
            <span>{{ $t('settings.extensions.marketplace.publisher') }}: <strong>{{ detail.publisher }}</strong></span>
            <span v-if="detail.latest_version">{{ $t('settings.extensions.marketplace.versionLabel', { version: detail.latest_version }) }}</span>
            <span>{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(detail.download_count) }) }}</span>
            <span v-if="detail.rating_count > 0" class="mkt-rating">
              {{
                $t('settings.extensions.marketplace.rating', {
                  average: detail.rating_average.toFixed(1),
                  count: detail.rating_count,
                })
              }}
            </span>
            <span v-else class="mkt-rating">{{ $t('settings.extensions.marketplace.noRating') }}</span>
            <span
              v-if="latestVersionInfo"
              class="mkt-badge"
              :class="latestVersionInfo.trust_tier === 'signed-verified' ? 'mkt-badge--ok' : 'mkt-badge--warn'"
            >
              {{
                latestVersionInfo.trust_tier === 'signed-verified'
                  ? $t('settings.extensions.trust.signed')
                  : $t('settings.extensions.trust.unsigned')
              }}
            </span>
          </div>
          <p v-if="detail.description" class="mkt-desc">{{ detail.description }}</p>
          <div v-if="detail.categories.length" class="mkt-tags">
            <span v-for="c in detail.categories" :key="c" class="mkt-tag">{{ c }}</span>
          </div>
          <div class="mkt-actions">
            <template v-if="installedById.get(idOf(detail))">
              <span class="mkt-badge mkt-badge--ok mkt-installed">
                {{
                  $t('settings.extensions.marketplace.installedVersion', {
                    version: installedById.get(idOf(detail))?.packageVersion ?? '',
                  })
                }}
              </span>
              <button
                v-if="updatesById.get(idOf(detail))"
                class="ext-update nv-btn nv-btn--primary"
                :disabled="flow.busy.value"
                @click="flow.install(detail.namespace, detail.name, updatesById.get(idOf(detail))?.latestVersion)"
              >
                {{
                  $t('settings.extensions.marketplace.updateTo', {
                    version: updatesById.get(idOf(detail))?.latestVersion ?? '',
                  })
                }}
              </button>
              <button
                class="ext-uninstall nv-btn nv-btn--danger"
                :disabled="flow.busy.value"
                @click="flow.uninstall(idOf(detail))"
              >
                {{ $t('settings.extensions.marketplace.uninstall') }}
              </button>
            </template>
            <button
              v-else-if="installableVersionInfo"
              class="ext-install nv-btn nv-btn--primary"
              :disabled="flow.busy.value"
              @click="flow.install(detail.namespace, detail.name, installableVersionInfo.version)"
            >
              <!-- Name the version when it is not the one the header shows. -->
              {{
                installableVersionInfo.version === detail.latest_version
                  ? $t('settings.extensions.install')
                  : $t('settings.extensions.marketplace.installVersion', { version: installableVersionInfo.version })
              }}
            </button>
          </div>
          <p
            v-if="detail.latest_version && detail.latest_installable_version !== detail.latest_version"
            class="mkt-unavailable"
          >
            {{
              $t('settings.extensions.marketplace.unavailableDetail', {
                version: detail.latest_version,
                host: detail.host_target,
                targets: latestTargets,
              })
            }}
          </p>
        </header>

        <section class="mkt-block">
          <h4>{{ $t('settings.extensions.marketplace.permissions') }}</h4>
          <ul v-if="latestVersionInfo?.capabilities.length" class="mkt-caps">
            <li
              v-for="cap in latestVersionInfo.capabilities"
              :key="cap"
              class="mkt-cap"
              :class="{ 'mkt-cap--sensitive': latestVersionInfo.sensitive_capabilities.includes(cap) }"
            >
              <code>{{ cap }}</code>
              <span v-if="latestVersionInfo.sensitive_capabilities.includes(cap)" class="mkt-badge mkt-badge--warn">
                {{ $t('settings.extensions.sensitive') }}
              </span>
            </li>
          </ul>
          <p v-else class="nv-hint">{{ $t('settings.extensions.marketplace.noPermissions') }}</p>
        </section>

        <section class="mkt-block">
          <h4>{{ $t('settings.extensions.marketplace.readme') }}</h4>
          <div v-if="readmeLines.length" class="mkt-readme">
            <template v-for="(line, i) in readmeLines" :key="i">
              <pre v-if="line.kind === 'codeblock'" class="mkt-code"><code>{{ line.text }}</code></pre>
              <component :is="line.level <= 2 ? 'h3' : 'h4'" v-else-if="line.kind === 'heading'" class="mkt-md-h">
                <InlineText :text="line.text" />
              </component>
              <div v-else-if="line.kind === 'bullet'" class="mkt-md-li">• <InlineText :text="line.text" /></div>
              <div v-else-if="line.kind === 'ordered'" class="mkt-md-li">{{ line.marker }} <InlineText :text="line.text" /></div>
              <blockquote v-else-if="line.kind === 'quote'" class="mkt-md-quote"><InlineText :text="line.text" /></blockquote>
              <p v-else-if="line.kind === 'paragraph'" class="mkt-md-p"><InlineText :text="line.text" /></p>
            </template>
          </div>
          <p v-else class="nv-hint mkt-no-readme">{{ $t('settings.extensions.marketplace.noReadme') }}</p>
        </section>

        <section class="mkt-block">
          <h4>{{ $t('settings.extensions.marketplace.versions') }}</h4>
          <table class="mkt-versions">
            <tbody>
              <tr
                v-for="v in detail.versions"
                :key="`${v.version}-${v.target}`"
                :class="{ 'mkt-yanked': v.yanked, 'mkt-other-target': !v.installable }"
              >
                <td><code>{{ v.version }}</code></td>
                <td class="mkt-muted">{{ formatDate(v.published_at) }}</td>
                <td class="mkt-muted">{{ v.target }}</td>
                <td class="mkt-muted">{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(v.download_count) }) }}</td>
                <td>
                  <span v-if="v.yanked" class="mkt-badge mkt-badge--warn">
                    {{ $t('settings.extensions.marketplace.yanked') }}
                  </span>
                  <span v-else-if="!v.installable" class="mkt-other-target-reason">
                    {{ $t('settings.extensions.marketplace.otherTarget', { target: v.target }) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </section>

    <!-- List view -->
    <section v-else class="ext-section" data-section="marketplace">
      <div class="ext-search">
        <input
          v-model="query"
          class="nv-input"
          :placeholder="$t('settings.extensions.searchPlaceholder')"
          @keyup.enter="search"
        />
        <select
          v-model="sort"
          class="nv-select mkt-sort"
          :aria-label="$t('settings.extensions.marketplace.sortLabel')"
          @change="search"
        >
          <option value="downloads">{{ $t('settings.extensions.marketplace.sort.downloads') }}</option>
          <option value="updated">{{ $t('settings.extensions.marketplace.sort.updated') }}</option>
          <option value="rating">{{ $t('settings.extensions.marketplace.sort.rating') }}</option>
        </select>
        <button class="nv-btn" :disabled="listState === 'loading'" @click="search">
          {{ $t('settings.extensions.search') }}
        </button>
      </div>

      <p v-if="listState === 'loading'" class="mkt-loading nv-loading">
        {{ $t('settings.extensions.marketplace.loading') }}
      </p>
      <div v-else-if="listState === 'error'" class="ext-error mkt-list-error" role="alert">
        <span>{{ $t('settings.extensions.marketplace.loadFailed', { error: listError }) }}</span>
        <button class="mkt-retry nv-btn nv-btn--sm" @click="search">
          {{ $t('settings.extensions.marketplace.retry') }}
        </button>
      </div>
      <p v-else-if="!results.length" class="mkt-empty nv-empty">
        {{
          query
            ? $t('settings.extensions.marketplace.noResults', { query })
            : $t('settings.extensions.marketplace.noExtensions')
        }}
      </p>
      <ul v-else class="ext-list">
        <li
          v-for="ext in results"
          :key="ext.identity"
          class="ext-result"
          :data-id="ext.identity"
          tabindex="0"
          @click="openDetail(ext)"
          @keydown.enter.self="openDetail(ext)"
        >
          <div class="mkt-card-main">
            <div class="mkt-card-title">
              <span class="ext-id">{{ ext.display_name || ext.name }}</span>
              <span v-if="ext.latest_version" class="mkt-muted">{{ ext.latest_version }}</span>
              <span
                v-if="updatesById.get(ext.identity)"
                class="mkt-badge mkt-badge--accent ext-update-badge"
              >
                {{ $t('settings.extensions.marketplace.updateAvailable') }}
              </span>
              <span v-else-if="installedById.get(ext.identity)" class="mkt-badge mkt-badge--ok ext-installed-badge">
                {{ $t('settings.extensions.marketplace.installedBadge') }}
              </span>
              <span v-else-if="ext.installable === false" class="mkt-badge mkt-badge--warn ext-unavailable-badge">
                {{ $t('settings.extensions.marketplace.unavailable') }}
              </span>
            </div>
            <div class="mkt-card-sub">
              <span class="ext-ns">{{ ext.namespace }}.{{ ext.name }}</span>
              <span class="mkt-muted">{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(ext.download_count) }) }}</span>
              <span v-if="ext.rating_average > 0" class="mkt-muted mkt-card-rating">★ {{ ext.rating_average.toFixed(1) }}</span>
            </div>
            <p v-if="ext.description" class="mkt-card-desc">{{ ext.description }}</p>
          </div>
          <button
            v-if="updatesById.get(ext.identity)"
            class="ext-update nv-btn nv-btn--primary nv-btn--sm"
            :disabled="flow.busy.value"
            @click.stop="flow.install(ext.namespace, ext.name, updatesById.get(ext.identity)?.latestVersion)"
          >
            {{ $t('settings.extensions.marketplace.update') }}
          </button>
          <button
            v-else-if="!installedById.get(ext.identity) && ext.installable !== false"
            class="ext-install nv-btn nv-btn--primary nv-btn--sm"
            :disabled="flow.busy.value"
            @click.stop="flow.install(ext.namespace, ext.name)"
          >
            {{ $t('settings.extensions.install') }}
          </button>
        </li>
      </ul>
    </section>

    <PluginTrustDialog
      v-if="flow.pendingConfirm.value"
      :pending="flow.pendingConfirm.value"
      :step="flow.pendingStep.value"
      @confirm-publisher="flow.confirmPublisher"
      @confirm-risk="flow.confirmRisk"
      @cancel="flow.cancel"
    />
  </div>
</template>

<style scoped>
.marketplace-pane {
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> the settings modal renders above it; the modal already reserves the
     gap below that title, so no top padding here. */
  padding: 0 22px 12px;
  font-size: var(--font-sm);
  color: var(--text-primary);
}
.ext-error {
  display: flex;
  align-items: center;
  gap: 10px;
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
.ext-search {
  display: flex;
  gap: 8px;
}
.ext-search .nv-input {
  flex: 1;
  min-width: 0;
}
.ext-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 0;
  display: grid;
  /* minmax(0, …): a nowrap description must truncate, not widen the track
     and push the Install button out of the page. */
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.ext-result {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.ext-result:hover,
.ext-result:focus-visible {
  border-color: var(--border-default);
  background: var(--bg-hover-faint);
  outline: none;
}
.mkt-card-main {
  flex: 1;
  min-width: 0;
}
.mkt-card-title,
.mkt-card-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mkt-card-sub {
  margin-top: 2px;
}
.mkt-card-desc {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ext-id {
  font-weight: 600;
  color: var(--text-bright);
}
.ext-ns,
.mkt-muted {
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.mkt-badge {
  display: inline-block;
  font-size: var(--font-2xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
}
.mkt-badge--ok {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.mkt-badge--warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.mkt-badge--accent {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}

.ext-error > span {
  flex: 1;
  min-width: 0;
}
.mkt-retry {
  flex-shrink: 0;
}

/* Detail view */
.mkt-back {
  margin-bottom: 10px;
}
.mkt-detail-head {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-muted);
}
.mkt-detail-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.mkt-detail-title h3 {
  margin: 0;
  color: var(--text-bright);
  font-size: var(--font-lg);
}
.mkt-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.mkt-desc {
  margin: 8px 0 0;
}
.mkt-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.mkt-tag {
  padding: 1px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.mkt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.mkt-block {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-muted);
}
.mkt-block h4 {
  margin: 0 0 8px;
  color: var(--text-bright);
  font-size: var(--font-md);
}
.mkt-caps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 4px;
}
.mkt-cap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mkt-readme {
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.mkt-md-h {
  margin: 12px 0 6px;
  color: var(--text-bright);
}
.mkt-md-p {
  margin: 4px 0;
}
.mkt-md-li {
  margin: 2px 0 2px 8px;
}
.mkt-md-quote {
  margin: 4px 0;
  padding-left: 10px;
  border-left: 3px solid var(--border-default);
  color: var(--text-secondary);
}
.mkt-readme :deep(a) {
  color: var(--accent-fg);
  text-decoration: none;
}
.mkt-readme :deep(a:hover) {
  text-decoration: underline;
}
.mkt-code,
.mkt-readme :deep(code),
.mkt-cap code,
.mkt-versions code {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
}
.mkt-code {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  overflow-x: auto;
}
.mkt-versions {
  width: 100%;
  border-collapse: collapse;
}
.mkt-versions td {
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border-muted);
}
.mkt-unavailable {
  margin: 8px 0 0;
  color: var(--attention-fg);
  font-size: var(--font-xs);
}
.mkt-other-target td {
  opacity: 0.55;
}
.mkt-other-target-reason {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.mkt-yanked code {
  text-decoration: line-through;
  color: var(--text-muted);
}
</style>
