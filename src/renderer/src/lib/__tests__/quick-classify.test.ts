import { describe, it, expect } from 'vitest'
import { quickClassify } from '../quick-classify'

describe('quickClassify', () => {
  it('returns uncertain for empty / tiny input', () => {
    expect(quickClassify('')).toBe('uncertain')
    expect(quickClassify('  ')).toBe('uncertain')
    expect(quickClassify('短')).toBe('uncertain')
  })

  it('detects sentinel-like markers', () => {
    const buf = '做了很多工作\n---STAGE-01-DONE---\n'
    expect(quickClassify(buf)).toBe('completion')
  })

  it('detects ---COMPLETE--- variants', () => {
    expect(quickClassify('輸出內容\n---COMPLETE---')).toBe('completion')
    expect(quickClassify('output\n---DONE---')).toBe('completion')
  })

  it('detects 以上為...完整...', () => {
    const buf = '以下為完整需求文件\n'.repeat(3) + '以上為本次分析的完整結果。'
    expect(quickClassify(buf)).toBe('completion')
  })

  it('detects 已完成全部/所有', () => {
    expect(quickClassify('需求分析工作已完成全部項目，可進入下一階段。')).toBe('completion')
    expect(quickClassify('已完成所有設計稿。')).toBe('completion')
  })

  it('detects standalone 任務完成 on its own line', () => {
    expect(quickClassify('完成各項分析後\n任務完成\n')).toBe('completion')
    expect(quickClassify('工作完成！')).toBe('completion')
  })

  it('detects 2+ consecutive ✅ checklist lines', () => {
    const buf = '✅ 需求分析\n✅ 使用者故事\n✅ 驗收標準\n'
    expect(quickClassify(buf)).toBe('completion')
  })

  it('detects English Done / Completed on own line', () => {
    expect(quickClassify('All requirements documented.\nDone.')).toBe('completion')
    expect(quickClassify('Completed.')).toBe('completion')
  })

  it('returns uncertain for normal in-progress output', () => {
    const buf = '我正在分析需求，以下是目前的進度：\n1. 功能列表\n2. 使用者流程\n繼續處理中...'
    expect(quickClassify(buf)).toBe('uncertain')
  })

  it('does not false-positive on mid-task 完成後 phrases', () => {
    const buf = '完成後請確認以下項目是否符合需求：\n- 登入功能\n- 購物車\n- 結帳流程'
    expect(quickClassify(buf)).toBe('uncertain')
  })

  it('only checks TAIL_CHARS so early-match does not trigger', () => {
    // Sentinel at the very start, followed by > TAIL_CHARS (1500) chars of
    // neutral ongoing text — the tail window should no longer contain the sentinel.
    const early = '---DONE---\n'
    const ongoing = '目前正在整理需求，尚未完成所有項目。\n'.repeat(90) // ~2700 chars > 1500
    const full = early + ongoing
    // Verify the tail doesn't overlap with the sentinel
    expect(full.slice(full.length - 1500)).not.toContain('---DONE---')
    expect(quickClassify(full)).toBe('uncertain')
  })
})
