/**
 * Orchestrator MCP catalog.
 *
 * 這裡只列「讀取上下文 → 注入 kickoff prompt」用途的 MCP server。
 * 執行操作（寫檔、跑測試、瀏覽器）由 CLI agents（Claude Code / Codex）自行負責，不放在這裡。
 */

export interface McpCatalogEntry {
  /** 唯一識別名（同時作為 mcp_servers.json 的 name 欄位） */
  name: string
  /** 顯示用標題 */
  label: string
  /** i18n key for the blurb shown on the catalog card. Held as a key, not
   *  text, because this array is module scope — the render site resolves it
   *  so a language switch re-renders. Never written to mcp_servers.json. */
  descriptionKey: string
  /** 啟動指令 */
  command: string
  args: string[]
  env: Record<string, string>
  /** 使用前必須填寫的 env key，用於 UI 提示 */
  requiresEnv?: string[]
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: 'context7',
    label: 'Context7',
    descriptionKey: 'settings.mcp.catalog-context7',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: {},
  },
  {
    name: 'github',
    label: 'GitHub',
    descriptionKey: 'settings.mcp.catalog-github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    name: 'filesystem',
    label: 'Filesystem',
    descriptionKey: 'settings.mcp.catalog-filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
  },
  {
    name: 'brave-search',
    label: 'Brave Search',
    descriptionKey: 'settings.mcp.catalog-brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
    requiresEnv: ['BRAVE_API_KEY'],
  },
  {
    name: 'sentry',
    label: 'Sentry',
    descriptionKey: 'settings.mcp.catalog-sentry',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@latest'],
    env: {},
  },
]

/** 判斷指定名稱是否已在已安裝清單中 */
export function isMcpInstalled(
  installedNames: string[],
  name: string
): boolean {
  return installedNames.includes(name)
}
