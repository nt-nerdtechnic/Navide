<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { buildRawUrl, fileExt, previewKind } from './previewTypes'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
  // Optional metadata known at open time (e.g. from fs.read_file); when absent
  // the size is derived from the /fs/raw response headers.
  size?: number
  ext?: string
}>()

const kind = computed(() => previewKind(props.relPath) ?? 'binary')
const ext = computed(() => (props.ext ?? fileExt(props.relPath)) || 'bin')
const rawUrl = computed(() =>
  buildRawUrl(props.backend.httpUrl.value, props.workspacePath, props.relPath),
)

// ── File size ─────────────────────────────────────────────────────────────────
const fileSize = ref<number | null>(props.size ?? null)

function formatBytes(bytes: number): string {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

// Total size from a Range response: Content-Range "bytes 0-65535/123456",
// falling back to Content-Length for servers that answered 200.
function sizeFromHeaders(resp: Response): number | null {
  const range = resp.headers.get('content-range')
  const m = range?.match(/\/(\d+)\s*$/)
  if (m) return Number(m[1])
  const len = resp.headers.get('content-length')
  return len !== null && len !== '' ? Number(len) : null
}

async function loadSize(): Promise<void> {
  if (fileSize.value !== null) return
  try {
    const resp = await fetch(rawUrl.value, { headers: { Range: 'bytes=0-0' } })
    if (resp.ok) fileSize.value = sizeFromHeaders(resp)
  } catch {
    /* size stays unknown — the preview itself still works */
  }
}

// ── Image zoom ────────────────────────────────────────────────────────────────
const fitToWindow = ref(true)
const imgDims = ref('')

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth) imgDims.value = `${img.naturalWidth} × ${img.naturalHeight}`
}

const metaText = computed(() => {
  const parts: string[] = []
  if (imgDims.value) parts.push(imgDims.value)
  parts.push(ext.value.toUpperCase())
  if (fileSize.value !== null) parts.push(formatBytes(fileSize.value))
  return parts.join(' · ')
})

// ── PDF ───────────────────────────────────────────────────────────────────────
// Chromium exposes the embedded PDF viewer's availability via
// navigator.pdfViewerEnabled; when it is disabled (e.g. plugins are off for
// this window) fall back to an info card instead of a broken iframe.
const pdfSupported =
  typeof navigator !== 'undefined' && 'pdfViewerEnabled' in navigator
    ? navigator.pdfViewerEnabled
    : true
const pdfLoaded = ref(false)

// ── Hex dump (unknown binary) ─────────────────────────────────────────────────
const HEX_LIMIT = 65536
const hexLoading = ref(false)
const hexError = ref('')
const hexText = ref('')
const hexTruncated = ref(false)

function buildHexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16)
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' '
      if (i < row.length) {
        hex += row[i].toString(16).padStart(2, '0') + ' '
        ascii += row[i] >= 0x20 && row[i] <= 0x7e ? String.fromCharCode(row[i]) : '.'
      } else {
        hex += '   '
      }
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`)
  }
  return lines.join('\n')
}

async function loadHex(): Promise<void> {
  hexLoading.value = true
  hexError.value = ''
  try {
    const resp = await fetch(rawUrl.value, {
      headers: { Range: `bytes=0-${HEX_LIMIT - 1}` },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (fileSize.value === null) fileSize.value = sizeFromHeaders(resp)
    const buf = await resp.arrayBuffer()
    // Slice defensively in case the server ignored the Range header.
    const bytes = new Uint8Array(buf).subarray(0, HEX_LIMIT)
    hexTruncated.value = (fileSize.value ?? bytes.length) > bytes.length
    hexText.value = buildHexDump(bytes)
  } catch (err) {
    hexError.value = err instanceof Error ? err.message : String(err)
  } finally {
    hexLoading.value = false
  }
}

// ── Open externally ───────────────────────────────────────────────────────────
async function openExternally(): Promise<void> {
  const abs = `${props.workspacePath.replace(/\/+$/, '')}/${props.relPath}`
  await window.agentTeam?.openPath(abs)
}

onMounted(() => {
  if (kind.value === 'binary') void loadHex()
  else if (kind.value === 'image') void loadSize()
})
</script>

<template>
  <div class="fpv">
    <div class="fpv-toolbar">
      <span class="fpv-name" :title="relPath">{{ name }}</span>
      <span v-if="metaText" class="fpv-meta">{{ metaText }}</span>
      <span v-if="kind === 'html'" class="fpv-hint">{{ $t('preview.html-scripts-disabled') }}</span>
      <span class="fpv-spacer" />
      <button
        v-if="kind === 'image'"
        class="fpv-btn fpv-zoom-btn"
        @click="fitToWindow = !fitToWindow"
      >{{ fitToWindow ? $t('preview.actual-size') : $t('preview.fit-window') }}</button>
      <button class="fpv-btn fpv-open-btn" @click="openExternally">
        {{ $t('preview.open-externally') }}
      </button>
    </div>

    <!-- Image -->
    <div v-if="kind === 'image'" class="fpv-body fpv-image-body">
      <img
        :src="rawUrl"
        class="fpv-img"
        :class="fitToWindow ? 'fpv-img--fit' : 'fpv-img--full'"
        :alt="name"
        @load="onImgLoad"
      />
    </div>

    <!-- Video -->
    <div v-else-if="kind === 'video'" class="fpv-body fpv-media-body">
      <video class="fpv-video" controls :src="rawUrl" />
    </div>

    <!-- Audio -->
    <div v-else-if="kind === 'audio'" class="fpv-body fpv-media-body">
      <audio class="fpv-audio" controls :src="rawUrl" />
    </div>

    <!-- PDF -->
    <template v-else-if="kind === 'pdf'">
      <div v-if="pdfSupported" class="fpv-body fpv-pdf-body">
        <div v-if="!pdfLoaded" class="fpv-pdf-loading">{{ $t('label.loading') }}</div>
        <iframe
          class="fpv-pdf-frame"
          :src="rawUrl"
          :title="name"
          @load="pdfLoaded = true"
        />
      </div>
      <div v-else class="fpv-body fpv-card-body">
        <div class="fpv-card">
          <span class="fpv-card-icon">⬛</span>
          <p class="fpv-card-name">{{ name }}</p>
          <p class="fpv-card-meta">{{ metaText }}</p>
          <p class="fpv-card-hint">{{ $t('preview.pdf-unavailable') }}</p>
        </div>
      </div>
    </template>

    <!-- HTML: sandboxed iframe. The empty sandbox attribute (no allow-*) is
         the second layer on top of the backend's CSP sandbox header — the
         document is an opaque origin with scripts/forms/plugins blocked. -->
    <div v-else-if="kind === 'html'" class="fpv-body fpv-html-body">
      <iframe class="fpv-html-frame" :src="rawUrl" :title="name" sandbox="" />
    </div>

    <!-- Unknown binary: info card + hex dump -->
    <div v-else class="fpv-body fpv-card-body">
      <div class="fpv-card">
        <span class="fpv-card-icon">⬛</span>
        <p class="fpv-card-name">{{ name }}</p>
        <p class="fpv-card-meta">{{ metaText }}</p>
      </div>
      <div v-if="hexLoading" class="fpv-hex-status">{{ $t('preview.hex-loading') }}</div>
      <div v-else-if="hexError" class="fpv-hex-status fpv-hex-status--error">
        {{ $t('preview.hex-error') }} ({{ hexError }})
      </div>
      <template v-else-if="hexText">
        <div v-if="hexTruncated && fileSize !== null" class="fpv-hex-status">
          {{ $t('preview.hex-truncated', { total: formatBytes(fileSize) }) }}
        </div>
        <pre class="fpv-hex">{{ hexText }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fpv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
}
.fpv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  font-size: 12px;
  flex: none;
}
.fpv-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpv-meta {
  color: var(--text-secondary);
  white-space: nowrap;
}
.fpv-hint {
  color: var(--text-secondary);
  white-space: nowrap;
}
.fpv-spacer {
  flex: 1;
}
.fpv-btn {
  background: transparent;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.fpv-btn:hover {
  color: var(--text-primary);
}
.fpv-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.fpv-image-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.fpv-img--fit {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.fpv-img--full {
  max-width: none;
  max-height: none;
  align-self: flex-start;
  margin: auto;
}
.fpv-media-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.fpv-video {
  max-width: 100%;
  max-height: 100%;
}
.fpv-audio {
  width: 80%;
  max-width: 560px;
}
.fpv-pdf-body {
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}
.fpv-pdf-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  pointer-events: none;
}
.fpv-pdf-frame {
  flex: 1;
  width: 100%;
  border: 0;
}
.fpv-html-body {
  display: flex;
  overflow: hidden;
}
.fpv-html-frame {
  flex: 1;
  width: 100%;
  border: 0;
  /* Sandboxed documents default to a transparent background; paint white so
     unstyled pages stay readable on dark themes. */
  background: #fff;
}
.fpv-card-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px;
  gap: 12px;
}
.fpv-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}
.fpv-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.fpv-card-name {
  margin: 0;
  font-weight: 600;
}
.fpv-card-meta,
.fpv-card-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.fpv-hex-status {
  color: var(--text-secondary);
  font-size: 12px;
}
.fpv-hex-status--error {
  color: var(--danger-fg, #e5534b);
}
.fpv-hex {
  align-self: stretch;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  background: var(--bg-subtle, rgba(128, 128, 128, 0.08));
  border-radius: 6px;
}
</style>
