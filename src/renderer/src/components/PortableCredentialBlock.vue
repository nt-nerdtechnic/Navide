<script setup lang="ts">
import { computed, ref } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import type { useCliProfiles, PortableCredentialMeta } from '../composables/useCliProfiles'

// One account slot's portable credential — the value the user pasted (or
// pulled from the cloud) that new panes of this agent are handed in their
// environment — and where the account's other devices stand on it.
//
// The value crosses this component exactly once, from the input to the save
// request. Nothing keeps it afterwards: the draft is emptied the moment the
// request is sent, success or not, and what the block shows from then on is
// metadata the backend returns.
const props = defineProps<{
  api: ReturnType<typeof useCliProfiles>
  agentKey: string
  slotId: string
  /** Metadata for this slot, or null when nothing is stored and the vendor
   *  descriptor has not been fetched yet. */
  meta: PortableCredentialMeta | null
  /** True for a card standing for another device's named account: there is
   *  nothing local to paste into, only a cloud copy to take or drop. (A
   *  positive flag on purpose — an absent boolean prop is `false` in Vue.) */
  cloudOnly?: boolean
}>()

const { toast } = useNotify()
const t = i18n.global.t

const draft = ref('')
const open = ref(false)
const busy = ref(false)
const cloudBusy = ref<string | null>(null)

const cloudStatus = computed(() => props.api.cloudStatus.value)
const cloudError = computed(() => props.api.cloudError.value)
const profileId = computed(() => (props.slotId === '__default__' ? null : props.slotId))

const configured = computed(() => Boolean(props.meta?.configured))
const source = computed(() => props.meta?.source ?? (configured.value ? 'local' : 'none'))
const selected = computed(() => Boolean(props.meta?.enabled))
const available = computed(() => props.meta?.available !== false)
const cloud = computed(() => props.api.cloudFor(props.agentKey, profileId.value))

const flag = computed(() => {
  if (!configured.value) return t('settings.accounts.cli.portable-absent')
  return source.value === 'imported'
    ? t('settings.accounts.cli.portable-imported')
    : t('settings.accounts.cli.portable-present')
})

async function openForm(): Promise<void> {
  // An empty slot's list entry carries no vendor descriptor (the list only
  // holds configured slots); the command and docs are exactly what a person
  // pasting for the first time needs, so they are fetched on the way in.
  if (!props.meta?.obtainCommand && !props.meta?.env) {
    await props.api.portableDescribe(props.agentKey, profileId.value)
  }
  open.value = true
}

function cancel(): void {
  open.value = false
  draft.value = ''
}

async function save(): Promise<void> {
  const value = draft.value.trim()
  draft.value = ''
  if (!value || busy.value) return
  busy.value = true
  try {
    const res = await props.api.portableSet(props.agentKey, profileId.value, value)
    if (!res.ok) {
      toast(res.message || t('settings.accounts.cli.portable-save-failed'), { type: 'error' })
      return
    }
    open.value = false
    toast(t('settings.accounts.cli.portable-saved'), { type: 'success' })
  } finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (!(await props.api.portableClear(props.agentKey, profileId.value))) {
      toast(t('settings.accounts.cli.portable-clear-failed'), { type: 'error' })
    }
  } finally {
    busy.value = false
  }
}

