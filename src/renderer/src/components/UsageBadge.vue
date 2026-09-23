<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  accountUsageFor,
  formatRemaining,
  formatResetAbsolute,
  formatResetCountdown,
  exhaustedWindow,
  isExhausted,
  refreshUsage,
  remainingPercent,
  remainingTier,
  TRANSLATED_REFRESH_STATUSES,
  usageFor,
  type UsageWindow
} from '../composables/useUsage'
import { cliAccountSwitchKey, type useCliProfiles } from '../composables/useCliProfiles'
import {
  DEFAULT_PROFILE_ID,
  accountChipLabel,
  accountLabel as resolveAccountLabel,
} from '../lib/accountLabel'
import { useNotify } from '@navide/plugin-ui/foundation'
import { executeCommand } from '@navide/plugin-ui/shared'
import { i18n } from '@navide/plugin-ui/foundation'

// Compact remaining-quota badge for a CLI pane header. Renders nothing when
// the agent has no usage provider or nothing was fetched yet; shows ⚠ when
// the CLI's stored credentials are expired. Hover opens a fixed-position
// detail popover (teleported to body so the pane header can't clip it).

const props = defineProps<{
  agentKey: string
  cliProfiles: ReturnType<typeof useCliProfiles>
}>()

const snap = computed(() => usageFor(props.agentKey))
const remaining = computed(() => remainingPercent(snap.value))
const tier = computed(() => (remaining.value === null ? 'ok' : remainingTier(remaining.value)))
const expired = computed(() => snap.value?.status === 'expired')
// No general quota left at all. Distinct from the red "<15% left" tier on
// purpose: 0.4% still runs, this does not, and both used to print the same
// red figure. Carries the spent window so the badge can say when it returns.
const exhausted = computed(() => isExhausted(snap.value))
const exhaustedReset = computed(() => {
  const w = exhaustedWindow(snap.value)
  return w ? formatResetCountdown(w.resetsAt) : ''
})
const cached = computed(() => snap.value?.stale === true)
// The account just changed and its figure is being read right now. Reading
// Claude's panel boots a whole CLI, so this state can last the better part of
// a minute — without saying so, the badge looks like the switch did nothing.
const pending = computed(() => snap.value?.refreshPending === true)
// Why the last read failed, verbatim from the backend. `refreshStatus` alone
// collapses every failure into one word ("unavailable"), which reads as "the
// account is broken" when it is usually the CLI probe timing out on a loaded
// machine. The snapshot has carried the real sentence all along; this shows it.
const refreshError = computed(() => (pending.value ? '' : (snap.value?.error ?? '')))
// Claude's quota needs its CLI; without the binary there is nothing to read and
// no cached figure to fall back to either, so the badge would render nothing at
// all and the one actionable failure would be invisible.
const cliMissing = computed(
  () => snap.value?.status === 'cli-missing' || snap.value?.refreshStatus === 'cli-missing'
)
// `pending` belongs here: switching onto an account with no reading of its own
// leaves a snapshot with no percent, no staleness and no error, which would
// unmount the badge outright — vanishing mid-switch is the very "did that do
// anything?" reading the pending state exists to prevent.
const visible = computed(
  () =>
    remaining.value !== null ||
    expired.value ||
    cached.value ||
    cliMissing.value ||
    pending.value
)

// ── Account section of the badge ────────────────────────────────────────────
// Which account the figure belongs to: the vendor's current default, the same
// slot the number is read for (see accountUsageFor above). A pane that is
// still running on the account it was started with is NOT reflected here —
// that needs the backend's per-pane profileId, which the renderer has no
// access to yet.
const chipProfileId = computed(
  () => props.cliProfiles.defaultProfileId(props.agentKey) ?? DEFAULT_PROFILE_ID
)
const chipSlot = computed(() => (chipProfileId.value === DEFAULT_PROFILE_ID ? null : chipProfileId.value))
const chipAlias = computed(() => props.cliProfiles.aliasFor?.(props.agentKey, chipSlot.value) ?? '')
const chipEmail = computed(
  () => props.cliProfiles.identityFor(props.agentKey, chipSlot.value)?.email ?? ''
)
const chipLabel = computed(() =>
  accountChipLabel(props.cliProfiles, props.agentKey, chipProfileId.value, t)
)
// Hidden when it would carry no information: no alias, no email and no second
// account to tell this one apart from — the badge is then exactly the number
// pill it has always been.
const showName = computed(
  () => !!(chipAlias.value || chipEmail.value || props.cliProfiles.hasProfiles(props.agentKey))
)
// The header truncates; the whole address (and the alias it hides behind)
// belongs in the tooltip.
const chipTooltip = computed(() => {
  const parts = [chipAlias.value, chipEmail.value].filter(Boolean)
  return t('usage.account-tooltip', { account: parts.length ? parts.join(' · ') : chipLabel.value })
})
const chipInitial = computed(() => avatarInitial(chipLabel.value))

