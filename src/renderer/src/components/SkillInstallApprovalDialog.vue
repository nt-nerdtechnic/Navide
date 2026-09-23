<script setup lang="ts">
/**
 * The user's side of an agent's skills_install call. The MCP tool only files a
 * pending request; nothing is written to the shared skills library until the
 * user approves it here. Requests queue and are shown one at a time; a request
 * decided in another window (or expired) is dropped via the resolved event.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'

interface SkillSource {
  kind?: string
  path?: string
  repository?: string
  commit?: string
  subdir?: string
}

export interface SkillInstallApproval {
  approval_id: string
  owner: string
  name: string
  source: SkillSource
  digest: string
  files: { path: string; size: number; script?: boolean; executable?: boolean }[]
  skill_md: string
  warnings: string[]
  targets: string[] | null
  expires_at: number
  status: string
}

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()

const queue = ref<SkillInstallApproval[]>([])
const busy = ref(false)
const error = ref('')
const showSkillMd = ref(false)
const failed = ref(false)
const now = ref(Date.now())
const current = computed(() => queue.value[0] ?? null)
// The backend expires requests lazily without an event, so the dialog checks the clock itself.
const expired = computed(() => !!current.value && current.value.expires_at * 1000 <= now.value)

function enqueue(approval: SkillInstallApproval): void {
  if (!approval?.approval_id || queue.value.some((a) => a.approval_id === approval.approval_id)) return
  queue.value.push(approval)
}

function drop(approvalId: string): void {
  queue.value = queue.value.filter((a) => a.approval_id !== approvalId)
}

async function refresh(): Promise<void> {
  try {
    const res = await props.backend.send<{ approvals: SkillInstallApproval[] }>('skills.install_approvals.list')
    if (!res.ok || !res.payload) return
    const pending = new Set(res.payload.approvals.map((a) => a.approval_id))
    queue.value = queue.value.filter((a) => pending.has(a.approval_id))
    res.payload.approvals.forEach(enqueue)
  } catch {
    // Disconnected: the reconnect watcher below asks again.
  }
}

const sourceLabel = computed(() => {
  const source = current.value?.source
  if (!source) return ''
  if (source.kind === 'local') return source.path ?? ''
  const commit = source.commit ? `@${source.commit.slice(0, 12)}` : ''
  const subdir = source.subdir && source.subdir !== '.' ? `/${source.subdir}` : ''
  return `${source.repository ?? ''}${commit}${subdir}`
})

const targetsLabel = computed(() => {
  const targets = current.value?.targets
  if (targets === null || targets === undefined) return t('skill-approval.targets-all')
  return targets.length ? targets.join(', ') : t('skill-approval.targets-none')
})

const expiresLabel = computed(() =>
  current.value ? new Date(current.value.expires_at * 1000).toLocaleTimeString() : '',
)

watch(() => current.value?.approval_id, () => {
  error.value = ''
  failed.value = false
  showSkillMd.value = false
})

async function decide(approve: boolean): Promise<void> {
  const approval = current.value
  if (!approval || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await props.backend.send<{ approval: { status: string; error: string | null } }>(
      'skills.install_approval.decide',
      { approval_id: approval.approval_id, approve },
      120_000,
    )
    if (!res.ok) {
      error.value = res.error?.message ?? t('skill-approval.failed')
      // Already decided elsewhere or expired: nothing left to decide here.
      if (res.error?.code === 'SKILL_APPROVAL_NOT_PENDING' || res.error?.code === 'SKILL_APPROVAL_NOT_FOUND') {
        drop(approval.approval_id)
      }
    } else if (res.payload?.approval.status === 'failed') {
      failed.value = true
      error.value = res.payload.approval.error || t('skill-approval.failed')
    } else {
      drop(approval.approval_id)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

const offs: (() => void)[] = []
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 5_000)
  offs.push(props.backend.on('skills.install_approval_request', (raw) => enqueue(raw as SkillInstallApproval)))
  offs.push(props.backend.on('skills.install_approval_resolved', (raw) => {
    const { approval_id: approvalId, status } = raw as { approval_id: string; status: string }
    // A failed install stays open so the user can read why.
    if (status !== 'failed' || current.value?.approval_id !== approvalId) drop(approvalId)
  }))
  void refresh()
})
onBeforeUnmount(() => {
  offs.forEach((off) => off())
  clearInterval(clock)
})
watch(() => props.backend.status.value, (status) => { if (status === 'connected') void refresh() })
</script>

<template>
  <div v-if="current" class="sa-page" role="dialog" aria-modal="true">
    <section class="sa-dialog">
      <header class="sa-top">
        <div>
          <div class="sa-kicker">{{ $t('skill-approval.kicker') }}</div>
          <h1>{{ $t('skill-approval.title', { name: current.name }) }}</h1>
          <p class="sa-desc">{{ $t('skill-approval.desc') }}</p>
        </div>
        <span v-if="queue.length > 1" class="sa-badge">{{ $t('skill-approval.queue', { count: queue.length }) }}</span>
      </header>

      <main class="sa-main">
        <dl class="sa-facts">
          <dt>{{ $t('skill-approval.requester') }}</dt><dd>{{ current.owner }}</dd>
          <dt>{{ $t('skill-approval.source') }}</dt><dd class="sa-mono">{{ sourceLabel }}</dd>
          <dt>{{ $t('skill-approval.digest') }}</dt><dd class="sa-mono">{{ current.digest.slice(0, 12) }}</dd>
          <dt>{{ $t('skill-approval.targets') }}</dt><dd>{{ targetsLabel }}</dd>
          <dt>{{ $t('skill-approval.expires') }}</dt><dd>{{ expiresLabel }}</dd>
        </dl>

        <ul v-if="current.warnings.length" class="sa-warnings">
          <li v-for="warning in current.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <div class="sa-card-label">{{ $t('skill-approval.files', { count: current.files.length }) }}</div>
        <ul class="sa-files">
          <li v-for="file in current.files" :key="file.path">
            <span class="sa-mono">{{ file.path }}</span>
            <span v-if="file.script || file.executable" class="sa-flag">{{ $t('skill-approval.script') }}</span>
            <span class="sa-size">{{ file.size }} B</span>
          </li>
        </ul>

        <button class="sa-toggle" type="button" @click="showSkillMd = !showSkillMd">
          {{ showSkillMd ? $t('skill-approval.hide-skill-md') : $t('skill-approval.show-skill-md') }}
        </button>
        <pre v-if="showSkillMd" class="sa-skill-md">{{ current.skill_md }}</pre>

        <p class="sa-note">{{ $t('skill-approval.write-note') }}</p>
        <pre v-if="expired" class="sa-error">{{ $t('skill-approval.expired') }}</pre>
        <pre v-else-if="error" class="sa-error">{{ error }}</pre>
      </main>

      <footer class="sa-footer">
        <span />
        <button v-if="expired || failed" class="sa-btn ghost sa-dismiss nv-btn" @click="drop(current.approval_id)">
          {{ $t('skill-approval.dismiss') }}
        </button>
        <template v-else>
          <button class="sa-btn ghost sa-reject nv-btn" :disabled="busy" @click="decide(false)">
            {{ $t('skill-approval.reject') }}
          </button>
          <button class="sa-btn primary sa-approve nv-btn nv-btn--primary" :disabled="busy" @click="decide(true)">
            {{ busy ? $t('skill-approval.installing') : $t('skill-approval.approve') }}
          </button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.sa-page {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 142);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.sa-dialog {
  width: min(var(--modal-w-standard), 92vw);
  max-height: min(720px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
}
.sa-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 28px 18px; border-bottom: 1px solid var(--border-muted); }
.sa-kicker { color: var(--accent-bright); font-size: var(--font-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 6px 0 0; color: var(--text-bright); font-size: 20px; overflow-wrap: anywhere; }
.sa-desc { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
.sa-badge { flex: none; font-size: var(--font-2xs); border-radius: 99px; padding: 2px 9px; background: var(--bg-subtle); color: var(--text-muted); }
.sa-main { padding: 18px 28px; overflow: auto; }
.sa-facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0 0 14px; font-size: 12.5px; }
.sa-facts dt { color: var(--text-muted); }
.sa-facts dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
.sa-mono { font-family: var(--font-mono, monospace); }
.sa-warnings { margin: 0 0 14px; padding: 10px 14px 10px 28px; border: 1px solid var(--attention-fg); border-radius: 10px; color: var(--attention-fg); font-size: 12.5px; line-height: 1.5; }
.sa-card-label { color: var(--text-muted); font-size: var(--font-2xs); letter-spacing: .06em; text-transform: uppercase; }
.sa-files { list-style: none; margin: 6px 0 12px; padding: 8px 12px; max-height: 150px; overflow: auto; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-subtle); font-size: 12px; }
.sa-files li { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.sa-files .sa-mono { overflow-wrap: anywhere; }
.sa-flag { font-size: var(--font-2xs); color: var(--attention-fg); }
.sa-size { margin-left: auto; color: var(--text-muted); flex: none; }
.sa-toggle { border: none; background: none; padding: 0; color: var(--accent-bright); cursor: pointer; font-size: 12.5px; }
.sa-skill-md, .sa-error {
  margin: 8px 0 0; padding: 10px 12px; max-height: 240px; overflow: auto;
  border-radius: 8px; background: var(--bg-subtle); color: var(--text-secondary);
  font-size: 11.5px; line-height: var(--lh-base); white-space: pre-wrap; overflow-wrap: anywhere;
}
.sa-error { color: var(--danger-fg); max-height: 120px; }
.sa-note { margin: 12px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.sa-footer { display: flex; align-items: center; gap: 10px; padding: 14px 28px; border-top: 1px solid var(--border-muted); }
.sa-footer span { flex: 1; }
.sa-btn { border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 8px 13px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); font-size: var(--font-sm); transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.sa-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.sa-btn.ghost { background: transparent; }
.sa-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); }
.sa-btn.primary:hover:not(:disabled) { background: var(--accent-focus); border-color: var(--accent-focus); }
.sa-btn:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 620px) {
  .sa-page { padding: 14px; }
  .sa-dialog { width: calc(100vw - 28px); }
  .sa-top, .sa-main, .sa-footer { padding-left: 18px; padding-right: 18px; }
}
</style>
