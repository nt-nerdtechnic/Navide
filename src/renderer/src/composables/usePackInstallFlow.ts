import { computed, ref } from 'vue'
import { usePluginInventory } from './usePluginInventory'
import { usePluginUpdates } from './usePluginUpdates'
import { ipcErrorMessage } from './usePluginInstallFlow'

// Installing an Extension Pack (D5). The main process verifies the pack and
// lists its members; the user first sees a whole-pack summary, then confirms
// each installable member on its own — every member, sensitive or not — with
// "Skip this one" and "Cancel pack", and never an "accept all". Each member
// goes through the ordinary prepareInstall/commitInstall path with its own
// verification and trust facts: the pack itself carries no permissions, so it
// cannot widen what any member is granted. Members installed before a cancel
// stay installed (they can be removed one by one).
export type PackMemberResult = 'installed' | 'skipped' | 'cancelled' | 'failed'

export function usePackInstallFlow() {
  const inventory = usePluginInventory()
  const pluginUpdates = usePluginUpdates()
  const pack = ref<PreparedPackSummary | null>(null)
  const stage = ref<'summary' | 'member' | 'done' | null>(null)
  const busy = ref(false)
  const error = ref('')
  // Index into pack.members of the member being confirmed.
  const current = ref(-1)
  const memberPrepared = ref<PreparedInstallSummary | null>(null)
  const memberStep = ref<'publisher' | 'confirm'>('confirm')
  const publisherConfirmed = ref(false)
  const results = ref<Record<string, { result: PackMemberResult; error?: string }>>({})

  const readyMembers = computed(() => (pack.value?.members ?? []).filter((m) => m.status === 'ready'))
  const currentMember = computed(() => (pack.value && current.value >= 0 ? pack.value.members[current.value] : null))

  function api() {
    return window.agentTeam?.plugins
  }

  async function start(namespace: string, name: string): Promise<void> {
    const plugins = api()
    if (!plugins?.preparePack) return
    busy.value = true
    error.value = ''
    results.value = {}
    try {
      pack.value = await plugins.preparePack({ namespace, name })
      stage.value = 'summary'
    } catch (err) {
      error.value = ipcErrorMessage(err)
      pack.value = null
      stage.value = null
    } finally {
      busy.value = false
    }
  }

  // Move to the next "ready" member after `from`, or finish the pack.
  async function advance(from: number): Promise<void> {
    const members = pack.value?.members ?? []
    let next = from + 1
    while (next < members.length && members[next].status !== 'ready') next += 1
    memberPrepared.value = null
    if (next >= members.length) {
      await finish()
      return
    }
    current.value = next
    stage.value = 'member'
    await prepareMember(members[next])
  }

  async function prepareMember(member: PackMemberSummary): Promise<void> {
    const plugins = api()
    if (!plugins) return
    const dot = member.id.indexOf('.')
    busy.value = true
    try {
      const prepared = await plugins.prepareInstall({
        namespace: member.id.slice(0, dot),
        name: member.id.slice(dot + 1),
        ...(member.version ? { version: member.version } : {}),
      })
      memberPrepared.value = prepared
      publisherConfirmed.value = false
      memberStep.value = prepared.requiresPublisherTrust ? 'publisher' : 'confirm'
    } catch (err) {
      results.value = { ...results.value, [member.id]: { result: 'failed', error: ipcErrorMessage(err) } }
      busy.value = false
      await advance(current.value)
      return
    }
    busy.value = false
  }

  async function beginReview(): Promise<void> {
    await advance(-1)
  }

  function confirmPublisher(): void {
    publisherConfirmed.value = true
    memberStep.value = 'confirm'
  }

  async function confirmMember(): Promise<void> {
    const plugins = api()
    const member = currentMember.value
    const prepared = memberPrepared.value
    if (!plugins || !member || !prepared) return
    busy.value = true
    try {
      await plugins.commitInstall(prepared.id, {
        publisherConfirmed: publisherConfirmed.value,
        riskConfirmed: true,
      })
      results.value = { ...results.value, [member.id]: { result: 'installed' } }
    } catch (err) {
      results.value = { ...results.value, [member.id]: { result: 'failed', error: ipcErrorMessage(err) } }
    } finally {
      busy.value = false
    }
    await advance(current.value)
  }

  async function skipMember(): Promise<void> {
    const member = currentMember.value
    if (!member) return
    results.value = { ...results.value, [member.id]: { result: 'skipped' } }
    await advance(current.value)
  }

  async function cancelPack(): Promise<void> {
    const members = pack.value?.members ?? []
    const marked = { ...results.value }
    for (const member of members) {
      if (member.status === 'ready' && !marked[member.id]) marked[member.id] = { result: 'cancelled' }
    }
    results.value = marked
    if (stage.value === 'summary') {
      // Nothing was installed or recorded; the main-side session is simply
      // replaced by the next preparePack.
      close()
      return
    }
    await finish()
  }

  async function finish(): Promise<void> {
    const plugins = api()
    const id = pack.value?.id
    memberPrepared.value = null
    current.value = -1
    stage.value = 'done'
    if (!plugins?.finishPack || !id) return
    try {
      await plugins.finishPack(id)
    } catch (err) {
      error.value = ipcErrorMessage(err)
    }
    await Promise.all([inventory.refresh(), pluginUpdates.refresh()])
  }

  function close(): void {
    pack.value = null
    stage.value = null
    results.value = {}
  }

  return {
    pack,
    stage,
    busy,
    error,
    current,
    currentMember,
    memberPrepared,
    memberStep,
    readyMembers,
    results,
    start,
    beginReview,
    confirmPublisher,
    confirmMember,
    skipMember,
    cancelPack,
    close,
  }
}

export type PackInstallFlow = ReturnType<typeof usePackInstallFlow>
