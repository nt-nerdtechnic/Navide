<script setup lang="ts">
// The Extension Pack install dialog (D5): a whole-pack summary, then one
// confirmation per member behind a step bar, with "Skip this one" and
// "Cancel pack" and no "accept all". Presentation only: usePackInstallFlow
// owns the state and every IPC call.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { PackInstallFlow } from '../composables/usePackInstallFlow'

const props = defineProps<{ flow: PackInstallFlow }>()

const pack = computed(() => props.flow.pack.value)
const prepared = computed(() => props.flow.memberPrepared.value)
const member = computed(() => props.flow.currentMember.value)
const label = computed(() => pack.value?.display_name || pack.value?.id || '')

// Esc never bypasses the flow: it must not reach the settings modal (which
// closes on any Escape nobody handled; this capture listener runs first).
// At the summary it cancels the pack, on the result it closes; mid-review it
// does nothing, since leaving then is an explicit Skip or Cancel pack.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.flow.stage.value) return
  event.preventDefault()
  event.stopPropagation()
  if (props.flow.busy.value) return
  if (props.flow.stage.value === 'summary') void props.flow.cancelPack()
  else if (props.flow.stage.value === 'done') props.flow.close()
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function resultTone(result: string | undefined): 'success' | 'muted' | 'danger' {
  if (result === 'installed') return 'success'
  if (result === 'failed') return 'danger'
  return 'muted'
}

function memberLabel(m: PackMemberSummary): string {
  return m.display_name ? `${m.display_name} (${m.id})` : m.id
}

// Step bar: done (installed/skipped/failed), current, or still to come.
function stepState(m: PackMemberSummary): 'current' | 'done' | 'skipped' | 'failed' | 'pending' {
  if (member.value?.id === m.id) return 'current'
  const result = props.flow.results.value[m.id]?.result
  if (result === 'installed') return 'done'
  if (result === 'skipped' || result === 'cancelled') return 'skipped'
  if (result === 'failed') return 'failed'
  return 'pending'
}
</script>

