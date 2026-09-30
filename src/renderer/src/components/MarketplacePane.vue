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
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { InlineText, renderLines } from '../editor/markdownRender'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import PluginTrustDialog from './PluginTrustDialog.vue'
import MarketplaceIcon from './MarketplaceIcon.vue'
import PackInstallDialog from './PackInstallDialog.vue'
import { usePackInstallFlow } from '../composables/usePackInstallFlow'
import { useConfirmedExternalLink } from '../composables/useConfirmedExternalLink'
import { marketplaceDetailRequest, takeMarketplaceDetailRequest } from '../marketplaceDeepLink'

type Sort = 'downloads' | 'updated' | 'rating'

// Installing writes to the inventory the Extensions page renders, so it goes
// through the shared store rather than a list of this pane's own.
const inventory = usePluginInventory()
const pluginUpdates = usePluginUpdates()
const flow = usePluginInstallFlow()
const packFlow = usePackInstallFlow()
const { locale, t, te } = useI18n()
const openLink = useConfirmedExternalLink()
const numberFormat = computed(() => new Intl.NumberFormat(locale.value))
function formatCount(value: number): string {
  return numberFormat.value.format(value)
}

function pluginsApi() {
  return window.agentTeam?.plugins
}

const PAGE_SIZE = 20

const results = ref<MarketplaceExtension[]>([])
const total = ref(0)
const query = ref('')
const sort = ref<Sort>('downloads')
const listState = ref<'loading' | 'ready' | 'error'>('loading')
const listError = ref('')
const loadingMore = ref(false)
const loadMoreError = ref('')
// The Registry's closed category list; empty (no chips) when it has none.
const categories = ref<MarketplaceCategory[]>([])
const category = ref('')
const hideIncompatible = ref(false)

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

function searchOptions(offset: number) {
  return {
    ...(category.value ? { category: category.value } : {}),
    offset,
    limit: PAGE_SIZE,
    hideIncompatible: hideIncompatible.value,
  }
}

// A failed search shows the error, never the previous page's results: the
// listing (and its compatibility verdicts) may be stale.
async function search(): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  listState.value = 'loading'
  listError.value = ''
  loadMoreError.value = ''
  try {
    const res = await api.marketplaceSearch(query.value || undefined, sort.value, searchOptions(0))
    results.value = res.items
    total.value = res.total
    listState.value = 'ready'
  } catch (err) {
    results.value = []
    total.value = 0
    listError.value = ipcErrorMessage(err)
    listState.value = 'error'
  }
}

async function loadMore(): Promise<void> {
  const api = pluginsApi()
  if (!api || loadingMore.value) return
  loadingMore.value = true
  loadMoreError.value = ''
  try {
    const res = await api.marketplaceSearch(
      query.value || undefined,
      sort.value,
      searchOptions(results.value.length)
    )
    // Skip rows already shown: the ranking may shift between pages.
    const seen = new Set(results.value.map((ext) => ext.identity))
    results.value = [...results.value, ...res.items.filter((ext) => !seen.has(ext.identity))]
    total.value = res.total
  } catch (err) {
    loadMoreError.value = ipcErrorMessage(err)
  } finally {
    loadingMore.value = false
  }
}

async function loadCategories(): Promise<void> {
  const api = pluginsApi()
  if (!api?.marketplaceCategories) return
  try {
    categories.value = await api.marketplaceCategories()
  } catch {
    categories.value = []
  }
}

function selectCategory(slug: string): void {
  if (category.value === slug) return
  category.value = slug
  void search()
}

function categoryLabel(item: Pick<MarketplaceCategory, 'slug' | 'label'>): string {
  const key = `settings.extensions.marketplace.category.${item.slug}`
  return te(key) ? t(key) : item.label
}

function isIncompatible(ext: { compatible?: boolean | null }): boolean {
  return ext.compatible === false
}

