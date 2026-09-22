<script setup lang="ts">
// Marketplace view: searches the registry and installs an extension. Split out
// of ExtensionsPane so the Extensions page can carry the execution policy and
// the local inventory, while browsing and installing lives on its own page.
//
// Sensitive capabilities, an unknown publisher and native backend executables
// trigger the confirmation dialog after verification but before the package is
// written. All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { ref } from 'vue'
import { usePluginInventory } from '../composables/usePluginInventory'

// Installing writes to the inventory the Extensions page renders, so it goes
// through the shared store rather than a list of this pane's own.
const inventory = usePluginInventory()

function pluginsApi() {
  return window.agentTeam?.plugins
}

const results = ref<MarketplaceExtension[]>([])
const query = ref('')
const busy = ref(false)
const error = ref('')
// A prepared, verified install awaiting the existing install-risk confirmation.
const pendingConfirm = ref<{ ext: MarketplaceExtension; prepared: PreparedInstallSummary } | null>(
  null
)
const pendingStep = ref<'publisher' | 'risk' | null>(null)
const publisherConfirmed = ref(false)

async function search(): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    const res = await api.marketplaceSearch(query.value || undefined)
    results.value = res.items
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function install(ext: MarketplaceExtension): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    const prepared = await api.prepareInstall({ namespace: ext.namespace, name: ext.name })
    const requiresPublisherTrust = prepared.requiresPublisherTrust === true
    const requiresRiskConfirmation =
      prepared.requiresRiskConfirmation ?? prepared.requiresConfirmation
    if (requiresPublisherTrust || requiresRiskConfirmation) {
      // Hold for the trust dialog — nothing is written until the user confirms.
      pendingConfirm.value = { ext, prepared }
      pendingStep.value = requiresPublisherTrust ? 'publisher' : 'risk'
      publisherConfirmed.value = false
      return
    }
    await commit(prepared.id, {})
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function commit(
  id: string,
  approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean }
): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  await api.commitInstall(id, approval)
  pendingConfirm.value = null
  pendingStep.value = null
  await inventory.refresh()
}

