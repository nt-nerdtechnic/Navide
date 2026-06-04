<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type OnboardDep } from '../composables/useOnboarding'
import OnboardingDepRow from './OnboardingDepRow.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const emit = defineEmits<{ (e: 'complete'): void; (e: 'close'): void }>()

const ob = useOnboarding(props.backend)
const step = ref(1)

onMounted(() => void ob.refresh())

const STEPS = [
  { n: 1, label: '基礎環境' },
  { n: 2, label: 'Agent 與 Analyzer' },
  { n: 3, label: '就緒確認' },
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
        <div class="ob-title">Agent-Team · 環境設定</div>
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
          <p class="ob-hint">安裝執行 Agent-Team 所需的基礎工具。已安裝者顯示綠勾。</p>
          <OnboardingDepRow
            v-for="d in ob.foundationDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />
          <div class="ob-row-actions">
            <button class="ob-btn" :disabled="!!ob.installing.value" @click="installMissing(ob.foundationDeps.value)">一鍵安裝缺少項</button>
            <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? '偵測中…' : '重新偵測' }}</button>
          </div>
        </section>

        <!-- Step 2 -->
        <section v-else-if="step === 2">
          <p class="ob-hint">至少需要一個 Agent CLI（claude / codex / gemini）。偵測通過僅代表 binary 在 PATH，<b>不保證已登入</b>，請於外部終端機完成登入。</p>
          <OnboardingDepRow
            v-for="d in ob.cliDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />
          <p class="ob-hint" style="margin-top:14px">Analyzer 需要 Ollama + 至少一個模型。</p>
          <OnboardingDepRow
            v-for="d in ob.analyzerDeps.value"
            :key="d.id"
            :dep="d"
            :installing="ob.installing.value"
            @install="ob.install(d)"
          />
          <div class="ob-model-row">
            <span class="ob-model-label">已安裝模型：</span>
            <span v-if="ob.models.value.length" class="ob-model-list">{{ ob.models.value.join(', ') }}</span>
            <span v-else class="ob-model-empty">（無）</span>
            <button class="ob-btn small" @click="ob.pullModel()">下載 {{ ob.gate.value?.suggested_model }}</button>
          </div>
          <div class="ob-row-actions">
            <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? '偵測中…' : '重新偵測' }}</button>
          </div>
        </section>

        <!-- Step 3 -->
        <section v-else>
          <p class="ob-hint">全部必要項目就緒後即可進入主畫面。</p>
          <ul class="ob-gate">
            <li :class="{ ok: ob.foundationReady.value }"><span>{{ ob.foundationReady.value ? '✓' : '○' }}</span> 基礎環境全部就緒</li>
            <li :class="{ ok: ob.hasAnyCli.value }"><span>{{ ob.hasAnyCli.value ? '✓' : '○' }}</span> 至少一個 Agent CLI</li>
            <li :class="{ ok: ob.analyzerReady.value }"><span>{{ ob.analyzerReady.value ? '✓' : '○' }}</span> Ollama + 至少一個模型</li>
          </ul>
          <div class="ob-row-actions">
            <button class="ob-btn ghost" :disabled="ob.loading.value" @click="ob.refresh()">{{ ob.loading.value ? '偵測中…' : '重新偵測' }}</button>
          </div>
        </section>

        <!-- Install log -->
        <div v-if="ob.logLines.value.length" class="ob-log">
          <div v-for="(l, i) in ob.logLines.value" :key="i" class="ob-log-line">{{ l }}</div>
        </div>
      </div>

      <footer class="ob-footer">
        <button v-if="step > 1" class="ob-btn ghost" @click="step--">上一步</button>
        <span class="ob-spacer" />
        <button v-if="step < 3" class="ob-btn primary" @click="step++">下一步</button>
        <button
          v-else
          class="ob-btn primary"
          :disabled="!ob.allRequiredReady.value"
          :title="ob.allRequiredReady.value ? '' : '尚有必要項目未就緒'"
          @click="ob.markComplete().then(() => emit('complete'))"
        >進入 Agent-Team</button>
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

.ob-model-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 8px; flex-wrap: wrap; }
.ob-model-label { color: var(--text-secondary); }
.ob-model-list { color: var(--success-fg); font-family: ui-monospace, monospace; font-size: 11px; }
.ob-model-empty { color: var(--text-muted); }

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
