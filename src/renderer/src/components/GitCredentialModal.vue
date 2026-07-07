<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { GitCredentialPrompt } from '../composables/useGit'
import { useGitAccounts } from '../composables/useGitAccounts'

const props = defineProps<{
  show: boolean
  prompt: GitCredentialPrompt | null
  // When provided, offers "Save as account & bind this workspace".
  workspacePath?: string
}>()

const emit = defineEmits<{
  (e: 'submit'): void
  (e: 'cancel'): void
}>()

// Autofocus the first empty field whenever the modal (re)opens.
const usernameInputRef = ref<HTMLInputElement | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)

// Optional "save as account" flow (safeStorage-backed).
const gitAccounts = useGitAccounts()
const saveAsAccount = ref(false)
const saveLabel = ref('')

watch(() => props.show, (visible) => {
  if (!visible) return
  saveAsAccount.value = false
  saveLabel.value = ''
  if (props.workspacePath) void gitAccounts.refresh()
  void nextTick(() => {
    const target = props.prompt?.usernameRequestId ? usernameInputRef.value : passwordInputRef.value
    target?.focus()
  })
})

async function onSubmit(): Promise<void> {
  // Best-effort: persist + bind before submitting the credential so a failure
  // here never blocks the git operation that is waiting on this prompt.
  if (saveAsAccount.value && props.workspacePath && props.prompt) {
    const { host, username, password } = props.prompt
    if (username && password) {
      const ok = await gitAccounts.addAccount({
        label: saveLabel.value.trim() || `${host} (${username})`,
        host,
        username,
        token: password
      })
      if (ok) {
        const created = gitAccounts.accounts.value.find(
          (a) => a.host === host && a.username === username
        )
        if (created) await gitAccounts.bind(props.workspacePath, created.id)
      }
    }
  }
  emit('submit')
}
</script>

<template>
  <Teleport to="body">
    <template v-if="show && prompt">
      <div class="tp-backdrop" @click="emit('cancel')" />
      <div class="cred-modal" @click.stop @keydown.esc="emit('cancel')">
        <div class="cred-title">{{ $t('label.git-credential-title', { host: prompt.host }) }}</div>
        <div class="cred-field">
          <label class="cred-label">{{ $t('label.git-credential-username') }}</label>
          <input
            ref="usernameInputRef"
            v-model="prompt.username"
            class="cred-input"
            type="text"
            autocomplete="username"
            spellcheck="false"
            @keydown.enter="passwordInputRef?.focus()"
          />
        </div>
        <div class="cred-field">
          <label class="cred-label">{{ $t('label.git-credential-password') }}</label>
          <input
            ref="passwordInputRef"
            v-model="prompt.password"
            class="cred-input"
            type="password"
            autocomplete="current-password"
            spellcheck="false"
            @keydown.enter="onSubmit"
          />
        </div>
        <p class="cred-hint">{{ $t('hint.git-credential-token') }}</p>
        <template v-if="workspacePath && gitAccounts.available.value">
          <label class="cred-save-row">
            <input type="checkbox" v-model="saveAsAccount" />
            <span>{{ $t('git.account.save-and-bind') }}</span>
          </label>
          <input
            v-if="saveAsAccount"
            v-model="saveLabel"
            class="cred-input"
            type="text"
            spellcheck="false"
            :placeholder="$t('settings.accounts.label')"
          />
        </template>
        <div class="cred-actions">
          <button class="btn-ghost sm" @click="emit('cancel')">{{ $t('action.cancel') }}</button>
          <button class="btn-primary" @click="onSubmit">{{ $t('action.submit') }}</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.tp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
.cred-modal {
  position: fixed;
  z-index: 9999;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(360px, 85vw);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 12px 32px var(--shadow-scrim);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cred-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-word;
}
.cred-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cred-label {
  font-size: 11px;
  color: var(--text-secondary);
}
.cred-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  padding: 5px 8px;
}
.cred-input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.cred-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}
.cred-save-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}
.cred-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

/* Mirrors GitPane.vue's .btn-primary/.btn-ghost — scoped styles don't cross
   component boundaries, so these are redefined locally with the same tokens. */
.btn-primary {
  background: var(--success-emphasis); color: var(--text-on-emphasis); border: 1px solid var(--success-strong);
  border-radius: 5px; font-size: 12px; padding: 5px 10px; cursor: pointer;
}
.btn-primary:hover { background: var(--success-strong); }
.btn-ghost {
  background: transparent; border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }
.btn-ghost.sm { font-size: 11px; padding: 3px 7px; }
</style>