async function select(enabled: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const res = await props.api.portableEnable(props.agentKey, props.slotId, enabled)
    if (!res.ok) toast(res.message || t('settings.accounts.cli.portable-select-failed'), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function useCloud(itemId: string): Promise<void> {
  if (cloudBusy.value) return
  cloudBusy.value = itemId
  try {
    const res = await props.api.useFromCloud(itemId)
    if (!res.ok) toast(res.message || t('settings.accounts.cli.cloud-use-failed'), { type: 'error' })
  } finally {
    cloudBusy.value = null
  }
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : new Date(at).toLocaleString()
}
</script>

<template>
  <div class="cli-card-portable">
    <div class="cli-portable-head">
      <span class="cli-portable-label">{{ $t('settings.accounts.cli.portable-label') }}</span>
      <span class="cli-portable-flag" :class="{ on: configured }">{{ flag }}</span>
      <span v-if="selected" class="cli-portable-flag selected">{{
        $t('settings.accounts.cli.portable-selected')
      }}</span>
      <code v-if="meta?.env" class="cli-portable-env">{{ meta.env }}</code>
    </div>
    <p v-if="configured && !available" class="cli-portable-warn">
      {{ $t('settings.accounts.cli.portable-unavailable') }}
    </p>
    <p v-if="configured && meta?.shadowedBy?.length" class="cli-portable-warn">
      {{ $t('settings.accounts.cli.portable-shadowed', { files: meta.shadowedBy.join(', ') }) }}
    </p>

    <form v-if="open" class="cli-portable-form" @submit.prevent="save">
      <input
        v-model="draft"
        type="password"
        class="cli-portable-input"
        autocomplete="off"
        spellcheck="false"
        :placeholder="
          meta?.obtainCommand
            ? $t('settings.accounts.cli.portable-placeholder', { command: meta.obtainCommand })
            : $t('settings.accounts.cli.portable-placeholder-plain')
        "
      />
      <button type="submit" class="cli-btn primary sm" :disabled="!draft.trim() || busy">
        {{ $t('settings.accounts.cli.portable-save') }}
      </button>
      <button type="button" class="cli-btn ghost sm" @click="cancel">
        {{ $t('settings.accounts.cli.cancel') }}
      </button>
    </form>
    <div v-else class="cli-portable-actions">
      <!-- An imported credential is replaced from the device that pasted it;
           here it can only be selected or removed. -->
      <button
        v-if="source !== 'imported' && !cloudOnly"
        class="cli-btn ghost sm"
        :disabled="busy"
        @click="openForm"
      >
        {{
          configured
            ? $t('settings.accounts.cli.portable-replace')
            : $t('settings.accounts.cli.portable-paste')
        }}
      </button>
      <button
        v-if="configured && !selected"
        class="cli-btn ghost sm"
        :disabled="busy || !available"
        @click="select(true)"
      >
        {{ $t('settings.accounts.cli.portable-select') }}
      </button>
      <button v-if="configured && selected" class="cli-btn ghost sm" :disabled="busy" @click="select(false)">
        {{ $t('settings.accounts.cli.portable-deselect') }}
      </button>
      <button v-if="configured" class="cli-btn ghost sm" :disabled="busy" @click="remove">
        {{ $t('settings.accounts.cli.portable-remove') }}
      </button>
      <a v-if="meta?.docsUrl" class="cli-portable-docs" :href="meta.docsUrl" target="_blank" rel="noreferrer">
        {{ $t('settings.accounts.cli.portable-docs') }}
      </a>
    </div>

    <div class="cli-portable-cloud">
      <span v-if="cloudStatus === 'off'" class="cli-cloud-note">{{ $t('settings.accounts.cli.cloud-off') }}</span>
      <span v-else-if="cloudStatus !== 'ok'" class="cli-cloud-note">{{
        $t('settings.accounts.cli.cloud-status-' + cloudStatus, { error: cloudError })
      }}</span>
      <template v-else>
        <span v-if="!cloud.length" class="cli-cloud-note">{{ $t('settings.accounts.cli.cloud-none') }}</span>
        <div v-for="c in cloud" :key="c.itemId" class="cli-cloud-row">
          <span class="cli-cloud-badge" :class="'st-' + c.state">{{
            $t('settings.accounts.cli.cloud-state-' + c.state)
          }}</span>
          <span v-if="c.updatedAt" class="cli-cloud-when">{{
            $t('settings.accounts.cli.cloud-updated', {
              when: formatWhen(c.updatedAt),
              device: c.deviceId || $t('settings.sync.other-device'),
            })
          }}</span>
          <span v-if="!c.readable" class="cli-cloud-note">{{ $t('settings.accounts.cli.cloud-unreadable') }}</span>
          <button
            v-else-if="c.state === 'remote-only'"
            class="cli-btn ghost sm"
            :disabled="cloudBusy !== null"
            @click="useCloud(c.itemId)"
          >
            {{
              cloudBusy === c.itemId
                ? $t('settings.accounts.cli.cloud-using')
                : $t('settings.accounts.cli.cloud-use')
            }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cli-card-portable {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-muted);
  font-size: var(--font-2xs);
}
.cli-portable-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cli-portable-label { font-weight: 600; color: var(--text-secondary); }
.cli-portable-flag {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}
.cli-portable-flag.on {
  color: var(--accent-fg);
  background: var(--accent-subtle, var(--bg-muted));
  border-color: var(--accent-muted, var(--border-default));
}
.cli-portable-flag.selected {
  color: var(--success-fg, var(--accent-fg));
  border-color: var(--success-muted, var(--accent-muted, var(--border-default)));
}
.cli-portable-env { font-size: 10px; color: var(--text-tertiary); }
.cli-portable-warn { margin: 0; color: var(--attention-fg); line-height: 1.4; }
.cli-portable-form { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cli-portable-input {
  flex: 1 1 160px;
  min-width: 0;
  font-size: var(--font-2xs);
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid var(--border-default);
  background: var(--bg-default);
  color: var(--text-primary);
}
.cli-portable-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cli-portable-docs { color: var(--accent-fg); text-decoration: none; }
.cli-portable-docs:hover { text-decoration: underline; }
.cli-portable-cloud {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 4px;
  border-top: 1px solid var(--border-default);
}
.cli-cloud-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cli-cloud-note { color: var(--text-tertiary); }
.cli-cloud-when { color: var(--text-secondary); }
.cli-cloud-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
}
.cli-cloud-badge.st-in-sync { color: var(--success-fg, var(--accent-fg)); border-color: var(--success-muted, var(--accent-muted)); }
.cli-cloud-badge.st-remote-only,
.cli-cloud-badge.st-local-only { color: var(--accent-fg); border-color: var(--accent-muted, var(--border-default)); }
.cli-cloud-badge.st-diverged,
.cli-cloud-badge.st-conflict { color: var(--attention-fg); border-color: var(--attention-muted, var(--border-default)); }

.cli-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
.cli-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.cli-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cli-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.cli-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.cli-btn.ghost { background: transparent; color: var(--text-secondary); }
.cli-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
</style>