async function openDetail(ext: MarketplaceExtension): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  selected.value = ext
  detail.value = null
  detailState.value = 'loading'
  detailError.value = ''
  showCompatibleOnly.value = false
  changelog.value = null
  changelogState.value = 'idle'
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
// The Registry's latest version has no artifact for this Host. A different
// install candidate alone does not mean that: with "Get pre-releases" on, the
// candidate is a newer pre-release while the latest stable is still installable.
const latestUnavailable = computed(() => {
  const d = detail.value
  if (!d?.latest_version) return false
  return !d.versions.some((v) => v.version === d.latest_version && v.installable && !v.yanked)
})
const latestTargets = computed(() => {
  const d = detail.value
  if (!d) return ''
  return d.versions
    .filter((v) => v.version === d.latest_version && !v.yanked)
    .map((v) => v.target)
    .join(', ')
})

// D1: an incompatible latest version is shown with Install disabled; the
// banner offers the older versions this Navide release can run.
const latestIncompatible = computed(() => installableVersionInfo.value?.compatible === false)
const showCompatibleOnly = ref(false)
const shownVersions = computed(() => {
  const rows = detail.value?.versions ?? []
  return showCompatibleOnly.value
    ? rows.filter((v) => v.installable && !v.yanked && v.compatible !== false)
    : rows
})
// "Works with" describes one version: the one Install would install, else the
// Registry's latest. Its platforms and its minimum Navide version, so neither
// mixes in what only an older version supports.
const worksWithVersion = computed(() => installableVersionInfo.value?.version ?? detail.value?.latest_version ?? null)
const worksWithRows = computed(() =>
  (detail.value?.versions ?? []).filter((v) => v.version === worksWithVersion.value && !v.yanked)
)
const worksWithTargets = computed(() => [...new Set(worksWithRows.value.map((v) => v.target))].sort())
const worksWithMinNavide = computed(() => worksWithRows.value.find((v) => v.min_navide_version)?.min_navide_version ?? null)

// D2 header note: with the switch on and a newer pre-release as the install
// candidate, say so next to the stable version the header keeps showing.
const prereleaseCandidate = computed(() => {
  const info = installableVersionInfo.value
  return detail.value?.gets_prereleases && info?.channel === 'pre-release' ? info.version : null
})

const changelog = ref<string | null>(null)
const changelogState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const changelogLines = computed(() => (changelog.value ? renderLines(changelog.value) : []))
// D2: the "Get pre-releases" switch for this extension. The main process
// answers the detail with its install candidates already honouring it, so the
// detail is re-read after a change.
const hasPrereleases = computed(() => (detail.value?.versions ?? []).some((v) => v.channel === 'pre-release'))
const prereleaseBusy = ref(false)
async function setPrerelease(enabled: boolean): Promise<void> {
  const api = pluginsApi()
  const current = selected.value
  const d = detail.value
  if (!api?.setPrerelease || !current || !d) return
  prereleaseBusy.value = true
  try {
    await api.setPrerelease(idOf(d), enabled)
    const next = await api.marketplaceDetail({ namespace: d.namespace, name: d.name })
    if (selected.value === current) detail.value = next
    void inventory.refresh()
    void pluginUpdates.refresh()
  } catch (err) {
    detailError.value = ipcErrorMessage(err)
  } finally {
    prereleaseBusy.value = false
  }
}

// Extension Pack detail: each member's name, version and permissions, shown
// before anything is installed (display only; each member is verified on its
// own when the pack is installed).
// One label for a permission chip everywhere (pack detail, permissions, the
// pack install dialog): "fs · sensitive" for a sensitive one, else "ui".
function capLabel(cap: string, sensitive: boolean): string {
  return sensitive ? `${cap} · ${t('settings.extensions.sensitive')}` : cap
}

function isPack(ext: { extension_pack?: string[] | null }): boolean {
  return Array.isArray(ext.extension_pack) && ext.extension_pack.length > 0
}
const packMembers = ref<PackMemberSummary[]>([])
watch(detail, async (d) => {
  packMembers.value = []
  const api = pluginsApi()
  if (!d || !isPack(d) || !api?.marketplacePackMembers) return
  try {
    const members = await api.marketplacePackMembers(d.extension_pack ?? [])
    if (detail.value === d) packMembers.value = members
  } catch {
    packMembers.value = []
  }
})