// The figure itself, as text: one place for it so the name section can wrap it
// without the markup being written twice (and so a badge with no name section
// keeps exactly the DOM it had before).
const badgeText = computed(() => {
  if (exhausted.value) return t('usage.exhausted-short')
  if (remaining.value !== null) return formatRemaining(remaining.value)
  if (pending.value && !expired.value && !cliMissing.value) return t('usage.reading-short')
  return '⚠'
})
// Mid-switch the figure still belongs to the PREVIOUS account, so the caveat
// travels with the number, not with the name.
const badgeSmall = computed(() => {
  if (!exhausted.value && remaining.value === null) return ''
  if (pending.value) return t('usage.reading-short')
  if (cached.value) return t('usage.cached-short')
  return ''
})

// Account-switch block: only shown when this agent has ≥1 extra profile.
const canSwitch = computed(() => props.cliProfiles.hasProfiles(props.agentKey))
const switchProfiles = computed(() => props.cliProfiles.profilesForAgent(props.agentKey))
const activeProfileId = computed(() => props.cliProfiles.defaultProfileId(props.agentKey) ?? '')
// Prompt the account list when the quota is low OR gone. Exhausted is the
// stronger case: switching is the only thing that gets work moving again, and
// nothing here does it automatically — a swap exchanges live keychain
// credentials for every pane, which is not a background decision.
const critSwitch = computed(() => tier.value === 'crit' || exhausted.value)

const open = ref(false)
const popStyle = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })
const badgeRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

const POP_WIDTH = 260
const POP_GAP = 6
const VIEWPORT_MARGIN = 8

function onEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (open.value || openTimer) return
  openTimer = setTimeout(() => {
    openTimer = null
    const rect = badgeRef.value?.getBoundingClientRect()
    if (rect) {
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - POP_WIDTH - VIEWPORT_MARGIN)
      )
      popStyle.value = { top: `${rect.bottom + POP_GAP}px`, left: `${left}px` }
    }
    open.value = true
    void nextTick(flipIfOffscreen)
  }, 150)
}

// The popover's real box only exists once it has rendered, so the placement
// above is provisional in both axes.
//
// Height: a badge low in the window would push the panel past the bottom edge,
// where it covers whatever sits there and can no longer be scrolled to. Flip it
// above the badge in that case.
//
// Width: POP_WIDTH is only the CSS `width`, and the renderer has no global
// border-box reset, so padding and border make the panel wider than that. A
// badge near the right edge therefore lands a panel that spills past the window
// and gets clipped by it. Re-clamp against the measured width.
function flipIfOffscreen(): void {
  const rect = badgeRef.value?.getBoundingClientRect()
  const height = popRef.value?.offsetHeight ?? 0
  const width = popRef.value?.offsetWidth ?? 0
  if (!rect || height === 0) return
  const next = { ...popStyle.value }
  if (width > 0) {
    next.left = `${Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN)
    )}px`
  }
  if (rect.bottom + POP_GAP + height > window.innerHeight - VIEWPORT_MARGIN) {
    next.top = `${Math.max(VIEWPORT_MARGIN, rect.top - POP_GAP - height)}px`
  }
  popStyle.value = next
}

function onLeave(): void {
  // A half-typed name must not vanish because the pointer drifted off.
  if (renamingId.value !== null) return
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  // Short grace so the cursor can travel from badge into the popover.
  closeTimer = setTimeout(() => {
    closeTimer = null
    open.value = false
  }, 120)
}

