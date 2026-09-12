import { ref } from 'vue'
import type { PluginContext } from '@navide/plugin-sdk'
import type { GitAccountPort, GitAccountPublic } from '@navide/navide-git/composition'

/** Account secrets remain in the Host store; views receive account summaries. */
export function createMiniIdeGitAccountPort(capabilities: PluginContext['capabilities']): GitAccountPort {
  const accounts = ref<GitAccountPublic[]>([])
  const available = ref(false)
  async function refresh(): Promise<void> {
    const result = await capabilities.invoke('ui.listGitAccounts', {})
    accounts.value = result.accounts
    available.value = result.available
  }
  return {
    accounts,
    available,
    refresh,
    async addAccount(input) {
      try {
        await capabilities.invoke('ui.addGitAccount', input)
        await refresh()
        return true
      } catch { return false }
    },
    async bind(accountId) {
      try {
        await capabilities.invoke('ui.bindGitAccount', { accountId })
        return true
      } catch { return false }
    },
    async unbind() {
      try {
        await capabilities.invoke('ui.unbindGitAccount', {})
        return true
      } catch { return false }
    },
    async getBinding() {
      try {
        return (await capabilities.invoke('ui.getGitAccountBinding', {})).accountId
      } catch { return null }
    },
  }
}
