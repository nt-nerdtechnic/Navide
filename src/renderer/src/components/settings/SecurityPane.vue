<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../../composables/useBackend'
import { useAgentMessaging } from '../../composables/useAgentMessaging'
import {
  useGuard,
  type GuardAction,
  type GuardDecision,
  type GuardLevel,
  type GuardSource,
  type GuardVerdict,
} from '../../composables/useGuard'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import TerminalProtectionSection from './TerminalProtectionSection.vue'

/**
 * Settings → Security: Navide Guard. The on/off switch, what Guard does per
 * request source × danger level (read-only), which CLIs it can actually block,
 * the user's own allow/deny patterns, recent decisions, panes marked as
 * influenced by external content, and a box to try a command against the rules.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
}>()

const { t } = useI18n()
const store = useGuard(props.backend)
const messaging = useAgentMessaging()

onMounted(() => {
  void store.refresh()
})

const busy = ref(false)
const actionError = ref('')

async function run(op: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  busy.value = true
  try {
    const res = await op()
    actionError.value = res.ok ? '' : (res.error ?? t('guard.error.generic'))
    return res.ok
  } finally {
    busy.value = false
  }
}

// ── Policy matrix: mirrors the backend policy table (GUARD-CONTRACT.md). ─────
const LEVELS: GuardLevel[] = ['critical', 'high', 'normal']
type PolicyRow = 'local' | 'relay' | 'remote' | 'tainted'
const POLICY: Record<PolicyRow, Record<GuardLevel, GuardAction | 'allow-audit'>> = {
  local: { critical: 'ask', high: 'allow-audit', normal: 'allow' },
  relay: { critical: 'deny', high: 'deny', normal: 'allow' },
  remote: { critical: 'ask', high: 'allow-audit', normal: 'allow' },
  tainted: { critical: 'ask', high: 'ask', normal: 'allow' },
}
const POLICY_ROWS = Object.keys(POLICY) as PolicyRow[]

function actionTone(action: string): string {
  if (action === 'deny') return 'bad'
  if (action === 'ask') return 'warn'
  return 'muted'
}

// ── Per-vendor blockability ──────────────────────────────────────────────────
const vendors = computed(() =>
  CLI_AGENT_SPECS.map((s) => ({ key: s.agentKey, label: s.label, support: store.hookSupportFor(s.agentKey) }))
)

// ── Custom rules ─────────────────────────────────────────────────────────────
const ruleKind = ref<'allow' | 'deny'>('deny')
const rulePattern = ref('')
const ruleNote = ref('')

async function addRule(): Promise<void> {
  const pattern = rulePattern.value.trim()
  if (!pattern) return
  const ok = await run(() => store.addRule(ruleKind.value, pattern, ruleNote.value.trim()))
  if (ok) {
    rulePattern.value = ''
    ruleNote.value = ''
  }
}

// ── Audit + taint ────────────────────────────────────────────────────────────
function paneLabel(paneId: string): string {
  return messaging.nameOf(paneId) ?? paneId
}

function sourceText(source: string): string {
  const key = `guard.source.${source}`
  const text = t(key)
  return text === key ? source : text
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString()
}

// ── Try it ───────────────────────────────────────────────────────────────────
const testCommand = ref('')
const testSource = ref<GuardSource>('local')
const testTainted = ref(false)
const testResult = ref<{ verdict: GuardVerdict; decision: GuardDecision } | null>(null)
const testError = ref('')

async function runTest(): Promise<void> {
  const command = testCommand.value.trim()
  if (!command) return
  busy.value = true
  const res = await store.test(command, testSource.value, testTainted.value)
  busy.value = false
  testResult.value = res.ok && res.data ? res.data : null
  testError.value = res.ok ? '' : (res.error ?? t('guard.error.generic'))
}
</script>

<template>
  <section class="security-pane" data-settings-section="security">
    <p v-if="!store.available.value" class="gd-hint" data-testid="guard-unavailable">{{ t('guard.unavailable') }}</p>

    <SettingsCard>
      <SettingRow :title="t('guard.enabled.title')" :description="t('guard.enabled.desc')">
        <template #control>
          <ToggleSwitch
            data-testid="guard-enabled-toggle"
            :model-value="store.enabled.value"
            :disabled="busy || !store.available.value"
            :aria-label="t('guard.enabled.title')"
            @update:model-value="(v: boolean) => run(() => store.setEnabled(v))"
          />
        </template>
      </SettingRow>
      <div v-if="store.available.value" class="gd-counts" data-testid="guard-counts">
        <span class="gd-pill bad">{{ t('guard.counts.critical', { n: store.counts.value.critical }) }}</span>
        <span class="gd-pill warn">{{ t('guard.counts.high', { n: store.counts.value.high }) }}</span>
        <span class="gd-pill warn">{{ t('guard.counts.asks', { n: store.counts.value.asks }) }}</span>
        <span class="gd-pill bad">{{ t('guard.counts.denies', { n: store.counts.value.denies_24h }) }}</span>
      </div>
    </SettingsCard>
    <p v-if="actionError || store.error.value" class="gd-error" role="alert">{{ actionError || store.error.value }}</p>

    <SettingsSection :label="t('guard.policy.title')">
      <p class="gd-hint">{{ t('guard.policy.hint') }}</p>
      <SettingsCard>
        <table class="gd-table" data-testid="guard-policy">
          <thead>
            <tr>
              <th>{{ t('guard.policy.source') }}</th>
              <th v-for="level in LEVELS" :key="level">{{ t(`guard.level.${level}`) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in POLICY_ROWS" :key="row">
              <th scope="row">{{ t(`guard.policy.row.${row}`) }}</th>
              <td v-for="level in LEVELS" :key="level">
                <span class="gd-pill" :class="actionTone(POLICY[row][level])">{{ t(`guard.action.${POLICY[row][level]}`) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </SettingsCard>
      <p class="gd-hint">{{ t('guard.policy.levels') }}</p>
    </SettingsSection>

    <SettingsSection :label="t('guard.vendors.title')">
      <p class="gd-hint">{{ t('guard.vendors.hint') }}</p>
      <SettingsCard>
        <div v-for="v in vendors" :key="v.key" class="gd-item" data-testid="guard-vendor-row" :data-vendor="v.key">
          <span class="gd-item-name">{{ v.label }}</span>
          <span
            class="gd-pill"
            :class="v.support === 'block' ? 'ok' : v.support === 'none' ? 'warn' : 'muted'"
          >{{ t(`guard.vendors.${v.support ?? 'unknown'}`) }}</span>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('guard.rules.title')">
      <p class="gd-hint">{{ t('guard.rules.hint') }}</p>
      <SettingsCard>
        <div v-for="rule in store.rules.value" :key="rule.id" class="gd-item" data-testid="guard-rule-row">
          <span class="gd-pill" :class="rule.kind === 'deny' ? 'bad' : 'ok'">{{ t(`guard.rules.kind.${rule.kind}`) }}</span>
          <div class="gd-item-text">
            <code class="gd-code">{{ rule.pattern }}</code>
            <span v-if="rule.note" class="gd-item-meta">{{ rule.note }}</span>
          </div>
          <button type="button" class="gd-btn ghost sm" :disabled="busy" data-testid="guard-rule-remove" @click="run(() => store.removeRule(rule.id))">{{ t('guard.rules.remove') }}</button>
        </div>
        <form class="gd-form" @submit.prevent="addRule">
          <select v-model="ruleKind" class="gd-input" name="kind" :aria-label="t('guard.rules.kind-label')">
            <option value="deny">{{ t('guard.rules.kind.deny') }}</option>
            <option value="allow">{{ t('guard.rules.kind.allow') }}</option>
          </select>
          <input v-model="rulePattern" class="gd-input grow" name="pattern" autocomplete="off" spellcheck="false" :placeholder="t('guard.rules.pattern')" />
          <input v-model="ruleNote" class="gd-input" name="note" autocomplete="off" :placeholder="t('guard.rules.note')" />
          <button type="submit" class="gd-btn primary sm" :disabled="busy || !store.available.value || !rulePattern.trim()" data-testid="guard-rule-add">{{ t('guard.rules.add') }}</button>
        </form>
      </SettingsCard>
    </SettingsSection>

    <TerminalProtectionSection :backend="backend" />

    <SettingsSection :label="t('guard.test.title')">
      <SettingsCard>
        <form class="gd-form" @submit.prevent="runTest">
          <input v-model="testCommand" class="gd-input grow mono" name="command" autocomplete="off" spellcheck="false" :placeholder="t('guard.test.placeholder')" />
          <select v-model="testSource" class="gd-input" name="source" :aria-label="t('guard.policy.source')">
            <option v-for="s in (['local', 'relay', 'remote', 'agent'] as const)" :key="s" :value="s">{{ sourceText(s) }}</option>
          </select>
          <label class="gd-check"><input v-model="testTainted" type="checkbox" /> {{ t('guard.test.tainted') }}</label>
          <button type="submit" class="gd-btn primary sm" :disabled="busy || !store.available.value || !testCommand.trim()" data-testid="guard-test-run">{{ t('guard.test.run') }}</button>
        </form>
        <div v-if="testResult" class="gd-test-result" data-testid="guard-test-result">
          <span class="gd-pill" :class="actionTone(testResult.decision.action)">{{ t(`guard.action.${testResult.decision.action}`) }}</span>
          <span class="gd-pill" :class="testResult.verdict.level === 'critical' ? 'bad' : testResult.verdict.level === 'high' ? 'warn' : 'muted'">{{ t(`guard.level.${testResult.verdict.level}`) }}</span>
          <span class="gd-item-meta">{{ testResult.decision.reason || testResult.verdict.reasons.join('; ') }}</span>
          <span v-if="!testResult.verdict.parseable" class="gd-item-meta">{{ t('guard.test.unparseable') }}</span>
        </div>
        <p v-if="testError" class="gd-error gd-inset" role="alert">{{ testError }}</p>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('guard.taint.title')">
      <p class="gd-hint">{{ t('guard.taint.hint') }}</p>
      <SettingsCard>
        <div v-if="!store.taint.value.length" class="gd-item gd-empty">{{ t('guard.taint.empty') }}</div>
        <div v-for="entry in store.taint.value" :key="entry.pane_id" class="gd-item" data-testid="guard-taint-row">
          <div class="gd-item-text">
            <span class="gd-item-name">{{ paneLabel(entry.pane_id) }}</span>
            <span class="gd-item-meta">{{ (entry.sources ?? []).map(sourceText).join(', ') }} · {{ formatTime(entry.since) }}<template v-if="entry.detail"> · {{ entry.detail }}</template></span>
          </div>
          <button type="button" class="gd-btn ghost sm" :disabled="busy" data-testid="guard-taint-clear-row" @click="run(() => store.clearTaint(entry.pane_id))">{{ t('guard.pane.clear') }}</button>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('guard.audit.title')">
      <SettingsCard>
        <div v-if="!store.audit.value.length" class="gd-item gd-empty">{{ t('guard.audit.empty') }}</div>
        <div v-for="entry in store.audit.value" :key="entry.id" class="gd-item" data-testid="guard-audit-row">
          <span class="gd-pill" :class="actionTone(entry.action)">{{ t(`guard.action.${entry.action}`) }}</span>
          <div class="gd-item-text">
            <code class="gd-code">{{ entry.excerpt }}</code>
            <span class="gd-item-meta">{{ t(`guard.level.${entry.level}`) }} · {{ sourceText(entry.source) }} · {{ paneLabel(entry.pane_id) }}<template v-if="entry.vendor"> ({{ entry.vendor }})</template> · {{ formatTime(entry.ts) }}<template v-if="entry.tainted"> · {{ t('guard.pane.badge') }}</template></span>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  </section>
</template>

<style scoped>
.security-pane { display: flex; flex-direction: column; }
.gd-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.gd-error { margin: 8px 0 0; font-size: var(--font-2xs); color: var(--danger-fg); word-break: break-word; }
.gd-inset { margin: 0; padding: 0 var(--space-row-x) 8px; }
.gd-counts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px var(--space-row-x); }

/* Status pill: same shape as the Channels page's. */
.gd-pill {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--text-secondary);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  white-space: nowrap;
}
.gd-pill.ok { color: var(--success-fg); background: var(--success-subtle); border-color: var(--success-muted); }
.gd-pill.warn { color: var(--attention-fg); background: var(--attention-subtle); border-color: var(--attention-muted); }
.gd-pill.bad { color: var(--danger-fg); background: var(--danger-subtle); border-color: var(--danger-muted); }