function closePop(): void {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  open.value = false
}

// Hover alone is not enough to dismiss this panel. It is teleported to <body>
// at a fixed position, so any missed mouseleave — the window losing focus, the
// snapshot re-rendering the node out from under the cursor — strands a 260px
// panel over the UI with nothing underneath it clickable. Esc and a click
// anywhere outside are the explicit escape hatches; blur covers the stranded
// case. Listeners are attached only while open (capture phase, so a stopped
// click deeper in the tree still dismisses).
function onDocKeydown(e: KeyboardEvent): void {
  // While a row is being renamed, Esc belongs to that field: it cancels the
  // edit and leaves the panel open. This listener runs in the capture phase,
  // ahead of the field's own handler, so a stop there cannot shield it.
  if (e.key === 'Escape' && renamingId.value === null) closePop()
}

function onDocPointerDown(e: Event): void {
  const target = e.target as Node | null
  if (target && (popRef.value?.contains(target) || badgeRef.value?.contains(target))) return
  closePop()
}

function detachDismissListeners(): void {
  document.removeEventListener('keydown', onDocKeydown, true)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('blur', closePop)
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', onDocKeydown, true)
    document.addEventListener('pointerdown', onDocPointerDown, true)
    window.addEventListener('blur', closePop)
  } else {
    detachDismissListeners()
  }
})

const { alert: notifyAlert } = useNotify()
const t = i18n.global.t

// Main window provides the quiescence-aware switch (confirm + force + pane
// restart). Other windows fall back to plain setDefault, whose expected
// refusals carry a ready message and surface as the alert below.
const switchAccount = inject(cliAccountSwitchKey, null)

// The swap round-trips to the backend (30s timeout) and may stop for a confirm
// dialog, so the row that was clicked stays marked until it settles — without
// it the popover looks inert and a second click starts a competing switch.
const switching = ref<string | null>(null)

async function selectProfile(id: string): Promise<void> {
  if (id === activeProfileId.value) return
  if (switching.value !== null) return
  const target = id || null
  switching.value = id
  try {
    const res = switchAccount
      ? await switchAccount(props.agentKey, target)
      : await props.cliProfiles.setDefault(props.agentKey, target)
    if (!res.ok) {
      if (res.message) void notifyAlert(res.message, { title: t('cli-account.switch-title') })
      return
    }
    // Re-poll so the badge reflects the newly active account's quota promptly.
    refreshUsage()
  } finally {
    switching.value = null
  }
}

// ── Renaming an account from the list ───────────────────────────────────────
// The row id being edited ('' = the built-in Default), or null when no row is.
// The field holds the ALIAS only: empty clears it and the row falls back to
// the email or the generated name.
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
// Esc must not be undone by the blur it causes; this says the edit is over.
let renameAborted = false
// Enter followed by the blur it can cause must not send the name twice.
let renameSaving = false

/** Template ref set from inside a v-for, where a plain `ref` would collect an
 *  array; only one row is ever in edit mode, so the last one set is it. */
function setRenameInput(el: unknown): void {
  renameInput.value = (el as HTMLInputElement | null) ?? null
}

