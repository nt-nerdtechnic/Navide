<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  setTestMaxWorkers,
  TEST_MAX_WORKERS_MAX,
  TEST_MAX_WORKERS_MIN,
  TEST_MAX_WORKERS_ON_DEFAULT,
  useResourceLimits,
} from '../../composables/useResourceLimits'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → General → Resource limits. Every row is off (or at the behavior
 * Navide had before it) by default, and the backend fails open on anything it
 * cannot read — see composables/useResourceLimits.ts.
 */
const { t } = useI18n()
const { testMaxWorkers } = useResourceLimits()

function onTestWorkersToggle(on: boolean): void {
  setTestMaxWorkers(on ? TEST_MAX_WORKERS_ON_DEFAULT : 0)
}

function onTestWorkersValue(event: Event): void {
  const input = event.target as HTMLInputElement
  // An out-of-range entry is not stored; put the field back to what is.
  if (!setTestMaxWorkers(Number(input.value))) input.value = String(testMaxWorkers.value)
}
</script>

<template>
  <SettingsSection :label="t('settings.section.resource-limits')" data-testid="resource-limits">
    <p class="rl-hint">{{ t('settings.limits.hint') }}</p>
    <SettingsCard>
      <SettingRow
        data-settings-section="limits-test-workers"
        :title="t('settings.limits.test-workers')"
        :description="t('settings.limits.test-workers-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="testMaxWorkers > 0"
            :aria-label="t('settings.limits.test-workers')"
            data-testid="limit-test-workers-toggle"
            @update:model-value="onTestWorkersToggle"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="testMaxWorkers > 0"
        data-settings-section="limits-test-workers-value"
        :title="t('settings.limits.test-workers-value')"
      >
        <template #control>
          <input
            type="number"
            :min="TEST_MAX_WORKERS_MIN"
            :max="TEST_MAX_WORKERS_MAX"
            :value="testMaxWorkers"
            data-testid="limit-test-workers-value"
            @change="onTestWorkersValue"
          />
        </template>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
</template>

<style scoped>
.rl-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
</style>