.gd-table { width: 100%; border-collapse: collapse; font-size: var(--font-2xs); }
.gd-table th, .gd-table td { padding: 6px var(--space-row-x); text-align: left; }
.gd-table thead th { color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border-muted); }
.gd-table tbody th { color: var(--text-primary); font-weight: 600; }
.gd-table tbody tr + tr th, .gd-table tbody tr + tr td { border-top: 1px solid var(--border-muted); }

.gd-item { display: flex; align-items: center; gap: 10px; padding: 8px var(--space-row-x); }
.gd-empty { font-size: var(--font-2xs); color: var(--text-secondary); }
.gd-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.gd-item-name { flex: 1; min-width: 0; font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gd-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); word-break: break-word; }
.gd-code { font-family: var(--font-mono, monospace); font-size: var(--font-2xs); color: var(--text-bright); word-break: break-all; }

.gd-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px var(--space-row-x); }
.gd-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 4px 8px;
}
.gd-input.grow { flex: 1; min-width: 160px; }
.gd-input.mono { font-family: var(--font-mono, monospace); }
.gd-input:hover { border-color: var(--border-strong); }
.gd-input:focus { outline: none; border-color: var(--accent-focus); }
.gd-check { display: inline-flex; align-items: center; gap: 4px; font-size: var(--font-2xs); color: var(--text-secondary); }
.gd-test-result { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 var(--space-row-x) 10px; }

/* Buttons: the Channels page's button set. */
.gd-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  white-space: nowrap;
}
.gd-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.gd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gd-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.gd-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.gd-btn.ghost { color: var(--text-secondary); }
.gd-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
</style>
