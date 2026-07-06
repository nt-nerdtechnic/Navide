<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { GitCredentialPrompt } from '../composables/useGit'

const props = defineProps<{
  show: boolean
  prompt: GitCredentialPrompt | null
}>()

const emit = defineEmits<{
  (e: 'submit'): void
  (e: 'cancel'): void
}>()

// Autofocus the first empty field whenever the modal (re)opens.
const usernameInputRef = ref<HTMLInputElement | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)
watch(() => props.show, (visible) => {
  if (!visible) return
  void nextTick(() => {
    const target = props.prompt?.usernameRequestId ? usernameInputRef.value : passwordInputRef.value
    target?.focus()
  })
})
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
            @keydown.enter="emit('submit')"
          />
        </div>
        <p class="cred-hint">{{ $t('label.git-credential-token') }}</p>
        <div class="cred-actions">
          <button class="btn-ghost sm" @click="emit('cancel')">{{ $t('action.cancel') }}</button>
          <button class="btn-primary" @click="emit('submit')">{{ $t('action.submit') }}</button>
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
