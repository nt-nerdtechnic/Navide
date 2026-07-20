// Grid layout presets for the grid view mode. 'auto' shows every pane at once
// (column count derived from pane count); fixed presets cap the panes shown per
// page and page through the rest.
export type GridPreset = 'auto' | '2x1' | '2x2' | '3x3'

const PRESET_DIMS: Record<Exclude<GridPreset, 'auto'>, { cols: number; rows: number }> = {
  '2x1': { cols: 2, rows: 1 },
  '2x2': { cols: 2, rows: 2 },
  '3x3': { cols: 3, rows: 3 },
}

export function parseGridPreset(v: string | null | undefined): GridPreset {
  return v === '2x1' || v === '2x2' || v === '3x3' ? v : 'auto'
}

export function gridPresetDims(preset: GridPreset): { cols: number; rows: number } | null {
  return preset === 'auto' ? null : PRESET_DIMS[preset]
}

export function gridPageCount(paneCount: number, preset: GridPreset): number {
  const d = gridPresetDims(preset)
  if (!d) return 1
  return Math.max(1, Math.ceil(paneCount / (d.cols * d.rows)))
}

/** Panes on the given page. Out-of-range pages clamp to the last page. */
export function gridPageSlice<T>(panes: T[], preset: GridPreset, page: number): T[] {
  const d = gridPresetDims(preset)
  if (!d) return panes
  const cap = d.cols * d.rows
  const p = Math.min(Math.max(0, page), gridPageCount(panes.length, preset) - 1)
  return panes.slice(p * cap, p * cap + cap)
}
