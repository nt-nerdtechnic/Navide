// Role types only. The role registry is now runtime-mutable and lives on the
// backend (~/Library/Application Support/Agent-Team/roles.json), fetched via
// the useRoles() composable. Default seed content lives in
// backend/agent_team_backend/roles_store.py so first-run users still get the
// five canonical roles even without the renderer.

export type RoleKey = string

export interface Role {
  key: RoleKey
  label: string
  one_line: string
  system_prompt: string
  is_default?: boolean
  created_at?: string
  updated_at?: string
}
