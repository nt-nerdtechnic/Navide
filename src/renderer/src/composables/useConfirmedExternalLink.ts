import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'

// Links that come from a Registry listing (repository, homepage) are
// third-party input, so opening one always goes through an in-app
// confirmation that shows the full address first.
export function useConfirmedExternalLink(): (url: string) => Promise<boolean> {
  const { t } = useI18n()
  const notify = useNotify()
  return async (url: string): Promise<boolean> => {
    if (!/^https:\/\//i.test(url)) return false
    const confirmed = await notify.confirm(t('settings.extensions.marketplace.openLinkBody'), {
      detail: url,
      title: t('settings.extensions.marketplace.openLinkTitle'),
      confirmText: t('settings.extensions.marketplace.openLink'),
      cancelText: t('settings.extensions.trust.cancel'),
    })
    if (!confirmed) return false
    const result = await window.agentTeam?.openExternal?.(url)
    return result?.ok === true
  }
}
