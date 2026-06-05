import { ref, computed, type Ref } from 'vue'

/**
 * Virtual scrolling math for a fixed line-height list. Only the visible window
 * (plus a small overscan) is rendered; everything is positioned by translating
 * the rendered slab down by `offsetY`.
 */
export function useVirtualScroll(lineCount: Ref<number>, lineHeight: number, overscan = 4) {
  const scrollTop = ref(0)
  const viewportHeight = ref(400)

  const startLine = computed(() =>
    Math.max(0, Math.floor(scrollTop.value / lineHeight) - overscan)
  )
  const visibleCount = computed(() =>
    Math.ceil(viewportHeight.value / lineHeight) + overscan * 2
  )
  const endLine = computed(() =>
    Math.min(lineCount.value, startLine.value + visibleCount.value)
  )
  const offsetY = computed(() => startLine.value * lineHeight)
  const totalHeight = computed(() => lineCount.value * lineHeight)

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
