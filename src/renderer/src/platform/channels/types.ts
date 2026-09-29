/**
 * Shared types for the per-platform chat channel specs (one file per platform
 * in this directory; `index.ts` assembles them). Kept separate from index.ts so
 * a platform file never imports the assembler (no cycles).
 */

/** One credential a platform needs. Keys match the backend adapter's
 *  `create_adapter(config, secret)`. */
export interface ChannelField {
  key: string
  /** Stored in the credential vault, never echoed back. */
  secret: boolean
  optional?: boolean
  /** Fixed choices; the first is the default. */
  options?: string[]
}

/** One button in the "link my chat account" guide. */
export interface ChannelLinkTarget {
  target: 'direct' | 'group'
  /** i18n key of the button label. */
  label: string
  /** The backend answers with a platform link to open (deep link / install URL). */
  opensLink?: boolean
}

export interface ChannelPlatformSpec {
  /** Must match the filename and the backend registry id. */
  id: string
  /** Short letter mark in Settings: no brand images, theme tokens only. */
  badge: string
  /** Credentials the Settings form collects, in display order. */
  fields: readonly ChannelField[]
  /** Only offered on macOS (the platform reads a local app's data). */
  macOnly?: boolean
  /** The inbound connection (long polling / socket) takes messages away from
   *  any other program receiving for the same bot; Settings shows a warning. */
  singleReceiver?: boolean
  /** i18n key shown instead of "needs <fields>" when `fields` is empty. */
  configNoteKey?: string
  link: {
    /** Buttons of the link guide; the first is the primary one. */
    targets: readonly ChannelLinkTarget[]
    /** What the user types in the chat, followed by the code (`/start` vs `link`). */
    codeCommand: string
    /** i18n key of the "send this code" hint for the invite's target. */
    sendCodeKey: (target: 'direct' | 'group') => string
    /** i18n key shown while waiting for the code; receives `{ platform }`. */
    waitingKey: string
  }
}
