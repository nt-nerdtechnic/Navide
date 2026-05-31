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
  /** 說明此 MCP 在 orchestrator pipeline 的用途 */
  description: string
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
    description:
      '查詢版本正確的框架文件（Vue、React、FastAPI…），注入 kickoff 防止幻覺舊 API。預設已啟用。',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: {},
  },
  {
    name: 'github',
    label: 'GitHub',
    description:
      '讀取 Issues、PR、Commit 內容，讓 orchestrator 將需求 / 任務背景注入 pipeline。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    name: 'filesystem',
    label: 'Filesystem',
    description:
      '讀取 workspace 現有程式碼、README、config 等檔案，讓 orchestrator 將現況注入 kickoff，校正 agent 的起始認知。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
  },
  {
    name: 'brave-search',
    label: 'Brave Search',
    description:
      '即時網路搜尋，讓 orchestrator 查詢最新技術決策或 API 變動後注入 agent。需 Brave API key。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
    requiresEnv: ['BRAVE_API_KEY'],
  },
  {
    name: 'sentry',
    label: 'Sentry',
    description:
      '讀取 production 錯誤與 Stack trace，讓 orchestrator 將 bug 背景注入 debug stage。',
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
