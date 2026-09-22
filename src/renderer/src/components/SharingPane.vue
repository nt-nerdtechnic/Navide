<script setup lang="ts">
/**
 * Sharing: the two questions people ask about the four INTEGRATIONS scopes
 * that the per-scope panes cannot answer — "how do I hand this to someone"
 * and "what is actually up there, and which machine put it there".
 *
 * Its own tab rather than a fifth card inside MCP/Skills/Prompts/Memory: both
 * questions are asked once about all four at a time, and answering them in
 * four places is how the copy in one of them goes stale.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import SharingBundleSection from './sharing/SharingBundleSection.vue'
import SharingCloudSection from './sharing/SharingCloudSection.vue'

type Backend = ReturnType<typeof useBackend>

defineProps<{ backend: Backend }>()
const { t } = useI18n()

const bundleAnchor = ref<HTMLElement | null>(null)

/** The offline cloud state sends people here; it is the surface that works. */
function revealBundle(): void {
  bundleAnchor.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="sharing-pane">
    <p class="sharing-intro">{{ t('settings.sharing.intro') }}</p>
    <div ref="bundleAnchor">
      <SharingBundleSection :backend="backend" />
    </div>
    <SharingCloudSection :backend="backend" @go-to-bundle="revealBundle" />
  </div>
</template>

<style scoped>
/* The tab body is a full-bleed column (overflow:hidden, no gutter), so the
   pane carries its own scroll and the 22px inset its page title uses. */
.sharing-pane {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 22px 18px;
}
.sharing-intro {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0;
}
</style>
