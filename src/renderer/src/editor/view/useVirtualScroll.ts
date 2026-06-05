import { ref, computed, isRef, type Ref } from 'vue'

/**
 * Virtual scrolling math for a fixed line-height list. Only the visible window
 * (plus a small overscan) is rendered; everything is positioned by translating
 * the rendered slab down by `offsetY`.
 */
export function useVirtualScroll(lineCount: Ref<number>, lineHeight: Ref<number> | number, overscan = 4) {
  const lh = isRef(lineHeight) ? lineHeight : ref(lineHeight) as Ref<number>
  const scrollTop = ref(0)
  const viewportHeight = ref(400)

  const startLine = computed(() =>
    Math.max(0, Math.floor(scrollTop.value / lh.value) - overscan)
  )
  const visibleCount = computed(() =>
    Math.ceil(viewportHeight.value / lh.value) + overscan * 2
  )
  const endLine = computed(() =>
    Math.min(lineCount.value, startLine.value + visibleCount.value)
  )
  const offsetY = computed(() => startLine.value * lh.value)
  const totalHeight = computed(() => lineCount.value * lh.value)

  function onScroll(e: Event): void {
    scrollTop.value = (e.target as HTMLElement).scrollTop
  }

  return {
    scrollTop,
    viewportHeight,
    startLine,
    endLine,
    offsetY,
    totalHeight,
    onScroll,
  }
}
