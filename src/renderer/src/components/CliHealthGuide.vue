<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { CliHealthEntry, CliHealthStatus, OnboardStatus } from '../composables/useOnboarding'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  initialHealth: CliHealthStatus
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'resolved'): void }>()
const { t } = useI18n()

type Step = 'detect' | 'repair' | 'verify'
const steps: Step[] = ['detect', 'repair', 'verify']
const stepIndex = ref(0)
const current = computed(() => steps[stepIndex.value])
const health = ref(props.initialHealth)
const checking = ref(false)
const message = ref('')

const affectedKeys = computed(() => new Set(health.value.findings.map((finding) => finding.agent_key)))
const affectedEntries = computed(() => health.value.entries.filter((entry) => affectedKeys.value.has(entry.agent_key)))

function findingType(entry: CliHealthEntry): 'probe_failed' | 'duplicate_install' {
  return health.value.findings.find((finding) => finding.agent_key === entry.agent_key)?.type ?? 'duplicate_install'
}

async function openDiagnostics(entry: CliHealthEntry): Promise<void> {
  const result = await window.agentTeam?.openTerminal(entry.diagnostic_command)
  message.value = result?.ok
    ? t('cli-health.terminal-opened')
    : t('cli-health.terminal-failed', { error: result?.error || 'unknown' })
}

async function recheck(): Promise<void> {
  checking.value = true
  message.value = ''
  try {
    const resp = await props.backend.send<OnboardStatus>('onboarding.status', {})
    if (!resp.payload?.cli_health) return
    health.value = resp.payload.cli_health
    if (!health.value.findings.length) {
      emit('resolved')
      return
    }
    message.value = t('cli-health.still-detected')
  } finally {
    checking.value = false
  }
}

async function dismiss(): Promise<void> {
  await props.backend.send('onboarding.cli_health.dismiss', {
    fingerprint: health.value.fingerprint,
  }).catch(() => {})
  emit('close')
}
</script>

