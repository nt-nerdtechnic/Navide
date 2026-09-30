<script setup lang="ts">
// D8: uninstalling an Extension Pack removes only the pack by default. The
// members that were installed only because of this pack are listed, each
// unchecked, so the user chooses whether any of them go too.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ pack: InstalledPackRecord; busy: boolean }>()
const emit = defineEmits<{ confirm: [members: string[]]; cancel: [] }>()

const chosen = ref<string[]>([])

// Esc cancels this dialog only; it must not reach the settings modal, which
// closes on any Escape nobody handled (capture phase runs first).
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (!props.busy) emit('cancel')
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function confirm(): void {
  emit('confirm', chosen.value.filter((id) => props.pack.installedByPack.includes(id)))
}
</script>

<template>
  <div class="pack-uninstall-dialog" role="dialog" aria-modal="true">
    <div class="pack-uninstall-body">
      <h4>{{ $t('settings.extensions.pack.uninstallTitle', { name: pack.displayName || pack.id }) }}</h4>
      <p v-if="pack.displayName" class="pack-uninstall-id"><code>{{ pack.id }}</code></p>
      <p>{{ $t('settings.extensions.pack.uninstallBody') }}</p>
      <template v-if="pack.installedByPack.length">
        <p class="pack-uninstall-hint">{{ $t('settings.extensions.pack.uninstallMembersHint') }}</p>
        <label v-for="id in pack.installedByPack" :key="id" class="pack-uninstall-member" :data-member="id">
          <input v-model="chosen" type="checkbox" :value="id" />
          {{ id }}
        </label>
      </template>
      <div class="pack-uninstall-actions">
        <button class="pack-uninstall-confirm nv-btn nv-btn--danger" :disabled="busy" @click="confirm">
          {{
            chosen.length
              ? $t('settings.extensions.pack.uninstallWithMembers', { count: chosen.length })
              : $t('settings.extensions.pack.uninstallOnly')
          }}
        </button>
        <button class="pack-uninstall-cancel nv-btn" :disabled="busy" @click="$emit('cancel')">
          {{ $t('settings.extensions.trust.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pack-uninstall-dialog {
  position: fixed;
  inset: 0;
  /* Above the settings modal chrome (.s-close is z-index 30 in the same
     stacking context), so nothing behind the dialog can be clicked. */
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.pack-uninstall-body {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  padding: 20px 24px;
  border-radius: var(--radius-lg);
  width: min(440px, calc(100vw - 32px));
  font-size: var(--font-sm);
}
.pack-uninstall-body h4 {
  margin: 0 0 8px;
  color: var(--text-bright);
  font-size: var(--font-md);
}
.pack-uninstall-id {
  margin: -4px 0 8px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.pack-uninstall-hint {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.pack-uninstall-member {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
}
.pack-uninstall-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
