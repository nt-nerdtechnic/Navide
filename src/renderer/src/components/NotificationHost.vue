<script setup lang="ts">
import { useNotify } from '../composables/useNotify'

const { toasts, dialog, dismissToast, resolveDialog } = useNotify()

const toastIcon = { success: '✓', error: '✕', info: 'ℹ' } as const
</script>

<template>
  <Teleport to="body">
    <!-- Toast stack (non-blocking, auto-dismiss) -->
    <div class="toast-stack">
      <transition-group name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="t.type"
          @click="dismissToast(t.id)"
        >
          <span class="toast-icon">{{ toastIcon[t.type] }}</span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </transition-group>
    </div>

    <!-- Alert / Confirm dialog (blocking) -->
    <div v-if="dialog" class="modal" @keydown.esc="resolveDialog(false)">
      <div class="card" :class="dialog.kind">
        <header>
          <span class="dot"></span>
          <strong>{{ dialog.title }}</strong>
        </header>
        <div class="body">
          <pre>{{ dialog.message }}</pre>
        </div>
        <footer>
          <button
            v-if="dialog.kind === 'confirm'"
            class="ghost"
            @click="resolveDialog(false)"
          >
            {{ dialog.cancelText }}
          </button>
          <button class="primary" @click="resolveDialog(true)">
            {{ dialog.confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Toast stack ──────────────────────────────────────────────────────── */
.toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 240px;
  max-width: 420px;
  padding: 10px 14px;
  background: #161b22;
  border: 1px solid #30363d;
  border-left: 4px solid #8b949e;
  border-radius: 6px;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  cursor: pointer;
}
.toast.success {
  border-left-color: #3fb950;
}
.toast.error {
  border-left-color: #f85149;
}
.toast.info {
  border-left-color: #58a6ff;
}
.toast-icon {
  flex-shrink: 0;
  font-weight: 700;
}
.toast.success .toast-icon {
  color: #3fb950;
}
.toast.error .toast-icon {
  color: #f85149;
}
.toast.info .toast-icon {
  color: #58a6ff;
}
.toast-msg {
  flex: 1;
  word-break: break-word;
  white-space: pre-wrap;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

/* ── Dialog (alert / confirm) ─────────────────────────────────────────── */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
}
.card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-left: 4px solid #58a6ff;
  border-radius: 8px;
  width: min(520px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.card.confirm {
  border-left-color: #d29922;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #21262d;
  background: #161b22;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #58a6ff;
  box-shadow: 0 0 0 4px rgba(88, 166, 255, 0.2);
}
.card.confirm .dot {
  background: #d29922;
  box-shadow: 0 0 0 4px rgba(210, 153, 34, 0.2);
}
header strong {
  color: #e6edf3;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
}
.body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #e6edf3;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid #21262d;
  background: #0d1117;
}
button {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
button.primary {
  background: #238636;
  border-color: #2ea043;
  color: #fff;
  font-weight: 600;
}
button.primary:hover {
  background: #2ea043;
}
button.ghost {
  background: transparent;
}
button.ghost:hover {
  background: #21262d;
}
</style>
