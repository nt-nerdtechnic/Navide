import { isMacPlatform } from '@navide/plugin-ui/shared'

export const needsDrawnWindowControls = (): boolean => !isMacPlatform()
