// Hand-off from a navide:// link (App.vue) to the Marketplace detail view
// (MarketplacePane.vue). A link only names an extension to show; the pane opens
// its ordinary detail page and nothing is installed or pre-confirmed (D4).
import { shallowRef } from 'vue'
import type { DeepLinkExtensionTarget } from '../../shared/deepLink'

/** The extension a deep link asked to show, until the Marketplace pane takes it. */
export const marketplaceDetailRequest = shallowRef<DeepLinkExtensionTarget | null>(null)

export function requestMarketplaceDetail(target: DeepLinkExtensionTarget): void {
  // A fresh object each time, so asking for the same extension again still
  // triggers the pane's watcher.
  marketplaceDetailRequest.value = { namespace: target.namespace, name: target.name }
}

export function takeMarketplaceDetailRequest(): DeepLinkExtensionTarget | null {
  const request = marketplaceDetailRequest.value
  marketplaceDetailRequest.value = null
  return request
}