function startRename(id: string): void {
  renamingId.value = id
  renameDraft.value = props.cliProfiles.aliasFor?.(props.agentKey, id || null) ?? ''
  renameAborted = false
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function cancelRename(): void {
  renameAborted = true
  renamingId.value = null
}

async function commitRename(): Promise<void> {
  if (renameAborted || renameSaving || renamingId.value === null) return
  const id = renamingId.value
  const name = renameDraft.value.trim()
  renameSaving = true
  try {
    // The Default slot has no profile record, so its successful reply is a
    // null profile too; the composable's error is what tells a failure.
    const saved = await props.cliProfiles.rename(id || DEFAULT_PROFILE_ID, name, props.agentKey)
    if (!saved && props.cliProfiles.error.value) {
      // Keep the field and the draft so the user can fix it and retry.
      void notifyAlert(props.cliProfiles.error.value, { title: t('usage.rename-account') })
      return
    }
    if (renamingId.value === id) renamingId.value = null
  } finally {
    renameSaving = false
  }
}

// Two rows the user gave the same name still need telling apart, so a named
// row also shows the email it stands for. Rows without an alias already read
// as their email and get no second line.
function rowEmail(profileId: string | null): string {
  if (!props.cliProfiles.aliasFor?.(props.agentKey, profileId)) return ''
  return props.cliProfiles.identityFor(props.agentKey, profileId)?.email ?? ''
}

// Rows read the same way the header chip does — alias, then the signed-in
// email, then the generated name — so one account is one name everywhere.
function rowLabel(profileId: string | null, defaultLabel?: string): string {
  return resolveAccountLabel(props.cliProfiles, props.agentKey, profileId ?? DEFAULT_PROFILE_ID, t, {
    defaultLabel,
  })
}

// Jump straight to Settings › Accounts (CLI account manager) so a new account
// can be added. Close the popover first — the modal opens on top of it.
function openAccountSettings(): void {
  open.value = false
  executeCommand('workbench.action.openSettingsAccounts')
}

onBeforeUnmount(() => {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  detachDismissListeners()
})

function rowRemaining(w: UsageWindow): string {
  return formatRemaining(Math.max(0, Math.min(100, 100 - w.usedPercent)))
}

function rowBarWidth(w: UsageWindow): string {
  return `${Math.max(0, Math.min(100, 100 - w.usedPercent))}%`
}

function rowTier(w: UsageWindow): 'ok' | 'warn' | 'crit' {
  return remainingTier(Math.max(0, Math.min(100, 100 - w.usedPercent)))
}

function rowReset(w: UsageWindow): string {
  const countdown = formatResetCountdown(w.resetsAt)
  if (!countdown) return ''
  return `${countdown} · ${formatResetAbsolute(w.resetsAt)}`
}

function refreshStatusLabel(status: string | undefined): string {
  if (!status) return ''
  return TRANSLATED_REFRESH_STATUSES.has(status) ? t(`usage.refresh-status-${status}`) : status
}

// Per-account avatar: first character over a deterministic color picked from
// the profile id, so the same account always gets the same tint.
const AVATAR_COLORS = ['#1f6feb', '#8957e5', '#2da44e', '#bc4c00', '#bf3989', '#1b7c83', '#9e6a03']

function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function avatarInitial(label: string): string {
  const t = label.trim()
  return t ? t.charAt(0).toUpperCase() : '?'
}

// Per-account remaining quota, shown as a plain number on each switch row.
// Empty when that slot has no fetched snapshot (e.g. never signed in).
function acctPct(profileId: string | null): string {
  const r = remainingPercent(accountUsageFor(props.agentKey, profileId))
  return r === null ? '' : formatRemaining(r)
}

function acctTier(profileId: string | null): 'ok' | 'warn' | 'crit' {
  const r = remainingPercent(accountUsageFor(props.agentKey, profileId))
  return r === null ? 'ok' : remainingTier(r)
}

// A row whose slot could not be polled falls back to the last good numbers,
// which may be hours or days old. Mark it rather than let a dead snapshot pass
// for a live reading.
function acctStale(profileId: string | null): boolean {
  return accountUsageFor(props.agentKey, profileId)?.stale === true
}

// A row can be mid-read with no percent at all (an account that has never been
// measured). Without its own branch that row renders blank, so the wait is
// invisible on the surface the switch was made from.
function acctPending(profileId: string | null): boolean {
  return accountUsageFor(props.agentKey, profileId)?.refreshPending === true
}

// An account with no stored credentials keeps whatever quota was last cached
// for it, so the row would advertise a number for something that cannot run.
// Say it is signed out instead — switching to it starts a sign-in, not work.
function acctSignedOut(profileId: string | null): boolean {
  return props.cliProfiles.identityFor(props.agentKey, profileId)?.signedIn === false
}

function acctTitle(profileId: string | null): string {
  const s = accountUsageFor(props.agentKey, profileId)
  // A read in flight outranks the age of what is on screen: it is the reason
  // the number has not moved yet.
  if (s?.refreshPending === true) return t('usage.reading-tooltip')
  if (s?.stale !== true) return ''
  return t('usage.cached-account-tooltip', {
    time: formatResetAbsolute(s.lastSuccessAt ?? s.fetchedAt),
  })
}
</script>

<template>
  <span
    v-if="visible"
    ref="badgeRef"
    class="usage-badge"
    :class="[
      showName ? 'has-name' : tier,
      { cached, pending, exhausted: exhausted && !showName }
    ]"
    :title="
      open
        ? ''
        : exhausted
          ? $t(
            exhaustedReset ? 'usage.exhausted-tooltip' : 'usage.exhausted-tooltip-no-reset',
            { time: exhaustedReset }
          )
          : $t(
            pending
              ? 'usage.reading-tooltip'
              : expired
                ? 'usage.expired-tooltip'
                : cliMissing
                  ? 'usage.cli-missing-tooltip'
                  : cached
                    ? 'usage.cached-tooltip'
                    : 'usage.badge-tooltip'
          )
    "
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @click.stop
  >
    <!-- Which account this figure belongs to. Only the number section takes
         the warn/crit/spent colour: the account did not go red, its quota did.
         The dashed "not current" cue stays on the whole pill, because
         mid-switch the name is already the NEW account and the number is
         still the old one. -->
    <template v-if="showName">
      <span class="usage-badge-name" :title="chipTooltip">
        <span class="usage-badge-name-text">{{ chipLabel }}</span>
        <!-- Narrow panes swap the name for its first character (CSS below);
             both are rendered because CSS cannot shorten text. -->
        <span class="usage-badge-name-initial" aria-hidden="true">{{ chipInitial }}</span>
      </span>
      <span class="usage-badge-num" :class="[tier, { exhausted }]"
        >{{ badgeText }}<small v-if="badgeSmall">{{ badgeSmall }}</small></span
      >
    </template>
    <!-- Same caveats as ever: "spent" or a percentage mid-switch belongs to
         the PREVIOUS account, and ⚠ wins over a wait the user cannot act on
         (see badgeText / badgeSmall). -->
    <template v-else>{{ badgeText }}<small v-if="badgeSmall">{{ badgeSmall }}</small></template>
  </span>
  <Teleport to="body">
    <div
      v-if="open && snap"
      ref="popRef"
      class="usage-pop"
      :style="popStyle"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <div class="usage-pop-head">
        <span class="usage-pop-provider">{{ agentKey }}</span>
        <span v-if="snap.planType" class="usage-pop-plan">{{ snap.planType }}</span>
      </div>
      <div v-if="expired" class="usage-pop-expired">{{ $t('usage.expired-tooltip') }}</div>
      <div v-if="cliMissing" class="usage-pop-missing">{{ $t('usage.cli-missing-tooltip') }}</div>
      <div v-if="pending" class="usage-pop-pending">{{ $t('usage.reading-now') }}</div>
      <div v-if="exhausted" class="usage-pop-exhausted">
        {{ exhaustedReset
          ? $t('usage.exhausted-tooltip', { time: exhaustedReset })
          : $t('usage.exhausted-tooltip-no-reset') }}
      </div>
      <div v-if="cached" class="usage-pop-cached">
        {{ $t('usage.cached-at', { time: formatResetAbsolute(snap.lastSuccessAt ?? snap.fetchedAt) }) }}
        · {{ $t('usage.refresh-status', { status: refreshStatusLabel(snap.refreshStatus) }) }}
      </div>
      <div v-if="refreshError" class="usage-pop-reason">
        {{ $t('usage.refresh-error', { reason: refreshError }) }}
      </div>
      <div v-if="cached && snap.staleExpired" class="usage-pop-expired">
        {{ $t('usage.cached-reset-expired') }}
      </div>
      <div v-for="w in snap.windows" :key="w.kind + w.label" class="usage-row">
        <div class="usage-row-top">
          <span class="usage-row-label">{{ w.label }}</span>
          <span v-if="w.expired" class="usage-row-left crit">
            {{ $t('usage.cached-window-expired') }}
          </span>
          <span v-else class="usage-row-left" :class="rowTier(w)">
            {{ $t('usage.remaining', { pct: rowRemaining(w) }) }}
          </span>
        </div>
        <div v-if="!w.expired" class="usage-bar">
          <div class="usage-bar-fill" :class="rowTier(w)" :style="{ width: rowBarWidth(w) }" />
        </div>
        <div v-if="!w.expired && rowReset(w)" class="usage-row-reset">
          {{ $t('usage.resets-in', { time: rowReset(w) }) }}
        </div>
      </div>
      <div class="usage-pop-switch">
        <div v-if="canSwitch" class="usage-pop-switch-title" :class="{ crit: critSwitch }">
          {{ critSwitch ? $t('usage.switch-low') : $t('usage.switch-title') }}
        </div>
        <div v-if="canSwitch" class="usage-acct-list" role="listbox">
          <!-- Each row is a button so a click anywhere on it switches; the
               pencil is its sibling rather than a child, because a button
               inside a button is not valid markup. -->
          <div class="usage-acct-row">
            <input
              v-if="renamingId === ''"
              :ref="setRenameInput"
              v-model="renameDraft"
              class="usage-acct-rename"
              :placeholder="rowLabel(null, $t('usage.switch-default'))"
              :aria-label="$t('usage.rename-account')"
              @keydown.enter.prevent="commitRename"
              maxlength="64"
              @keydown.esc.stop.prevent="cancelRename"
              @blur="commitRename"
              @click.stop
            />
            <button
              v-else
              class="usage-acct"
              role="option"
              :class="{ active: activeProfileId === '' }"
              :aria-selected="activeProfileId === ''"
              :disabled="switching !== null"
              @click="selectProfile('')"
            >
              <span class="usage-acct-av default">{{
                avatarInitial(rowLabel(null, $t('usage.switch-default')))
              }}</span>
              <span class="usage-acct-text">
                <span class="usage-acct-name">{{ rowLabel(null, $t('usage.switch-default')) }}</span>
                <span v-if="rowEmail(null)" class="usage-acct-email">{{ rowEmail(null) }}</span>
              </span>
              <span v-if="acctSignedOut(null)" class="usage-acct-out">{{
                $t('settings.accounts.cli.not-signed-in')
              }}</span>
              <span
                v-else-if="acctPct(null)"
                class="usage-acct-pct"
                :class="[acctTier(null), { stale: acctStale(null) }]"
                :title="acctTitle(null)"
                >{{ acctStale(null) ? '~' : '' }}{{ acctPct(null) }}</span
              >
              <span
                v-else-if="acctPending(null)"
                class="usage-acct-pct stale"
                :title="acctTitle(null)"
                >{{ $t('usage.reading-short') }}</span
              >
              <span v-if="switching === ''" class="usage-acct-spin" aria-hidden="true" />
              <span v-else-if="activeProfileId === ''" class="usage-acct-tick">✓</span>
            </button>
            <button
              v-if="renamingId !== ''"
              class="usage-acct-edit"
              :title="$t('usage.rename-account')"
              :aria-label="$t('usage.rename-account')"
              @click.stop="startRename('')"
            >
              ✎
            </button>
          </div>
          <div v-for="p in switchProfiles" :key="p.id" class="usage-acct-row">
            <input
              v-if="renamingId === p.id"
              :ref="setRenameInput"
              v-model="renameDraft"
              class="usage-acct-rename"
              :placeholder="rowLabel(p.id)"
              :aria-label="$t('usage.rename-account')"
              @keydown.enter.prevent="commitRename"
              maxlength="64"
              @keydown.esc.stop.prevent="cancelRename"
              @blur="commitRename"
              @click.stop
            />
            <button
              v-else
              class="usage-acct"
              role="option"
              :class="{ active: activeProfileId === p.id }"
              :aria-selected="activeProfileId === p.id"
              :disabled="switching !== null"
              @click="selectProfile(p.id)"
            >
              <span class="usage-acct-av" :style="{ background: avatarColor(p.id) }">{{
                avatarInitial(rowLabel(p.id))
              }}</span>
              <span class="usage-acct-text">
                <span class="usage-acct-name">{{ rowLabel(p.id) }}</span>
                <span v-if="rowEmail(p.id)" class="usage-acct-email">{{ rowEmail(p.id) }}</span>
              </span>
              <span v-if="acctSignedOut(p.id)" class="usage-acct-out">{{
                $t('settings.accounts.cli.not-signed-in')
              }}</span>
              <span
                v-else-if="acctPct(p.id)"
                class="usage-acct-pct"
                :class="[acctTier(p.id), { stale: acctStale(p.id) }]"
                :title="acctTitle(p.id)"
                >{{ acctStale(p.id) ? '~' : '' }}{{ acctPct(p.id) }}</span
              >
              <span
                v-else-if="acctPending(p.id)"
                class="usage-acct-pct stale"
                :title="acctTitle(p.id)"
                >{{ $t('usage.reading-short') }}</span
              >
              <span v-if="switching === p.id" class="usage-acct-spin" aria-hidden="true" />
              <span v-else-if="activeProfileId === p.id" class="usage-acct-tick">✓</span>
            </button>
            <button
              v-if="renamingId !== p.id"
              class="usage-acct-edit"
              :title="$t('usage.rename-account')"
              :aria-label="$t('usage.rename-account')"
              @click.stop="startRename(p.id)"
            >
              ✎
            </button>
          </div>
        </div>
        <button class="usage-acct-manage" @click="openAccountSettings">
          <span class="usage-acct-manage-icon">＋</span>
          <span>{{ $t('usage.switch-manage') }}</span>
        </button>
      </div>
      <div class="usage-pop-updated">
        {{ $t('usage.updated', { time: formatResetAbsolute(snap.fetchedAt) }) }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.usage-badge {
  font-size: 9px;
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
}
.usage-badge.warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border-color: var(--attention-muted);
}
.usage-badge.crit {
  color: var(--danger-fg);
  background: var(--danger-deep);
  border-color: var(--danger-fg);
}
/* Out of quota: solid fill, so it does not read as "nearly out" at a glance. */
.usage-badge.exhausted {
  color: var(--text-on-emphasis);
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
}
.usage-pop-exhausted {
  font-size: 10px;
  color: var(--danger-fg);
  margin-bottom: 6px;
}
.usage-badge.cached {
  border-style: dashed;
}
/* A read is in flight: the number shown is an earlier one, so keep the dashed
   "not current" cue rather than let it pass for the new account's figure. */
