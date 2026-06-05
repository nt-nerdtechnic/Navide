<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type OnboardDep } from '../composables/useOnboarding'
import OnboardingDepRow from './OnboardingDepRow.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const emit = defineEmits<{ (e: 'complete'): void; (e: 'close'): void }>()

const ob = useOnboarding(props.backend)
const step = ref(1)

onMounted(() => void ob.refresh())

// ── Model picker ──────────────────────────────────────────────────────────────
const selectedModel = ref('')
const customModel = ref('')
const pullTarget = computed(() => customModel.value.trim() || selectedModel.value)

function isInstalled(name: string): boolean {
  return ob.models.value.includes(name)
}

function pickModel(name: string): void {
  selectedModel.value = name
  customModel.value = ''
}

// Default selection follows the recommended catalog entry once it arrives.
watch(
  ob.modelCatalog,
  (cat) => {
    if (!selectedModel.value && !customModel.value && cat.length) {
      selectedModel.value = (cat.find((m) => m.recommended) ?? cat[0]).name
    }
  },
  { immediate: true },
)

const STEPS = [
  { n: 1, label: 'Foundation' },
  { n: 2, label: 'Agent & Analyzer' },
  { n: 3, label: 'Ready check' },
]

async function installMissing(deps: OnboardDep[]): Promise<void> {
  for (const d of deps) {
    if (d.status !== 'ok' && d.can_install) await ob.install(d)
  }
}

const step1Done = computed(() => ob.foundationReady.value)
const step2Done = computed(() => ob.hasAnyCli.value && ob.analyzerReady.value)
</script>

<template>
  <div class="ob-overlay">
    <div class="ob-modal">
      <header class="ob-header">
        <div class="ob-title">Agent-Team · Environment Setup</div>
        <ol class="ob-steps">
          <li
            v-for="s in STEPS"
            :key="s.n"
            :class="{ active: step === s.n, done: (s.n === 1 && step1Done) || (s.n === 2 && step2Done) }"
          >
            <span class="ob-step-num">{{ s.n }}</span>{{ s.label }}
          </li>
        </ol>
      </header>

      <div class="ob-body">
        <!-- Step 1 -->
        <section v-if="step === 1">
          <p class="ob-hint">Install the foundational tools required to run Agent-Team. Already-installed items show a green checkmark.</p>
          <OnboardingDepRow
            v-for="d in ob.foundationDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />
          <div class="ob-row-actions">
            <button class="ob-btn" :disabled="!!ob.installing.value" @click="installMissing(ob.foundationDeps.value)">Install missing</button>
            <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? 'Detecting…' : 'Re-detect' }}</button>
          </div>
        </section>

        <!-- Step 2 -->
        <section v-else-if="step === 2">
          <p class="ob-hint">At least one Agent CLI (claude / codex / gemini) is required. Detection only confirms the binary is in PATH — <b>it does not verify you are logged in</b>. Complete login in an external terminal.</p>
          <OnboardingDepRow
            v-for="d in ob.cliDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />
          <p class="ob-hint" style="margin-top:14px">Analyzer requires Ollama + at least one model.</p>
          <OnboardingDepRow
            v-for="d in ob.analyzerDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />

          <!-- Model picker -->
          <div class="ob-models">
            <div class="ob-models-head">
              <span class="ob-models-title">Analysis model</span>
              <span class="ob-models-sub">Download any one; any installed model will pass.</span>
            </div>

            <div class="ob-installed">
              <template v-if="ob.models.value.length">
                <span v-for="m in ob.models.value" :key="m" class="ob-chip ok">✓ {{ m }}</span>
              </template>
              <span v-else class="ob-chip empty">No models installed</span>
            </div>

            <div class="ob-model-grid">
              <button
                v-for="m in ob.modelCatalog.value"
                :key="m.name"
                type="button"
                class="ob-model-card"
                :class="{ selected: selectedModel === m.name, installed: isInstalled(m.name) }"
                @click="pickModel(m.name)"
              >
                <span class="ob-model-radio" />
                <span class="ob-model-info">
                  <span class="ob-model-name">
                    {{ m.name }}
                    <span v-if="m.recommended" class="ob-tag rec">Recommended</span>
                    <span v-if="isInstalled(m.name)" class="ob-tag inst">Installed</span>
                  </span>
                  <span class="ob-model-desc">{{ m.desc }}</span>
                </span>
                <span class="ob-model-size">{{ m.size }}</span>
              </button>
            </div>

            <label class="ob-model-custom">
              <span class="ob-model-custom-label">Other model</span>
              <input
                v-model="customModel"
                class="ob-input"
                placeholder="e.g. codellama:7b, gemma3:4b"
                spellcheck="false"
              />
            </label>

            <div class="ob-row-actions">
              <button class="ob-btn primary small" :disabled="!pullTarget" @click="ob.pullModel(pullTarget)">
                Download {{ pullTarget || 'model' }}
              </button>
              <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? 'Detecting…' : 'Re-detect' }}</button>
            </div>
          </div>
        </section>

        <!-- Step 3 -->
        <section v-else>
          <p class="ob-hint">Once all required items are ready, you can enter the main screen.</p>
          <ul class="ob-gate">
            <li :class="{ ok: ob.foundationReady.value }"><span>{{ ob.foundationReady.value ? '✓' : '○' }}</span> Foundation environment ready</li>
            <li :class="{ ok: ob.hasAnyCli.value }"><span>{{ ob.hasAnyCli.value ? '✓' : '○' }}</span> At least one Agent CLI</li>
            <li :class="{ ok: ob.analyzerReady.value }"><span>{{ ob.analyzerReady.value ? '✓' : '○' }}</span> Ollama + at least one model</li>
          </ul>
          <div class="ob-row-actions">
            <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? 'Detecting…' : 'Re-detect' }}</button>
          </div>
        </section>

        <!-- Install log -->
        <div v-if="ob.logLines.value.length" class="ob-log">
          <div v-for="(l, i) in ob.logLines.value" :key="i" class="ob-log-line">{{ l }}</div>
        </div>
      </div>

      <footer class="ob-footer">
        <button v-if="step > 1" class="ob-btn ghost" @click="step--">Back</button>
        <span class="ob-spacer" />
        <button v-if="step < 3" class="ob-btn primary" @click="step++">Next</button>
        <button
          v-else
          class="ob-btn primary"
          :disabled="!ob.allRequiredReady.value"
          :title="ob.allRequiredReady.value ? '' : 'Some required items are not yet ready'"
          @click="ob.markComplete().then(() => emit('complete'))"
        >Open Agent-Team</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.ob-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  background: var(--bg-inset);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ob-modal {
  width: 680px;
  max-width: 92vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  overflow: hidden;
}
.ob-header { padding: 18px 22px 12px; border-bottom: 1px solid var(--border-muted); }
.ob-title { font-size: 15px; font-weight: 700; color: var(--text-bright); margin-bottom: 12px; }
.ob-steps { display: flex; gap: 8px; list-style: none; margin: 0; padding: 0; }
.ob-steps li {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-muted);
}
.ob-steps li.active { color: var(--text-bright); border-color: var(--accent-emphasis); }
.ob-steps li.done { color: var(--success-fg); }
.ob-step-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--bg-muted); font-size: 10px; font-weight: 700;
}
.ob-body { padding: 18px 22px; overflow-y: auto; flex: 1; }
.ob-hint { font-size: 12px; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.5; }

