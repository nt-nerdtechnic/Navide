export interface HostFilePickerRow {
  id: string
  label: string
  path: string
}

export interface HostFilePickerInit {
  invocationId: string
  query: string
  theme: string
  homePath: string
}

export interface HostFilePickerBridge {
  ready(listener: (init: HostFilePickerInit) => void): void
  search(invocationId: string, query: string): Promise<HostFilePickerRow[]>
  select(invocationId: string, rowId: string): void
  cancel(invocationId: string): void
}