.usage-badge.pending {
  border-style: dashed;
  opacity: 0.85;
}
.usage-badge small {
  margin-left: 2px;
  font-size: 8px;
  font-weight: 500;
}
/* Sectioned pill: the account name and its figure share one border so the
   number visibly belongs to that account. Padding moves to the sections. */
.usage-badge.has-name {
  display: inline-flex;
  align-items: stretch;
  padding: 0;
  overflow: hidden;
}
.usage-badge-name {
  display: inline-flex;
  align-items: center;
  max-width: 84px;
  padding: 1px 5px;
  overflow: hidden;
  color: var(--text-secondary);
  border-right: 1px solid var(--border-default);
}
.usage-badge-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-badge-name-initial {
  display: none;
}
.usage-badge-num {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
}
/* Only the figure takes the state colour — the account is not "critical",
   its quota is. */
.usage-badge-num.warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.usage-badge-num.crit {
  color: var(--danger-fg);
  background: var(--danger-deep);
}
.usage-badge-num.exhausted {
  color: var(--text-on-emphasis);
  background: var(--danger-emphasis);
}
/* Narrow panes: the name collapses to its first character. The header
   declares `container: cli-pane-header` (TerminalPane.vue). */
@container cli-pane-header (max-width: 360px) {
  .usage-badge-name {
    max-width: none;
    width: 14px;
    padding: 0;
    justify-content: center;
  }
  .usage-badge-name-text {
    display: none;
  }
  .usage-badge-name-initial {
    display: inline;
  }
}
.usage-pop {
  position: fixed;
  z-index: 300;
  width: 260px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.usage-pop-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.usage-pop-provider {
  font-weight: 700;
  text-transform: capitalize;
  color: var(--text-bright);
}
.usage-pop-plan {
  font-size: var(--font-3xs);
  text-transform: capitalize;
  color: var(--text-secondary);
}
.usage-pop-expired {
  color: var(--danger-fg);
  margin-bottom: 6px;
}
.usage-pop-cached,
.usage-pop-missing {
  color: var(--attention-fg);
  margin-bottom: 6px;
}
.usage-pop-pending {
  color: var(--accent-fg);
  font-weight: 600;
  margin-bottom: 6px;
}
/* The backend's own sentence — it can be long, so let it wrap rather than
   widen the popover or clip the half that says what actually went wrong. */
.usage-pop-reason {
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow-wrap: anywhere;
}
.usage-row {
  margin-bottom: 8px;
}
.usage-row-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 3px;
}
.usage-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-row-left {
  flex-shrink: 0;
  font-weight: 600;
}
.usage-row-left.warn {
  color: var(--attention-fg);
}
.usage-row-left.crit {
  color: var(--danger-fg);
}
.usage-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
}
.usage-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--success-fg);
}
.usage-bar-fill.warn {
  background: var(--attention-fg);
}
.usage-bar-fill.crit {
  background: var(--danger-fg);
}
.usage-row-reset {
  margin-top: 2px;
  font-size: var(--font-3xs);
  opacity: 0.8;
}
.usage-pop-switch {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-default);
}
.usage-pop-switch-title {
  font-size: var(--font-3xs);
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-secondary);
}
.usage-pop-switch-title.crit {
  color: var(--danger-fg);
}
.usage-acct-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* Row + its pencil. The pencil only appears on hover so the list reads as a
   switcher first and a rename surface second. */
