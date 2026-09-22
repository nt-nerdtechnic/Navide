/** Build-time composition only. Consumers inject all authority and bundle
 * these surfaces in their own artifact; importing this entry never mounts or
 * activates the Git Plugin. The installed Plugin is not a runtime dependency. */
export { default as GitPane } from './components/GitPane.vue'
export { default as DiffPane } from './editor/DiffPane.vue'
export { default as BranchDiffPane } from './editor/BranchDiffPane.vue'
export { default as ConflictPane } from './editor/ConflictPane.vue'
export { useGit } from './composables/useGit'
export type { ListConflictsResult } from './composables/useGit'
export { createPluginGitTransport } from './sdkGitTransport'
export type { PluginGitSdk } from './sdkGitTransport'
export type { GitTransport, GitRequestType, GitEventType } from './git-feature/index'
export * from './ports/gitSurface'
