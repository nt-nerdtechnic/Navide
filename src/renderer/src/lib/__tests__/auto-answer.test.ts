import { describe, it, expect } from 'vitest'

type Question = { prompt: string; type: string; options: string[] }
type QuestionItem = {
  paneId: string
  stageIndex: number
  questions: Question[]
  agentLabel: string
  stageTitle: string
  slotLabel: string
}

function makeQuestion(paneId: string, type = 'text', withOptions = false): QuestionItem {
  return {
    paneId,
    stageIndex: 0,
    questions: [{ prompt: '問題?', type, options: withOptions ? ['選項A', '選項B'] : [] }],
    agentLabel: 'Claude',
    stageTitle: 'Stage 01',
    slotLabel: ''
  }
}

describe('triggerAutoAnswer', () => {
  describe('Bug 1: autoAnswerPending not cleared before dequeue', () => {
    it('OLD code: queued question is NOT auto-answered (confirms bug existed)', async () => {
      let autoAnswerPending = false
      let activeQuestion: QuestionItem | null = null
      const questionQueue: QuestionItem[] = []
      const autoAnswerCallLog: { q: QuestionItem }[] = []

      function dequeueNextQuestion() {
        const next = questionQueue.shift() ?? null
        activeQuestion = next
        if (next && !autoAnswerPending) {
          autoAnswerCallLog.push({ q: next })
        }
      }

      async function triggerAutoAnswer_OLD(q: QuestionItem) {
        autoAnswerPending = true
        if (activeQuestion?.paneId === q.paneId) {
          // BUG: autoAnswerPending still true here — dequeue sees pending=true and skips
          dequeueNextQuestion()
        }
        autoAnswerPending = false
      }

      const Q1 = makeQuestion('pane-A')
      const Q2 = makeQuestion('pane-A')
      activeQuestion = Q1
      questionQueue.push(Q2)

      await triggerAutoAnswer_OLD(Q1)
      expect(autoAnswerCallLog.some(c => c.q === Q2)).toBe(false)
    })

    it('NEW code: queued question IS auto-answered after pending reset', async () => {
      let autoAnswerPending = false
      let activeQuestion: QuestionItem | null = null
      const questionQueue: QuestionItem[] = []
      const autoAnswerCallLog: { q: QuestionItem }[] = []

      function dequeueNextQuestion() {
        const next = questionQueue.shift() ?? null
        activeQuestion = next
        if (next && !autoAnswerPending) {
          autoAnswerCallLog.push({ q: next })
        }
      }

      async function triggerAutoAnswer_NEW(q: QuestionItem) {
        autoAnswerPending = true
        if (activeQuestion?.paneId === q.paneId) {
          // FIX: reset BEFORE calling dequeue so it sees pending=false
          autoAnswerPending = false
          dequeueNextQuestion()
        }
        autoAnswerPending = false
      }

      const Q1 = makeQuestion('pane-A')
      const Q2 = makeQuestion('pane-A')
      activeQuestion = Q1
      questionQueue.push(Q2)

      await triggerAutoAnswer_NEW(Q1)
      expect(autoAnswerCallLog.some(c => c.q === Q2)).toBe(true)
    })
  })

  describe('Bug 2: text→choice upgrade re-triggers auto-answer', () => {
    function wasUpgradedToChoice(originalQ: QuestionItem, currentQ: QuestionItem): boolean {
      return (
        originalQ.questions.every(q => q.type === 'text') &&
        currentQ.questions.some(q => q.type === 'choice' && q.options.length > 0)
      )
    }

    const Q_TEXT   = makeQuestion('pane-B', 'text', false)
    const Q_CHOICE = makeQuestion('pane-B', 'choice', true)

    it('detects upgrade: original=text, current=choice', () => {
      expect(wasUpgradedToChoice(Q_TEXT, Q_CHOICE)).toBe(true)
    })

    it('no upgrade: original=choice, current=choice', () => {
      expect(wasUpgradedToChoice(makeQuestion('x', 'choice', true), Q_CHOICE)).toBe(false)
    })

    it('no upgrade: original=text, current=text', () => {
      expect(wasUpgradedToChoice(Q_TEXT, Q_TEXT)).toBe(false)
    })

    it('upgrade scenario: retrigger fired, text answer NOT submitted', async () => {
      const log: { action: string }[] = []

      async function triggerWithUpgrade(q: QuestionItem, currentActive: QuestionItem) {
        if (currentActive.paneId === q.paneId) {
          if (wasUpgradedToChoice(q, currentActive)) {
            log.push({ action: 'retrigger' })
          } else {
            log.push({ action: 'submit' })
          }
        }
      }

      await triggerWithUpgrade(Q_TEXT, Q_CHOICE)
      expect(log.some(r => r.action === 'retrigger')).toBe(true)
      expect(log.some(r => r.action === 'submit')).toBe(false)
    })

    it('no upgrade scenario: answer submitted, retrigger NOT fired', async () => {
      const log: { action: string }[] = []

      async function triggerWithUpgrade(q: QuestionItem, currentActive: QuestionItem) {
        if (currentActive.paneId === q.paneId) {
          if (wasUpgradedToChoice(q, currentActive)) {
            log.push({ action: 'retrigger' })
          } else {
            log.push({ action: 'submit' })
          }
        }
      }

      await triggerWithUpgrade(Q_TEXT, Q_TEXT)
      expect(log.some(r => r.action === 'submit')).toBe(true)
      expect(log.some(r => r.action === 'retrigger')).toBe(false)
    })
  })

  describe('backend response parsing', () => {
    function simulateBackendAutoAnswer(questions: Question[], rawLLMResponse: string) {
      let answers: string[]
      if (questions.length === 1) {
        answers = [rawLLMResponse.trim()]
      } else {
        answers = questions.map((_, i) => {
          const pattern = new RegExp(`A${i + 1}\\.\\s*(.+?)(?=\\nA${i + 2}\\.|$)`, 's')
          const m = rawLLMResponse.match(pattern)
          return m ? m[1].trim() : rawLLMResponse.trim()
        })
      }
      const combined =
        questions.length === 1
          ? answers[0]
          : questions.map((q, i) => `Q${i + 1}. ${q.prompt}\nA${i + 1}. ${answers[i]}`).join('\n\n')
      return { ok: true, answer: combined, answers }
    }

    it('single choice: answer is just the option (no prefix)', () => {
      const result = simulateBackendAutoAnswer(
        [{ prompt: '選哪個技術棧?', type: 'choice', options: ['React', 'Vue', 'Angular'] }],
        'Vue'
      )
      expect(result.answer).toBe('Vue')
    })

    it('single choice: answers array has one item', () => {
      const result = simulateBackendAutoAnswer(
        [{ prompt: '選哪個技術棧?', type: 'choice', options: ['React', 'Vue', 'Angular'] }],
        'Vue'
      )
      expect(result.answers).toHaveLength(1)
      expect(result.answers[0]).toBe('Vue')
    })

    it('multi-question: A1 parsed correctly', () => {
      const result = simulateBackendAutoAnswer(
        [
          { prompt: '使用哪種DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] },
          { prompt: '要支援哪些語言?', type: 'text', options: [] }
        ],
        'A1. PostgreSQL\nA2. 繁體中文和英文'
      )
      expect(result.answers[0]).toBe('PostgreSQL')
    })

    it('multi-question: A2 parsed correctly', () => {
      const result = simulateBackendAutoAnswer(
        [
          { prompt: '使用哪種DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] },
          { prompt: '要支援哪些語言?', type: 'text', options: [] }
        ],
        'A1. PostgreSQL\nA2. 繁體中文和英文'
      )
      expect(result.answers[1]).toBe('繁體中文和英文')
    })

    it('multi-question: combined format contains Q1/A1 and Q2/A2', () => {
      const result = simulateBackendAutoAnswer(
        [
          { prompt: '使用哪種DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] },
          { prompt: '要支援哪些語言?', type: 'text', options: [] }
        ],
        'A1. PostgreSQL\nA2. 繁體中文和英文'
      )
      expect(result.answer).toContain('Q1.')
      expect(result.answer).toContain('A2.')
    })
  })
})