.usage-acct-row {
  display: flex;
  align-items: center;
  border-radius: 6px;
}
.usage-acct-row .usage-acct {
  flex: 1;
  min-width: 0;
}
.usage-acct-edit {
  flex-shrink: 0;
  visibility: hidden;
  padding: 2px 5px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  cursor: pointer;
}
.usage-acct-row:hover .usage-acct-edit,
.usage-acct-edit:focus-visible {
  visibility: visible;
}
.usage-acct-edit:hover {
  color: var(--accent-fg);
  background: var(--bg-hover);
}
.usage-acct-rename {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--accent-fg);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-bright);
  font-size: var(--font-2xs);
  font-family: inherit;
}
.usage-acct {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.usage-acct:hover {
  background: var(--bg-hover);
}
.usage-acct:disabled {
  cursor: default;
}
/* Only the untouched rows dim — the one being switched to keeps full contrast
   so the spinner reads as "this one", not "everything is busy". */
.usage-acct:disabled:not(:has(.usage-acct-spin)) {
  opacity: 0.5;
}
.usage-acct:disabled:hover {
  background: transparent;
}
.usage-acct-spin {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--accent-fg);
  animation: usage-acct-spin 0.6s linear infinite;
}
@keyframes usage-acct-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .usage-acct-spin {
    animation: none;
  }
}
.usage-acct.active {
  color: var(--text-bright);
  font-weight: 600;
}
.usage-acct-av {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-3xs);
  font-weight: 700;
  color: #fff;
}
.usage-acct-av.default {
  background: var(--border-strong);
}
.usage-acct.active .usage-acct-av {
  box-shadow:
    0 0 0 2px var(--bg-overlay),
    0 0 0 3px var(--accent-fg);
}
.usage-acct-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.usage-acct-name,
.usage-acct-email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-acct-email {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.usage-acct-tick {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  color: var(--accent-fg);
}
.usage-acct-pct {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--text-secondary);
}
/* Signed-out rows take the quota slot but read as a state, not a number. */
.usage-acct-out {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-style: italic;
  color: var(--text-tertiary, var(--text-secondary));
}
.usage-acct-pct.warn {
  color: var(--attention-fg);
}
.usage-acct-pct.crit {
  color: var(--danger-fg);
}
/* Cached numbers: dimmed and underlined so a days-old reading never passes for
   a live one (the leading ~ carries it for screen readers too). */
.usage-acct-pct.stale {
  opacity: 0.6;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.usage-acct-manage {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.usage-acct-manage:hover {
  background: var(--bg-hover);
  color: var(--accent-fg);
}
.usage-acct-manage-icon {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-size: var(--font-xs);
  font-weight: 600;
}
.usage-pop-updated {
  margin-top: 4px;
  font-size: 9.5px;
  opacity: 0.6;
}
</style>