<template>
  <div class="ch-page">
    <section class="ch-dialog" role="dialog" aria-modal="true" :aria-label="$t('cli-health.title')">
      <header class="ch-top">
        <div>
          <div class="ch-kicker">{{ $t('cli-health.kicker') }}</div>
          <h1>{{ $t('cli-health.title') }}</h1>
        </div>
        <ol class="ch-steps">
          <li v-for="(step, index) in steps" :key="step" :class="{ active: current === step, done: index < stepIndex }">
            <span>{{ index < stepIndex ? '✓' : index + 1 }}</span>
            {{ $t(`cli-health.step.${step}`) }}
          </li>
        </ol>
      </header>

      <main class="ch-main">
        <template v-if="current === 'detect'">
          <h2>{{ $t('cli-health.detect-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.detect-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card">
            <div class="ch-card-head">
              <strong>{{ entry.label }}</strong>
              <span class="ch-warning">{{ $t(`cli-health.finding.${findingType(entry)}`) }}</span>
            </div>
            <div v-for="candidate in entry.candidates" :key="candidate.resolved_path" class="ch-candidate" :class="{ primary: candidate.is_primary }">
              <div class="ch-candidate-top">
                <span>{{ candidate.is_primary ? $t('cli-health.active') : $t('cli-health.alternate') }}</span>
                <code>{{ candidate.version || $t('cli-health.unknown-version') }}</code>
                <span v-if="candidate.signal" class="ch-signal">{{ candidate.signal }}</span>
              </div>
              <code class="ch-path">{{ candidate.path }}</code>
            </div>
          </section>
        </template>

        <template v-else-if="current === 'repair'">
          <h2>{{ $t('cli-health.repair-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.repair-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card repair">
            <strong>{{ entry.label }}</strong>
            <ol>
              <li>{{ $t('cli-health.keep-primary') }}</li>
              <li>{{ $t('cli-health.remove-alternate') }}</li>
              <li>{{ $t('cli-health.run-doctor') }}</li>
            </ol>
            <button class="ch-btn primary" @click="openDiagnostics(entry)">
              {{ $t('cli-health.open-terminal') }} · <code>{{ entry.diagnostic_command }}</code>
            </button>
          </section>
        </template>

        <template v-else>
          <div class="ch-verify">
            <div class="ch-check">✓</div>
            <h2>{{ $t('cli-health.verify-title') }}</h2>
            <p class="ch-lead">{{ $t('cli-health.verify-desc') }}</p>
            <button class="ch-btn primary" :disabled="checking" @click="recheck">
              {{ checking ? $t('label.detecting') : $t('action.re-detect') }}
            </button>
          </div>
        </template>

        <p v-if="message" class="ch-message">{{ message }}</p>
      </main>

      <footer class="ch-footer">
        <button class="ch-btn ghost" @click="dismiss">{{ $t('action.skip-for-now') }}</button>
        <span />
        <button v-if="stepIndex > 0" class="ch-btn ghost" @click="stepIndex--">{{ $t('action.back') }}</button>
        <button v-if="stepIndex < steps.length - 1" class="ch-btn primary" @click="stepIndex++">{{ $t('action.next') }}</button>
        <button v-else class="ch-btn ghost" @click="emit('close')">{{ $t('cli-health.close') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ch-page {
  position: fixed;
  inset: 0;
  z-index: 9550;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(0, 0, 0, .58);
  backdrop-filter: blur(3px);
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.ch-dialog {
  width: min(880px, calc(100vw - 56px));
  max-height: min(760px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--bg-base);
  box-shadow: 0 22px 70px rgba(0, 0, 0, .48);
}
.ch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 24px 30px 20px;
  border-bottom: 1px solid var(--border-muted);
}
.ch-kicker { color: var(--accent-bright); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 5px 0 0; color: var(--text-bright); font-size: 25px; }
.ch-steps { display: flex; gap: 22px; margin: 0; padding: 0; list-style: none; color: var(--text-muted); font-size: 12px; }
.ch-steps li { display: flex; align-items: center; gap: 7px; }
.ch-steps li span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--border-default); border-radius: 50%; }
.ch-steps li.active { color: var(--text-bright); }
.ch-steps li.active span { border-color: var(--accent-bright); color: var(--accent-bright); }
.ch-steps li.done span { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ch-main { width: 100%; padding: 30px; overflow: auto; box-sizing: border-box; }
h2 { margin: 0 0 8px; color: var(--text-bright); font-size: 22px; }
.ch-lead { margin: 0 0 26px; color: var(--text-secondary); line-height: 1.6; }
.ch-card { padding: 20px; margin-bottom: 14px; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-subtle); }
.ch-card-head, .ch-candidate-top { display: flex; align-items: center; gap: 10px; }
.ch-card-head { justify-content: space-between; margin-bottom: 14px; }
.ch-warning { color: var(--attention-fg); font-size: 12px; }
.ch-candidate { padding: 12px 14px; margin-top: 8px; border-left: 3px solid var(--border-default); background: var(--bg-base); border-radius: 6px; }
.ch-candidate.primary { border-left-color: var(--accent-bright); }
.ch-candidate-top { color: var(--text-secondary); font-size: 12px; }
.ch-candidate-top code { margin-left: auto; color: var(--text-bright); }
.ch-signal { color: var(--danger-fg); font-weight: 700; }
.ch-path { display: block; margin-top: 8px; color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
.repair ol { color: var(--text-secondary); line-height: 1.8; }
.ch-verify { text-align: center; padding-top: 50px; }
.ch-check { display: grid; place-items: center; width: 54px; height: 54px; margin: 0 auto 18px; border-radius: 50%; background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 25px; }
.ch-message { color: var(--attention-fg); text-align: center; }
.ch-footer { display: flex; align-items: center; gap: 10px; margin-top: auto; padding: 16px 30px; border-top: 1px solid var(--border-muted); }
.ch-footer span { flex: 1; }
.ch-btn { border: 1px solid var(--border-default); border-radius: 7px; padding: 9px 14px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); }
.ch-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.ghost { background: transparent; }
.ch-btn:disabled { opacity: .55; cursor: default; }
.ch-btn code { font-size: 11px; }
@media (max-width: 760px) {
  .ch-page { padding: 14px; }
  .ch-dialog { width: calc(100vw - 28px); max-height: calc(100vh - 28px); }
  .ch-top { align-items: flex-start; flex-direction: column; gap: 16px; padding: 20px; }
  .ch-steps { gap: 12px; }
  .ch-main { padding: 22px 20px; }
  .ch-footer { padding: 14px 20px; }
}
</style>
