<script setup lang="ts">
// One Navide job in the Tasker list. Presentation only: state and mutations
// come from useSchedulerJobs, owned by TaskerPanel, so a job row can sit in
// the same list as crontab and launchd rows.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SchedulerJobsApi } from '../composables/useSchedulerJobs'
import type { Translate } from '../lib/cronDescribe'
import { describeSchedule, type SchedulerJob } from '../lib/schedulerJobs'

const props = defineProps<{ job: SchedulerJob; api: SchedulerJobsApi }>()
defineEmits<{ edit: [job: SchedulerJob] }>()

const { t } = useI18n()
const tr: Translate = (key, params) => (params ? t(key, params) : t(key))

const light = computed(() => props.api.light(props.job))
const gone = computed(() => props.api.targetGone(props.job))
const busy = computed(() => props.api.pendingId.value !== null)
const backoff = computed(() => props.api.backoffLabel(props.job))
const target = computed(() => props.api.targetLabel(props.job))
const desc = computed(() => describeSchedule(props.job.schedule, tr, props.job.state))
</script>

<template>
  <div class="sj-row" :data-job-id="job.id" :data-light="light">
    <div class="sj-line1">
      <span class="sj-dot" :class="light" data-test="light" />
      <button class="sj-name" :title="t('scheduler.edit')" @click="$emit('edit', job)">{{ job.name }}</button>
      <span v-if="light === 'err'" class="sj-fail" data-test="fail-pill">
        <span class="sj-fail-count">{{ t('scheduler.failed', { n: job.state?.consecutive_errors ?? 0 }) }}</span>
        <button
          class="sj-fail-repair"
          data-test="repair"
          :disabled="busy"
          :title="job.state?.last_error ?? ''"
          @click="api.runNow(job)"
        >
          {{ t('scheduler.repair') }}
        </button>
      </span>
      <span v-else-if="light === 'skip' && !gone" class="sj-tag" data-test="skip-tag">
        {{ api.skipLabel(job) }}
      </span>
      <span class="sj-src">Navide</span>
      <span class="sj-acts">
        <button
          class="sj-act"
          data-test="toggle"
          :disabled="busy"
          :title="job.enabled ? t('scheduler.disable') : t('scheduler.enable')"
          @click="api.toggleEnabled(job)"
        >
          {{ job.enabled ? '⏸' : '⏵' }}
        </button>
        <button
          class="sj-act"
          data-test="run-now"
          :disabled="busy || light === 'running'"
          :title="t('scheduler.run-now')"
          @click="api.runNow(job)"
        >
          ▶
        </button>
      </span>
    </div>
    <div class="sj-line2" :title="`${desc} · ${target}\n${job.action.workspace}`">
      <span class="sj-desc" data-test="desc">{{ desc }}</span>
      <span v-if="backoff" class="sj-when" data-test="when">· {{ backoff }}</span>
      <span class="sj-sep">·</span>
      <span class="sj-target" data-test="target">{{ target }}</span>
    </div>
    <div v-if="gone" class="sj-gone" data-test="target-gone">
      <span>{{ t('scheduler.skip.target_gone') }}</span>
      <button class="sj-retarget" data-test="retarget" @click="$emit('edit', job)">
        {{ t('scheduler.retarget') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.sj-row {
  flex: 1;
  min-width: 0;
}
.sj-line1 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.sj-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--text-disabled);
}
.sj-dot.ok {
  background: var(--success-fg);
}
.sj-dot.running {
  background: var(--attention-fg);
}
.sj-dot.err {
  background: var(--danger-fg);
}
.sj-dot.new {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-disabled);
}
.sj-name {
  flex: 1;
  min-width: 0;
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.sj-name:hover {
  text-decoration: underline;
}
.sj-fail {
  flex: none;
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--danger-muted);
  border-radius: 4px;
  overflow: hidden;
  font-size: 9px;
  font-weight: 700;
}
.sj-fail-count {
  padding: 0 4px;
  color: var(--danger-fg);
  background: var(--danger-subtle);
}
.sj-fail-repair {
  appearance: none;
  border: none;
  border-left: 1px solid var(--danger-muted);
  padding: 0 5px;
  background: transparent;
  color: var(--danger-fg);
  font: inherit;
  cursor: pointer;
}
.sj-fail-repair:hover:not(:disabled) {
  background: var(--danger-subtle);
}
.sj-tag,
.sj-src {
  flex: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
}
.sj-src {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
.sj-acts {
  display: flex;
  flex: none;
  gap: 3px;
}
.sj-act {
  appearance: none;
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.sj-act:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.sj-act:disabled,
.sj-fail-repair:disabled {
  opacity: 0.5;
  cursor: default;
}
.sj-line2 {
  display: flex;
  gap: 4px;
  min-width: 0;
  margin-top: 2px;
  padding-left: 11px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.sj-desc,
.sj-when,
.sj-sep {
  flex: none;
  white-space: nowrap;
}
.sj-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sj-gone {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  padding-left: 11px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.sj-retarget {
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--accent-fg);
  padding: 0 6px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
</style>