<template>
  <div v-if="pack && flow.stage.value" class="pack-dialog" role="dialog" aria-modal="true">
    <div class="pack-body">
      <!-- Whole-pack summary -->
      <template v-if="flow.stage.value === 'summary'">
        <h4>{{ $t('settings.extensions.pack.summaryTitle', { name: label, count: flow.readyMembers.value.length }) }}</h4>
        <p class="pack-note">{{ $t('settings.extensions.pack.summaryNote') }}</p>
        <ul class="pack-members">
          <li
            v-for="m in pack.members"
            :key="m.id"
            class="pack-member pack-member--summary"
            :data-member="m.id"
            :data-status="m.status"
          >
            <div class="pack-member-main">
              <span class="pack-member-name" :title="m.display_name || m.id">{{ m.display_name || m.id }}</span>
              <span class="pack-muted pack-member-id" :title="m.version ? `${m.id} · ${m.version}` : m.id">
                {{ m.version ? `${m.id} · ${m.version}` : m.id }}
              </span>
            </div>
            <div class="pack-member-caps">
              <span
                v-for="cap in m.capabilities"
                :key="cap"
                class="pack-cap"
                :class="{ 'pack-cap--sensitive': m.sensitive_capabilities.includes(cap) }"
              >{{ m.sensitive_capabilities.includes(cap) ? `${cap} · ${$t('settings.extensions.sensitive')}` : cap }}</span>
            </div>
            <span class="pack-status" :class="{ 'pack-status--ready': m.status === 'ready' }">
              {{ $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' }) }}
            </span>
          </li>
        </ul>
        <div class="pack-actions">
          <button class="pack-review nv-btn nv-btn--primary" :disabled="flow.busy.value" @click="flow.beginReview">
            {{
              flow.readyMembers.value.length
                ? $t('settings.extensions.pack.review', { count: flow.readyMembers.value.length })
                : $t('settings.extensions.pack.finish')
            }}
          </button>
          <button class="pack-cancel nv-btn" :disabled="flow.busy.value" @click="flow.cancelPack">
            {{ $t('settings.extensions.pack.cancelPack') }}
          </button>
        </div>
      </template>

      <!-- One member at a time -->
      <template v-else-if="flow.stage.value === 'member'">
        <h4>{{ $t('settings.extensions.pack.reviewTitle', { name: label, count: flow.readyMembers.value.length }) }}</h4>
        <ol class="pack-steps">
          <li
            v-for="(m, index) in flow.readyMembers.value"
            :key="m.id"
            class="pack-step"
            :class="`pack-step--${stepState(m)}`"
            :aria-current="stepState(m) === 'current' ? 'step' : undefined"
          >
            <span class="pack-step-mark">{{ stepState(m) === 'done' ? '✓' : index + 1 }}</span>
            {{ m.id }}
          </li>
        </ol>
        <p v-if="!prepared" class="nv-loading">{{ $t('settings.extensions.pack.verifying') }}</p>
        <template v-else-if="member">
          <p class="pack-member-title">
            <strong>{{ memberLabel(member) }}</strong> <span class="pack-muted">{{ prepared.version }}</span>
          </p>
          <p v-if="flow.memberStep.value === 'publisher'" class="pack-publisher-risk">
            {{ $t('settings.extensions.trust.publisherRisk', { publisher: prepared.publisherId, id: prepared.id }) }}
          </p>
          <template v-else>
            <p v-if="prepared.containsBackendExecutable" class="pack-backend-risk">
              {{ $t('settings.extensions.trust.backendRisk', { name: prepared.id }) }}
            </p>
            <p v-if="prepared.sensitive.length" class="pack-sensitive">
              {{ $t('settings.extensions.trust.sensitiveRisk', { name: prepared.id, capabilities: prepared.sensitive.join(', ') }) }}
            </p>
            <p v-if="prepared.sensitive.length" class="pack-sensitive-caps">
              <span v-for="cap in prepared.sensitive" :key="cap" class="pack-cap pack-cap--sensitive">
                {{ cap }} · {{ $t('settings.extensions.sensitive') }}
              </span>
            </p>
            <p v-if="!prepared.containsBackendExecutable && !prepared.sensitive.length" class="pack-plain">
              {{ $t('settings.extensions.pack.noSensitive', { name: prepared.id }) }}
            </p>
          </template>
          <p class="pack-trust">
            <span v-if="prepared.trustTier === 'signed-verified'" class="pack-badge pack-badge--ok">
              {{ $t('settings.extensions.trust.signed') }}
            </span>
            <span v-else class="pack-badge pack-badge--warn">{{ $t('settings.extensions.trust.unsigned') }}</span>
            <span class="pack-muted">{{ $t('settings.extensions.marketplace.publisher') }}: {{ prepared.publisherId }}</span>
          </p>
        </template>
        <div class="pack-actions">
          <button
            v-if="flow.memberStep.value === 'publisher'"
            class="pack-confirm-publisher nv-btn nv-btn--primary"
            :disabled="flow.busy.value || !prepared"
            @click="flow.confirmPublisher"
          >
            {{ $t('settings.extensions.trust.confirmPublisher') }}
          </button>
          <button
            v-else
            class="pack-confirm nv-btn nv-btn--primary"
            :disabled="flow.busy.value || !prepared"
            @click="flow.confirmMember"
          >
            {{ $t('settings.extensions.pack.confirmMember') }}
          </button>
          <button class="pack-skip nv-btn" :disabled="flow.busy.value" @click="flow.skipMember">
            {{ $t('settings.extensions.pack.skip') }}
          </button>
          <button class="pack-cancel nv-btn nv-btn--danger" :disabled="flow.busy.value" @click="flow.cancelPack">
            {{ $t('settings.extensions.pack.cancelPack') }}
          </button>
        </div>
        <p class="pack-note">{{ $t('settings.extensions.pack.partialNote') }}</p>
      </template>

      <!-- Result -->
      <template v-else-if="flow.stage.value === 'done'">
        <h4>{{ $t('settings.extensions.pack.doneTitle', { name: label }) }}</h4>
        <ul class="pack-members">
          <li v-for="m in pack.members" :key="m.id" class="pack-member" :data-member="m.id">
            <span class="pack-member-name">{{ m.id }}</span>
            <span
              class="pack-result"
              :class="`pack-result--${resultTone(flow.results.value[m.id]?.result)}`"
            >
              {{ flow.results.value[m.id]?.result === 'installed' ? '✓' : flow.results.value[m.id]?.result === 'failed' ? '✕' : '–' }}
              {{
                flow.results.value[m.id]
                  ? $t(`settings.extensions.pack.result.${flow.results.value[m.id].result}`)
                  : $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' })
              }}
            </span>
            <span v-if="flow.results.value[m.id]?.error" class="pack-error">{{ flow.results.value[m.id].error }}</span>
          </li>
        </ul>
        <p v-if="Object.values(flow.results.value).some((r) => r.result === 'installed')" class="pack-note">
          {{ $t('settings.extensions.pack.restartNote') }}
        </p>
        <div class="pack-actions">
          <button class="pack-close nv-btn nv-btn--primary" @click="flow.close">
            {{ $t('settings.extensions.pack.close') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pack-dialog {
  position: fixed;
  inset: 0;
  /* Above the settings modal chrome (.s-close is z-index 30 in the same
     stacking context), so the modal cannot be closed mid-flow. */
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.pack-body {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  padding: 20px 24px;
  border-radius: var(--radius-lg);
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  font-size: var(--font-sm);
}
.pack-body h4 {
  margin: 0 0 8px;
  color: var(--text-bright);
  font-size: var(--font-md);
}
.pack-members {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.pack-member {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pack-member-name {
  font-weight: 600;
}
.pack-muted,
.pack-note {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.pack-status {
  color: var(--attention-fg);
  font-size: var(--font-xs);
  text-align: right;
  /* A status that still has to wrap splits evenly, never leaving one word. */
  text-wrap: balance;
}
.pack-status--ready {
  color: var(--text-secondary);
}
/* Summary rows share one grid (name | permissions | state), like the pack
   detail page, so no member's state wraps under its name. */
.pack-member--summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(10rem, max-content);
  gap: 10px;
}
.pack-member-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* An id or version never breaks mid-token: one line, ellipsis, full value in
   the tooltip. */
.pack-member--summary .pack-member-name,
.pack-member-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-member-caps {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pack-result {
  display: inline-flex;
  gap: 4px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-size: var(--font-xs);
  font-weight: 600;
}
.pack-result--success {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.pack-result--muted {
  color: var(--text-secondary);
  background: var(--bg-muted);
}
.pack-result--danger {
  color: var(--danger-bright);
  background: var(--danger-subtle);
}
.pack-cap {
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  background: var(--bg-muted);
}
.pack-cap--sensitive {
  color: var(--attention-fg);
  background: var(--attention-subtle);
  font-weight: 600;
}
.pack-sensitive-caps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pack-error {
  flex: 1 1 100%;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.pack-badge {
  display: inline-block;
  font-size: var(--font-2xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
}
.pack-badge--ok {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.pack-badge--warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.pack-steps {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  font-size: var(--font-xs);
}
.pack-step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.pack-step-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--border-default);
  font-size: var(--font-2xs);
}
.pack-step--current {
  color: var(--accent-fg);
  font-weight: 600;
}
.pack-step--current .pack-step-mark {
  border-color: var(--accent-fg);
}
.pack-step--done {
  color: var(--success-fg);
}
.pack-step--skipped,
.pack-step--failed {
  text-decoration: line-through;
}
.pack-trust {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pack-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
</style>
