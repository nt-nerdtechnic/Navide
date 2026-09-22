import { describe, expect, it } from 'vitest'
import { workspaceBasename, workspaceDisplayName } from '../workspaceAlias'

describe('package-local workspace display name', () => {
  it('prefers the alias the Host resolved over the folder name', () => {
    expect(workspaceDisplayName('/Users/dev/projects/agent-team', 'Navide')).toBe('Navide')
  })

  it('treats a blank alias as no alias', () => {
    expect(workspaceDisplayName('/Users/dev/projects/agent-team', '')).toBe('agent-team')
    expect(workspaceDisplayName('/Users/dev/projects/agent-team', '   ')).toBe('agent-team')
    expect(workspaceDisplayName('/Users/dev/projects/agent-team', null)).toBe('agent-team')
    expect(workspaceDisplayName('/Users/dev/projects/agent-team')).toBe('agent-team')
  })

  it('trims a padded alias instead of rendering the padding', () => {
    expect(workspaceDisplayName('/ws/api', '  My API  ')).toBe('My API')
  })

  it('keeps an alias that happens to equal the folder name', () => {
    expect(workspaceDisplayName('/ws/api', 'api')).toBe('api')
  })

  it('reads the last segment regardless of trailing or repeated separators', () => {
    expect(workspaceBasename('/ws/api/')).toBe('api')
    expect(workspaceBasename('/ws//api//')).toBe('api')
    expect(workspaceBasename('C:\\ws\\api')).toBe('api')
    expect(workspaceBasename('')).toBe('')
  })
})
