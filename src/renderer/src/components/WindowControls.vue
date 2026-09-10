<script setup lang="ts">
/**
 * Minimise / maximise / close, drawn where the system will not draw them.
 *
 * Every window in this app is frameless so the renderer can own the title bar.
 * macOS still paints its traffic lights over that, which is why this was never
 * missed — but on Windows and Linux a frameless window has no controls at all,
 * so without this component those platforms ship a window that cannot be
 * minimised or closed from inside the app.
 *
 * Renders nothing on macOS rather than being conditionally imported, so the
 * title bars can include it unconditionally and none of them has to carry a
 * platform check of its own.
 *
 * It also renders nothing without the Host bridge. That is not defensive
 * coding — it is the plugin case: `EditorWindowApp` is mounted both as a Host
 * window and inside the mini-IDE plugin bundle, and a plugin sandbox has
 * `window.nav`, never `window.agentTeam`. Drawing three buttons there that
 * cannot act on anything would be worse than drawing none, and those windows
 * get the system's own frame instead (see `systemFrameUnlessMac`).
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { needsDrawnWindowControls } from '../../../shared/osplat'

const shown = needsDrawnWindowControls() && Boolean(window.agentTeam?.windowControls)
const maximized = ref(false)
let dispose: (() => void) | null = null

onMounted(async () => {
  if (!shown) return
  const controls = window.agentTeam?.windowControls
  if (!controls) return
  try {
    maximized.value = (await controls.isMaximized()).maximized
  } catch {
    // A window that will not answer is not a reason to hide the buttons —
    // the icon simply starts in its restore-from-maximised state.
  }
  dispose = controls.onMaximizeChanged((value) => {
    maximized.value = value
  })
})

onBeforeUnmount(() => {
  dispose?.()
  dispose = null
})

const minimize = (): void => void window.agentTeam?.windowControls?.minimize()
const close = (): void => void window.agentTeam?.windowControls?.close()
const toggleMaximize = async (): Promise<void> => {
  const result = await window.agentTeam?.windowControls?.toggleMaximize()
  if (result) maximized.value = result.maximized
}
</script>

<template>
  <div v-if="shown" class="win-controls" role="group" aria-label="Window controls">
    <button
      class="win-control"
      type="button"
      title="Minimize"
      aria-label="Minimize"
      @mousedown.stop
      @click="minimize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 5h10" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
    </button>
    <button
      class="win-control"
      type="button"
      :title="maximized ? 'Restore' : 'Maximize'"
      :aria-label="maximized ? 'Restore' : 'Maximize'"
      @mousedown.stop
      @click="toggleMaximize"
    >
      <svg v-if="!maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none" />
        <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
    </button>
    <button
      class="win-control win-control--close"
      type="button"
      title="Close"
      aria-label="Close"
      @mousedown.stop
      @click="close"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.win-controls {
  /* Pinned rather than a flex item: the title bars centre their content, and
     a control cluster that drifts with the content is not a window control. */
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  display: flex;
  align-items: stretch;
  -webkit-app-region: no-drag;
  z-index: 1;
}

.win-control {
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--text-muted, #9aa4b2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  padding: 0;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.win-control:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.18));
  color: var(--text-strong, #e6eaf1);
}

.win-control:focus-visible {
  outline: 1px solid var(--accent, #7b94f0);
  outline-offset: -3px;
}

/* The one control whose hover colour is a convention rather than a choice:
   every desktop environment paints close red, and a grey one reads as
   disabled. */
.win-control--close:hover {
  background: #c42b1c;
  color: #ffffff;
}
</style>

<style>
/* Global, not scoped, and matched through `:has` rather than by class name:
   the title bars are called `.titlebar`, `.ide-titlebar` and `.toolbar`
   depending on the window, and `.toolbar` is generic enough that naming it
   here would style bars that are not title bars.

   Two things have to change on the bar that hosts the controls. It has to be
   a positioning context, because none of the three is one today and the
   cluster is absolutely positioned. And the space reserved on the left for
   the macOS traffic lights (80-84px, depending on the bar) is dead where we
   draw our own controls, while the room is needed on the right instead.

   Keyed off the attribute the renderer entry sets, so all of this is inert on
   macOS. */
:root[data-window-controls='drawn'] :has(> .win-controls) {
  position: relative;
  padding-left: 8px;
  padding-right: 146px;
}
</style>
