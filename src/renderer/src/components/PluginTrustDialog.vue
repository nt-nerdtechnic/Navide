<script setup lang="ts">
// The publisher-trust / capability-risk confirmation shown between a verified
// prepareInstall and its commit. Presentation only: usePluginInstallFlow owns
// the pending package and decides which step is showing.
import type { PendingInstall } from '../composables/usePluginInstallFlow'

defineProps<{ pending: PendingInstall; step: 'publisher' | 'risk' | null }>()
defineEmits<{ confirmPublisher: []; confirmRisk: []; cancel: [] }>()
</script>

<template>
  <div class="ext-trust-dialog" role="dialog" aria-modal="true">
    <div class="ext-trust-body">
      <h4 v-if="step === 'publisher'">{{ $t('settings.extensions.trust.publisherTitle') }}</h4>
      <h4 v-else>{{ $t('settings.extensions.trust.permissionsTitle') }}</h4>
      <p v-if="step === 'publisher'" class="ext-publisher-risk">
        {{
          $t('settings.extensions.trust.publisherRisk', {
            publisher: pending.prepared.publisherId,
            id: pending.prepared.id,
          })
        }}
      </p>
      <p v-if="step === 'risk' && pending.prepared.containsBackendExecutable" class="ext-backend-risk">
        {{ $t('settings.extensions.trust.backendRisk', { name: pending.label }) }}
      </p>
      <p v-if="step === 'risk' && pending.prepared.sensitive.length">
        {{
          $t('settings.extensions.trust.sensitiveRisk', {
            name: pending.label,
            capabilities: pending.prepared.sensitive.join(', '),
          })
        }}
      </p>
      <p class="ext-trust-tier">
        <span
          v-if="pending.prepared.trustTier === 'signed-verified'"
          class="ext-trust-badge ext-verified"
        >
          {{ $t('settings.extensions.trust.signed') }}
        </span>
        <span v-else class="ext-trust-badge ext-unsigned">
          {{ $t('settings.extensions.trust.unsigned') }}
        </span>
      </p>
      <div class="ext-trust-actions">
        <button
          v-if="step === 'publisher'"
          class="ext-confirm-publisher nv-btn nv-btn--primary"
          @click="$emit('confirmPublisher')"
        >
          {{ $t('settings.extensions.trust.confirmPublisher') }}
        </button>
        <button v-else class="ext-confirm-risk nv-btn nv-btn--primary" @click="$emit('confirmRisk')">
          {{ $t('settings.extensions.trust.confirmInstall') }}
        </button>
        <button class="ext-cancel nv-btn" @click="$emit('cancel')">
          {{ $t('settings.extensions.trust.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ext-trust-dialog {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.ext-trust-body {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  padding: 20px 24px;
  border-radius: var(--radius-lg);
  max-width: 420px;
  font-size: var(--font-sm);
}
.ext-trust-body h4 {
  margin: 0 0 8px;
  color: var(--text-bright);
  font-size: var(--font-md);
}
.ext-trust-tier {
  color: var(--text-secondary);
}
.ext-trust-badge {
  display: inline-block;
  font-size: var(--font-2xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
}
.ext-trust-badge.ext-verified {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.ext-trust-badge.ext-unsigned {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.ext-trust-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