async function confirmPublisher(): Promise<void> {
  if (!pendingConfirm.value) return
  publisherConfirmed.value = true
  if (
    pendingConfirm.value.prepared.requiresRiskConfirmation ??
    pendingConfirm.value.prepared.requiresConfirmation
  ) {
    pendingStep.value = 'risk'
    return
  }
  busy.value = true
  try {
    await commit(pendingConfirm.value.prepared.id, { publisherConfirmed: true })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function confirmRisk(): Promise<void> {
  if (!pendingConfirm.value) return
  busy.value = true
  try {
    await commit(pendingConfirm.value.prepared.id, {
      publisherConfirmed: publisherConfirmed.value,
      riskConfirmed: true,
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function cancelInstall(): void {
  pendingConfirm.value = null
  pendingStep.value = null
  publisherConfirmed.value = false
}
</script>

<template>
  <div class="marketplace-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>

    <section class="ext-section" data-section="marketplace">
      <div class="ext-search">
        <input
          v-model="query"
          :placeholder="$t('settings.extensions.searchPlaceholder')"
          @keyup.enter="search"
        />
        <button :disabled="busy" @click="search">{{ $t('settings.extensions.search') }}</button>
      </div>
      <ul class="ext-list">
        <li v-for="ext in results" :key="ext.identity" class="ext-result" :data-id="ext.identity">
          <span class="ext-id">{{ ext.display_name || ext.name }}</span>
          <span class="ext-ns">{{ ext.namespace }}.{{ ext.name }}</span>
          <button class="ext-install" :disabled="busy" @click="install(ext)">
            {{ $t('settings.extensions.install') }}
          </button>
        </li>
      </ul>
    </section>

    <div v-if="pendingConfirm" class="ext-trust-dialog" role="dialog" aria-modal="true">
      <div class="ext-trust-body">
        <h4 v-if="pendingStep === 'publisher'">{{ $t('settings.extensions.trust.publisherTitle') }}</h4>
        <h4 v-else>{{ $t('settings.extensions.trust.permissionsTitle') }}</h4>
        <p v-if="pendingStep === 'publisher'" class="ext-publisher-risk">
          {{
            $t('settings.extensions.trust.publisherRisk', {
              publisher: pendingConfirm.prepared.publisherId,
              id: pendingConfirm.prepared.id,
            })
          }}
        </p>
        <p
          v-if="pendingStep === 'risk' && pendingConfirm.prepared.containsBackendExecutable"
          class="ext-backend-risk"
        >
          {{
            $t('settings.extensions.trust.backendRisk', {
              name: `${pendingConfirm.ext.namespace}.${pendingConfirm.ext.name}`,
            })
          }}
        </p>
        <p v-if="pendingStep === 'risk' && pendingConfirm.prepared.sensitive.length">
          {{
            $t('settings.extensions.trust.sensitiveRisk', {
              name: `${pendingConfirm.ext.namespace}.${pendingConfirm.ext.name}`,
              capabilities: pendingConfirm.prepared.sensitive.join(', '),
            })
          }}
        </p>
        <p class="ext-trust-tier">
          <span
            v-if="pendingConfirm.prepared.trustTier === 'signed-verified'"
            class="ext-trust-badge ext-verified"
          >
            {{ $t('settings.extensions.trust.signed') }}
          </span>
          <span v-else class="ext-trust-badge ext-unsigned">
            {{ $t('settings.extensions.trust.unsigned') }}
          </span>
        </p>
        <div class="ext-trust-actions">
          <button v-if="pendingStep === 'publisher'" class="ext-confirm-publisher" @click="confirmPublisher">
            {{ $t('settings.extensions.trust.confirmPublisher') }}
          </button>
          <button v-else class="ext-confirm-risk" @click="confirmRisk">
            {{ $t('settings.extensions.trust.confirmInstall') }}
          </button>
          <button class="ext-cancel" @click="cancelInstall">
            {{ $t('settings.extensions.trust.cancel') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.marketplace-pane {
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> the settings modal renders above it; the modal already reserves the
     gap below that title, so no top padding here. */
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
.ext-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-muted);
}
.ext-id {
  font-weight: 600;
}
.ext-ns {
  color: var(--text-muted, #888);
  font-size: var(--font-xs);
}
.ext-install {
  margin-left: auto;
}
.ext-search {
  display: flex;
  gap: 8px;
}
.ext-search input {
  flex: 1;
}
.ext-trust-dialog {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.ext-trust-body {
  background: var(--bg-color, #1c2028);
  padding: 20px 24px;
  border-radius: 8px;
  max-width: 400px;
}
.ext-trust-tier {
  color: var(--text-muted, #888);
}
.ext-trust-badge {
  display: inline-block;
  font-size: var(--font-2xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.ext-trust-badge.ext-verified {
  color: #1a7f37;
  background: rgba(26, 127, 55, 0.12);
}
.ext-trust-badge.ext-unsigned {
  color: #c77400;
  background: rgba(199, 116, 0, 0.12);
}
.ext-trust-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
/* These four buttons declare nothing of their own — they are native browser
 * buttons. Hover therefore darkens what the platform already painted instead
 * of replacing the fill: an overlay colour here would flip a light native
 * button to a dark one on hover, which is a bigger change than the missing
 * feedback it fixes. The search button is reached structurally because it has
 * no class of its own. */
.ext-install,
.ext-search button,
.ext-confirm-publisher,
.ext-confirm-risk,
.ext-cancel {
  transition: filter var(--motion-fast) var(--ease-out);
}
.ext-install:hover:not(:disabled),
.ext-search button:hover:not(:disabled),
.ext-confirm-publisher:hover:not(:disabled),
.ext-confirm-risk:hover:not(:disabled),
.ext-cancel:hover:not(:disabled) {
  filter: brightness(0.93);
}
</style>