async function toggleChangelog(): Promise<void> {
  const api = pluginsApi()
  const d = detail.value
  if (!api?.marketplaceChangelog || !d) return
  if (changelogState.value !== 'idle' && changelogState.value !== 'error') {
    changelogState.value = 'idle'
    return
  }
  changelogState.value = 'loading'
  try {
    changelog.value = await api.marketplaceChangelog({ namespace: d.namespace, name: d.name })
    changelogState.value = 'ready'
  } catch {
    changelogState.value = 'error'
  }
}

const readmeLines = computed(() => (detail.value?.readme ? renderLines(detail.value.readme) : []))

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

onMounted(() => {
  void inventory.refresh()
  void pluginUpdates.refresh()
  void loadCategories()
  void search()
})

// A navide://extension/<id> link (App.vue) names an extension to show. It only
// opens the ordinary detail page: Install stays the user's own press (D4).
watch(
  marketplaceDetailRequest,
  (request) => {
    if (!request) return
    const target = takeMarketplaceDetailRequest()
    if (target) void openDetail(target as MarketplaceExtension)
  },
  { immediate: true }
)
</script>

<template>
  <div class="marketplace-pane">
    <p v-if="flow.error.value" class="ext-error" role="alert">{{ flow.error.value }}</p>
    <p v-if="packFlow.error.value" class="ext-error mkt-pack-error" role="alert">{{ packFlow.error.value }}</p>

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
            <MarketplaceIcon
              :namespace="detail.namespace"
              :name="detail.name"
              :label="detail.display_name || detail.name"
              :version="detail.latest_version"
              :path="detail.icon_path"
              :size="48"
            />
            <h3>{{ detail.display_name || detail.name }}</h3>
            <span class="mkt-muted">{{ idOf(detail) }}</span>
            <span v-if="isPack(detail)" class="mkt-badge mkt-badge--accent mkt-pack-badge">
              {{ $t('settings.extensions.pack.badge') }}
            </span>
          </div>
          <div class="mkt-meta">
            <span>{{ $t('settings.extensions.marketplace.publisher') }}: <strong>{{ detail.publisher }}</strong></span>
            <span v-if="detail.latest_version">{{ $t('settings.extensions.marketplace.versionLabel', { version: detail.latest_version }) }}</span>
            <span v-if="prereleaseCandidate" class="mkt-badge mkt-badge--warn mkt-prerelease-note">
              {{ $t('settings.extensions.marketplace.prereleaseAvailable', { version: prereleaseCandidate }) }}
            </span>
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
          <div
            v-if="detail.repository || detail.homepage || detail.license || detail.has_changelog"
            class="mkt-links"
          >
            <a v-if="detail.repository" href="#" class="mkt-link" @click.prevent="openLink(detail.repository)">
              {{ $t('settings.extensions.marketplace.repository') }} ↗
            </a>
            <a v-if="detail.homepage" href="#" class="mkt-link" @click.prevent="openLink(detail.homepage)">
              {{ $t('settings.extensions.marketplace.homepage') }} ↗
            </a>
            <span v-if="detail.license" class="mkt-muted mkt-license">
              {{ $t('settings.extensions.marketplace.license', { license: detail.license }) }}
            </span>
            <button
              v-if="detail.has_changelog"
              class="mkt-link mkt-changelog-toggle nv-btn nv-btn--ghost nv-btn--sm"
              :aria-expanded="changelogState === 'ready'"
              @click="toggleChangelog"
            >
              {{ $t('settings.extensions.marketplace.changelog') }}
            </button>
          </div>
          <p v-if="detail.description" class="mkt-desc">{{ detail.description }}</p>
          <div v-if="detail.categories.length" class="mkt-tags">
            <span v-for="c in detail.categories" :key="c" class="mkt-tag">{{ categoryLabel({ slug: c, label: c }) }}</span>
          </div>
          <div class="mkt-actions">
            <button
              v-if="isPack(detail)"
              class="mkt-pack-install nv-btn nv-btn--primary"
              :disabled="packFlow.busy.value || flow.busy.value"
              @click="packFlow.start(detail.namespace, detail.name)"
            >
              {{ $t('settings.extensions.pack.install', { count: detail.extension_pack?.length ?? 0 }) }}
            </button>
            <template v-else-if="installedById.get(idOf(detail))">
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
              :disabled="flow.busy.value || latestIncompatible"
              @click="flow.install(detail.namespace, detail.name, installableVersionInfo.version)"
            >
              <!-- Name the version when it is not the one the header shows, and
                   say so when it is a pre-release. -->
              {{
                installableVersionInfo.channel === 'pre-release'
                  ? $t('settings.extensions.marketplace.installPrerelease', { version: installableVersionInfo.version })
                  : installableVersionInfo.version === detail.latest_version
                    ? $t('settings.extensions.install')
                    : $t('settings.extensions.marketplace.installVersion', { version: installableVersionInfo.version })
              }}
            </button>
            <label v-if="hasPrereleases" class="mkt-prerelease-toggle">
              <input
                type="checkbox"
                :checked="detail.gets_prereleases === true"
                :disabled="prereleaseBusy || flow.busy.value"
                @change="setPrerelease(($event.target as HTMLInputElement).checked)"
              />
              {{ $t('settings.extensions.getPrereleases') }}
            </label>
          </div>
          <p
            v-if="latestUnavailable"
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
          <div v-if="latestIncompatible && installableVersionInfo" class="mkt-incompatible-banner" role="alert">
            <span>
              {{
                $t('settings.extensions.marketplace.incompatibleDetail', {
                  version: installableVersionInfo.version,
                  min: installableVersionInfo.min_navide_version ?? '',
                  current: detail.app_version ?? '',
                })
              }}
              <template v-if="detail.latest_compatible_version">
                {{ $t('settings.extensions.marketplace.olderCompatible', { version: detail.latest_compatible_version }) }}
              </template>
            </span>
            <button
              v-if="detail.latest_compatible_version && !showCompatibleOnly"
              class="mkt-show-compatible nv-btn nv-btn--sm"
              @click="showCompatibleOnly = true"
            >
              {{ $t('settings.extensions.marketplace.showCompatible') }}
            </button>
          </div>
        </header>

        <section v-if="changelogState !== 'idle'" class="mkt-block mkt-changelog">
          <h4>{{ $t('settings.extensions.marketplace.changelog') }}</h4>
          <p v-if="changelogState === 'loading'" class="nv-loading">{{ $t('settings.extensions.marketplace.loadingDetail') }}</p>
          <p v-else-if="changelogState === 'error'" class="ext-error">{{ $t('settings.extensions.marketplace.changelogFailed') }}</p>
          <div v-else-if="changelogLines.length" class="mkt-readme">
            <template v-for="(line, i) in changelogLines" :key="i">
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
          <p v-else class="nv-hint">{{ $t('settings.extensions.marketplace.noChangelog') }}</p>
        </section>

        <section class="mkt-block mkt-works-with">
          <h4>
            {{ $t('settings.extensions.marketplace.worksWith') }}
            <span v-if="worksWithVersion" class="mkt-muted mkt-works-with-version">
              {{ $t('settings.extensions.marketplace.versionLabel', { version: worksWithVersion }) }}
            </span>
          </h4>
          <div class="mkt-tags">
            <span v-for="target in worksWithTargets" :key="target" class="mkt-tag mkt-platform">
              {{ target === 'universal' ? $t('settings.extensions.marketplace.allPlatforms') : target }}
            </span>
            <span v-if="worksWithMinNavide" class="mkt-tag mkt-min-navide">
              {{ $t('settings.extensions.marketplace.navideAtLeast', { version: worksWithMinNavide }) }}
            </span>
          </div>
        </section>

        <section v-if="isPack(detail)" class="mkt-block mkt-pack-members">
          <h4>{{ $t('settings.extensions.pack.membersTitle') }}</h4>
          <ul class="mkt-pack-list">
            <li
              v-for="m in packMembers"
              :key="m.id"
              class="mkt-pack-member"
              :data-member="m.id"
            >
              <MarketplaceIcon
                :namespace="m.id.slice(0, m.id.indexOf('.'))"
                :name="m.id.slice(m.id.indexOf('.') + 1)"
                :label="m.display_name || m.id"
                :size="28"
              />
              <div class="mkt-pack-member-main">
                <span class="mkt-pack-member-name" :title="m.display_name || m.id">{{ m.display_name || m.id }}</span>
                <span class="mkt-muted mkt-pack-member-id" :title="m.version ? `${m.id} · ${m.version}` : m.id">
                  {{ m.version ? `${m.id} · ${m.version}` : m.id }}
                </span>
              </div>
              <div class="mkt-pack-member-caps">
                <span
                  v-for="cap in m.capabilities"
                  :key="cap"
                  class="mkt-pack-cap"
                  :class="{ 'mkt-pack-cap--sensitive': m.sensitive_capabilities.includes(cap) }"
                >
                  {{ capLabel(cap, m.sensitive_capabilities.includes(cap)) }}
                </span>
              </div>
              <span
                v-if="m.status !== 'ready'"
                class="mkt-badge mkt-pack-status"
                :class="m.status === 'installed' ? 'mkt-badge--ok' : 'mkt-badge--muted'"
              >
                {{ $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' }) }}
              </span>
            </li>
          </ul>
          <p class="nv-hint">{{ $t('settings.extensions.pack.membersNote') }}</p>
        </section>

        <section class="mkt-block">
          <h4>{{ $t('settings.extensions.marketplace.permissions') }}</h4>
          <ul v-if="latestVersionInfo?.capabilities.length" class="mkt-caps">
            <li
              v-for="cap in latestVersionInfo.capabilities"
              :key="cap"
              class="mkt-cap mkt-pack-cap"
              :class="{
                'mkt-cap--sensitive mkt-pack-cap--sensitive': latestVersionInfo.sensitive_capabilities.includes(cap),
              }"
            >
              {{ capLabel(cap, latestVersionInfo.sensitive_capabilities.includes(cap)) }}
            </li>
          </ul>
          <p v-else class="nv-hint mkt-no-permissions">
            {{
              isPack(detail)
                ? $t('settings.extensions.pack.noPermissionsOfItsOwn')
                : $t('settings.extensions.marketplace.noPermissions')
            }}
          </p>
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
          <button
            v-if="showCompatibleOnly"
            class="mkt-show-all nv-btn nv-btn--ghost nv-btn--sm"
            @click="showCompatibleOnly = false"
          >
            {{ $t('settings.extensions.marketplace.showAllVersions') }}
          </button>
          <table class="mkt-versions">
            <thead>
              <tr>
                <th>{{ $t('settings.extensions.marketplace.column.version') }}</th>
                <th>{{ $t('settings.extensions.marketplace.column.published') }}</th>
                <th>{{ $t('settings.extensions.marketplace.column.target') }}</th>
                <th>{{ $t('settings.extensions.marketplace.column.channel') }}</th>
                <th>{{ $t('settings.extensions.marketplace.column.downloads') }}</th>
                <th>{{ $t('settings.extensions.marketplace.column.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="v in shownVersions"
                :key="`${v.version}-${v.target}`"
                :class="{ 'mkt-yanked': v.yanked, 'mkt-other-target': !v.installable || v.compatible === false }"
              >
                <td><code>{{ v.version }}</code></td>
                <td class="mkt-muted">{{ formatDate(v.published_at) }}</td>
                <td class="mkt-muted">{{ v.target }}</td>
                <td>
                  <span v-if="v.channel === 'pre-release'" class="mkt-badge mkt-badge--warn mkt-channel-pre">
                    {{ $t('settings.extensions.marketplace.channelPrerelease') }}
                  </span>
                  <span v-else class="mkt-muted mkt-channel-stable">
                    {{ $t('settings.extensions.marketplace.channelStable') }}
                  </span>
                </td>
                <td class="mkt-muted">{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(v.download_count) }) }}</td>
                <td>
                  <span v-if="v.yanked" class="mkt-badge mkt-badge--warn">
                    {{ $t('settings.extensions.marketplace.yanked') }}
                  </span>
                  <span v-else-if="!v.installable" class="mkt-other-target-reason">
                    {{ $t('settings.extensions.marketplace.otherTarget', { target: v.target }) }}
                  </span>
                  <span v-else-if="v.compatible === false" class="mkt-other-target-reason mkt-row-incompatible">
                    {{ $t('settings.extensions.marketplace.requiresNavide', { version: v.min_navide_version ?? '' }) }}
                  </span>
                  <button
                    v-else-if="showCompatibleOnly && !installedById.get(idOf(detail))"
                    class="mkt-row-install nv-btn nv-btn--sm"
                    :disabled="flow.busy.value"
                    @click="flow.install(detail.namespace, detail.name, v.version)"
                  >
                    {{ $t('settings.extensions.marketplace.installVersion', { version: v.version }) }}
                  </button>
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
      <div class="mkt-filters">
        <div v-if="categories.length" class="mkt-chips" role="group" :aria-label="$t('settings.extensions.marketplace.categoryLabel')">
          <button
            class="mkt-chip"
            :class="{ 'mkt-chip--active': category === '' }"
            :aria-pressed="category === ''"
            @click="selectCategory('')"
          >
            {{ $t('settings.extensions.marketplace.category.all') }}
          </button>
          <button
            v-for="c in categories"
            :key="c.slug"
            class="mkt-chip"
            :class="{ 'mkt-chip--active': category === c.slug }"
            :aria-pressed="category === c.slug"
            :data-category="c.slug"
            @click="selectCategory(c.slug)"
          >
            {{ categoryLabel(c) }}
          </button>
        </div>
        <label class="mkt-hide-incompatible">
          <input v-model="hideIncompatible" type="checkbox" @change="search" />
          {{ $t('settings.extensions.marketplace.hideIncompatible') }}
        </label>
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
          :class="{ 'ext-result--incompatible': isIncompatible(ext) }"
          :data-id="ext.identity"
          tabindex="0"
          @click="openDetail(ext)"
          @keydown.enter.self="openDetail(ext)"
        >
          <MarketplaceIcon
            :namespace="ext.namespace"
            :name="ext.name"
            :label="ext.display_name || ext.name"
            :version="ext.latest_version"
            :path="ext.icon_path"
          />
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
              <span v-if="isPack(ext)" class="mkt-badge mkt-badge--accent mkt-pack-badge">
                {{ $t('settings.extensions.pack.badge') }}
              </span>
              <span v-if="ext.trust_tier === 'signed-verified'" class="mkt-badge mkt-badge--ok ext-signed-badge">
                ✓ {{ $t('settings.extensions.marketplace.signedShort') }}
              </span>
              <span v-if="isIncompatible(ext)" class="mkt-badge mkt-badge--danger ext-incompatible-badge">
                {{ $t('settings.extensions.marketplace.requiresNavide', { version: ext.min_navide_version ?? '' }) }}
              </span>
              <span
                v-else-if="ext.compatible === true && ext.installable !== false"
                class="mkt-badge mkt-badge--ok ext-compatible-badge"
              >
                {{ $t('settings.extensions.marketplace.compatibleWith', { version: ext.app_version ?? '' }) }}
              </span>
            </div>
            <div class="mkt-card-sub">
              <span class="ext-ns">{{ ext.namespace }}.{{ ext.name }}</span>
              <span class="mkt-muted">{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(ext.download_count) }) }}</span>
              <span v-if="ext.rating_average > 0" class="mkt-muted mkt-card-rating">★ {{ ext.rating_average.toFixed(1) }}</span>
            </div>
            <p v-if="isIncompatible(ext)" class="mkt-card-incompatible">
              {{ $t('settings.extensions.marketplace.updateNavideToInstall', { current: ext.app_version ?? '' }) }}
            </p>
            <p v-if="ext.description" class="mkt-card-desc">{{ ext.description }}</p>
            <div v-if="ext.repository || ext.license" class="mkt-card-links">
              <a v-if="ext.repository" href="#" class="mkt-link" @click.stop.prevent="openLink(ext.repository)">
                {{ $t('settings.extensions.marketplace.repository') }} ↗
              </a>
              <span v-if="ext.license" class="mkt-muted">{{ ext.license }}</span>
            </div>
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
            v-else-if="isPack(ext)"
            class="mkt-pack-install nv-btn nv-btn--primary nv-btn--sm"
            :disabled="packFlow.busy.value || flow.busy.value || isIncompatible(ext)"
            @click.stop="packFlow.start(ext.namespace, ext.name)"
          >
            {{ $t('settings.extensions.pack.install', { count: ext.extension_pack?.length ?? 0 }) }}
          </button>
          <button
            v-else-if="!installedById.get(ext.identity) && ext.installable !== false"
            class="ext-install nv-btn nv-btn--primary nv-btn--sm"
            :disabled="flow.busy.value || isIncompatible(ext)"
            @click.stop="flow.install(ext.namespace, ext.name)"
          >
            {{ $t('settings.extensions.install') }}
          </button>
        </li>
      </ul>
      <div v-if="listState === 'ready' && results.length" class="mkt-load-more">
        <button
          v-if="results.length < total"
          class="mkt-load-more-btn nv-btn nv-btn--sm"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ $t('settings.extensions.marketplace.loadMore') }}
        </button>
        <span class="mkt-muted mkt-showing">
          {{ $t('settings.extensions.marketplace.showing', { shown: results.length, total }) }}
        </span>
        <span v-if="loadMoreError" class="ext-error mkt-load-more-error" role="alert">
          {{ $t('settings.extensions.marketplace.loadFailed', { error: loadMoreError }) }}
        </span>
      </div>
    </section>

    <PluginTrustDialog
      v-if="flow.pendingConfirm.value"
      :pending="flow.pendingConfirm.value"
      :step="flow.pendingStep.value"
      @confirm-publisher="flow.confirmPublisher"
      @confirm-risk="flow.confirmRisk"
      @cancel="flow.cancel"
    />
    <PackInstallDialog :flow="packFlow" />
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
  align-items: center;
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
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
.mkt-versions th {
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  text-align: left;
}
.mkt-show-all {
  margin-bottom: 6px;
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
.mkt-badge--muted {
  color: var(--text-secondary);
  background: var(--bg-muted);
}
.mkt-pack-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 6px;
}
.mkt-pack-member {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.mkt-pack-member-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mkt-pack-member-name {
  font-weight: 600;
  color: var(--text-bright);
}
/* An id or version never breaks mid-token: one line, ellipsis, full value in
   the tooltip. */
.mkt-pack-member-name,
.mkt-pack-member-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mkt-pack-member-caps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
/* Same chips as the pack install dialog: every permission is a chip, and only
   the sensitive ones are highlighted. */
.mkt-pack-cap {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  background: var(--bg-muted);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
.mkt-pack-cap--sensitive {
  color: var(--attention-fg);
  background: var(--attention-subtle);
  font-weight: 600;
}
.mkt-badge--danger {
  color: var(--danger-bright);
  background: var(--danger-subtle);
}
.ext-result--incompatible .mkt-card-main,
.ext-result--incompatible :deep(.mkt-icon) {
  opacity: 0.6;
}
.mkt-card-incompatible {
  margin: 4px 0 0;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.mkt-card-links,
.mkt-links {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: var(--font-xs);
}
.mkt-links {
  margin-top: 8px;
}
.mkt-link {
  color: var(--accent-fg);
  text-decoration: none;
}
.mkt-link:hover {
  text-decoration: underline;
}
.mkt-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.mkt-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mkt-chip {
  padding: 2px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.mkt-chip--active {
  border-color: var(--accent-fg);
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
.mkt-prerelease-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.mkt-works-with-version {
  margin-left: 6px;
  font-weight: 400;
}
.mkt-hide-incompatible {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.mkt-load-more {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.mkt-incompatible-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-sm);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.mkt-incompatible-banner > span {
  flex: 1;
  min-width: 0;
}
.mkt-yanked code {
  text-decoration: line-through;
  color: var(--text-muted);
}
</style>