/* ── Model picker ──────────────────────────────────────────────────────────── */
.ob-models {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  background: var(--bg-inset);
}
.ob-models-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.ob-models-title { font-size: 12.5px; font-weight: 700; color: var(--text-bright); }
.ob-models-sub { font-size: 11px; color: var(--text-muted); }

.ob-installed { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.ob-chip {
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-secondary);
}
.ob-chip.ok { color: var(--success-fg); border-color: color-mix(in srgb, var(--success-fg) 35%, transparent); }
.ob-chip.empty { color: var(--text-muted); font-family: inherit; }

.ob-model-grid { display: flex; flex-direction: column; gap: 6px; }
.ob-model-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-base);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.ob-model-card:hover { border-color: var(--border-default); background: var(--bg-muted); }
.ob-model-card.selected { border-color: var(--accent-emphasis); background: color-mix(in srgb, var(--accent-emphasis) 8%, var(--bg-base)); }
.ob-model-radio {
  flex: none;
  width: 15px; height: 15px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  position: relative;
}
.ob-model-card.selected .ob-model-radio { border-color: var(--accent-emphasis); }
.ob-model-card.selected .ob-model-radio::after {
  content: '';
  position: absolute; inset: 2px;
  border-radius: 50%;
  background: var(--accent-emphasis);
}
.ob-model-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ob-model-name {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font: 12px/1.3 ui-monospace, Menlo, monospace;
  color: var(--text-bright);
}
.ob-model-desc { font-size: 11px; color: var(--text-muted); }
.ob-model-size {
  flex: none;
  font: 11px/1 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--bg-muted);
}
.ob-tag {
  font-size: 9.5px;
  font-weight: 700;
  font-family: var(--font-sans, system-ui);
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 999px;
  line-height: 1.5;
}
.ob-tag.rec { color: var(--accent-fg); background: color-mix(in srgb, var(--accent-fg) 14%, transparent); }
.ob-tag.inst { color: var(--success-fg); background: color-mix(in srgb, var(--success-fg) 14%, transparent); }

.ob-model-custom { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.ob-model-custom-label { flex: none; font-size: 11px; color: var(--text-secondary); }
.ob-input {
  flex: 1;
  min-width: 0;
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-base);
  color: var(--text-bright);
}
.ob-input:focus { outline: none; border-color: var(--accent-emphasis); }
.ob-input::placeholder { color: var(--text-muted); }

.ob-gate { list-style: none; margin: 0; padding: 0; }
.ob-gate li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font-size: 13px; color: var(--text-muted); border-bottom: 1px solid var(--border-muted); }
.ob-gate li.ok { color: var(--success-fg); }
.ob-gate li span { font-weight: 700; }

.ob-row-actions { display: flex; gap: 8px; margin-top: 12px; }
.ob-log {
  margin-top: 14px;
  max-height: 140px;
  overflow-y: auto;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  padding: 8px 10px;
  font: 11px/1.5 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
}
.ob-log-line { white-space: pre-wrap; word-break: break-word; }

.ob-footer { display: flex; align-items: center; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--border-muted); }
.ob-spacer { flex: 1; }
.ob-btn {
  font-size: 12px;
  padding: 7px 14px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ob-btn:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ob-btn:disabled { opacity: 0.5; cursor: default; }
.ob-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ob-btn.ghost { background: transparent; }
.ob-btn.small { font-size: 11px; padding: 4px 10px; }
</style>
