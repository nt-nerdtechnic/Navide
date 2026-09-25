<script setup lang="ts">
import { native } from '../composables/native'

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
 * `window.nav`, never `native`. Drawing three buttons there that
 * cannot act on anything would be worse than drawing none, and those windows
 * get the system's own frame instead (see `systemFrameUnlessMac`).
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { needsDrawnWindowControls } from '../lib/osplat'

const shown = needsDrawnWindowControls() && Boolean(native?.windowControls)
const maximized = ref(false)
let dispose: (() => void) | null = null

onMounted(async () => {
  if (!shown) return
  const controls = native?.windowControls
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

const minimize = (): void => void native?.windowControls?.minimize()
const close = (): void => void native?.windowControls?.close()
const toggleMaximize = async (): Promise<void> => {
  const result = await native?.windowControls?.toggleMaximize()
  if (result) maximized.value = result.maximized
}
</script>

<template>
  <!-- Stays in the title bar even though the buttons no longer do. The bar's
       own padding rule keys off this marker (`:has(> .win-controls-anchor)`),
       so the room reserved on the right for the teleported cluster still
       belongs to the bar that hosts it. Hidden from assistive tech: it is a
       marker, not content. -->
  <span v-if="shown" class="win-controls-anchor" aria-hidden="true"></span>

  <!-- Out of the title bar's stacking context entirely.
       `.titlebar` is `position: absolute; z-index: 200`, which makes it a
       stacking context — a child of it cannot rise above anything outside it
       however large its own z-index, and `position: fixed` does not escape one
       either. Every full-screen overlay in this app (999 … 3100) therefore
       covered the only buttons Windows and Linux have for closing the window:
       open Settings and the window could be left only with Alt+F4. macOS never
       showed it, because its traffic lights are painted by the OS above the
       page. Teleporting to <body> puts the cluster in the root stacking
       context, which is the only place `--z-window-controls` can mean what it
       says. -->
  <Teleport v-if="shown" to="body">
    <div class="win-controls" role="group" :aria-label="i18n.global.t('windowControls.group')">
      <button
        class="win-control"
        type="button"
        :title="i18n.global.t('windowControls.minimize')"
        :aria-label="i18n.global.t('windowControls.minimize')"
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
        :title="i18n.global.t(maximized ? 'windowControls.restore' : 'windowControls.maximize')"
        :aria-label="i18n.global.t(maximized ? 'windowControls.restore' : 'windowControls.maximize')"
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
        :title="i18n.global.t('action.close')"
        :aria-label="i18n.global.t('action.close')"
        @mousedown.stop
        @click="close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.win-controls-anchor {
  /* Never rendered — `:has()` matches it in the DOM regardless, which is all
     the bar's padding rule needs. `display: none` keeps a marker element from
     becoming a flex item in a bar that centres its content. */
  display: none;
}

.win-controls {
  /* Pinned to the viewport, not to the bar: teleported to <body>, there is no
     bar to be pinned to any more. The title bars all sit at the top of their
     window and reserve room on the right for exactly this cluster, so the two
     land on top of each other. */
  position: fixed;
  top: 0;
  right: 0;
  /* Not `100%` — that is the viewport once this lives on <body>. The main
     window publishes the bar's height as a variable; the editor window does
     not load those styles, and its own bar is the fallback's 38px. */
  height: var(--titlebar-height, 38px);
  display: flex;
  align-items: stretch;
  /* Only the buttons take the pointer. The box is already exactly as wide as
     the three of them, but a transparent fixed box that swallowed clicks would
     take that slice of the title bar's drag region with it — the same bug as
     an invisible full-screen overlay, in miniature. */
  pointer-events: none;
  -webkit-app-region: no-drag;
  z-index: var(--z-window-controls);
}

.win-control {
  width: 46px;
  pointer-events: auto;
  -webkit-app-region: no-drag;
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

   Matched on the marker the component leaves behind rather than on the cluster
   itself, because the cluster is teleported to <body> and is no longer a child
   of the bar at all.

   One thing has to change on the bar that hosts the controls: the space
   reserved on the left for the macOS traffic lights (80-84px, depending on the
   bar) is dead where we draw our own controls, while the room is needed on the
   right instead, under the teleported cluster.

   Note what is deliberately NOT here: a `position`. An earlier version made the
   host bar a positioning context, because the cluster used to be absolutely
   positioned inside it. That rule beat `.titlebar { position: absolute }` and
   dragged the bar out of its overlay into the grid flow, leaving an empty band
   above the content (Linux) and the drawn controls under the first-launch
   Welcome overlay (Windows and Linux). Neutralising it with `:where()` fixed
   the symptom; teleporting the cluster removes the reason it existed, so the
   declaration is gone instead of defused. windowControlsStacking.test.ts
   asserts it stays gone.

   Keyed off the attribute the renderer entry sets, so all of this is inert on
   macOS. */
:root[data-window-controls='drawn'] :has(> .win-controls-anchor) {
  padding-left: 8px;
  padding-right: 146px;
}
</style>
