import { ref } from 'vue'
import {
  PANE_ID_MIME,
  writeCliPaneDragPayload,
  type CliContextPayload,
} from '../lib/cliContext'

interface PaneReorderDragOptions {
  payloadFor: (paneId: string) => CliContextPayload | null
  reorder: (fromId: string, toId: string) => void
  handOff: (paneId: string, screenX: number, screenY: number) => void
}

/** Shared HTML5 drag contract for the lightweight pane representations used by
 * Auto, Spotlight, and Fullscreen layouts. */
export function usePaneReorderDrag(options: PaneReorderDragOptions) {
  const dragOverPaneId = ref('')
  const draggingPaneId = ref('')

  function onDragStart(e: DragEvent, paneId: string): void {
    const payload = options.payloadFor(paneId)
    if (!payload || !e.dataTransfer) return
    writeCliPaneDragPayload(e.dataTransfer, payload)
    e.dataTransfer.effectAllowed = 'move'
    draggingPaneId.value = paneId
  }

  function onDragEnd(e: DragEvent): void {
    const paneId = draggingPaneId.value
    draggingPaneId.value = ''
    dragOverPaneId.value = ''
    if (!paneId || e.dataTransfer?.dropEffect !== 'none') return
    options.handOff(paneId, e.screenX, e.screenY)
  }

  function onDragOver(e: DragEvent, targetPaneId: string): void {
    if (
      draggingPaneId.value === targetPaneId
      || !e.dataTransfer?.types.includes(PANE_ID_MIME)
    ) return
    e.preventDefault()
    dragOverPaneId.value = targetPaneId
  }

  function onDragLeave(e: DragEvent, targetPaneId: string): void {
    const target = e.currentTarget as HTMLElement | null
    if (target?.contains(e.relatedTarget as Node | null)) return
    if (dragOverPaneId.value === targetPaneId) dragOverPaneId.value = ''
  }

  function onDrop(e: DragEvent, targetPaneId: string): void {
    dragOverPaneId.value = ''
    const draggedPaneId = e.dataTransfer?.getData(PANE_ID_MIME) || ''
    if (!draggedPaneId || draggedPaneId === targetPaneId) return
    options.reorder(draggedPaneId, targetPaneId)
  }

  return {
    dragOverPaneId,
    draggingPaneId,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
  }
}
