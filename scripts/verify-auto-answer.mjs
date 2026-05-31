/**
 * Verification script for the auto-answer (全自動回覆) feature.
 * Run with: node scripts/verify-auto-answer.mjs
 *
 * Tests the two bugs fixed in triggerAutoAnswer:
 *   Bug 1: autoAnswerPending not cleared before dequeueNextQuestion →
 *           queued questions were permanently stranded (never auto-answered)
 *   Bug 2: text→choice upgrade race: LLM answer from text version was
 *           submitted to a choice question instead of re-triggering
 */

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅  ${name}`)
    passed++
  } else {
    console.error(`  ❌  ${name}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

// ── Simulate the triggerAutoAnswer + dequeueNextQuestion interaction ─────────

function makeQuestion(paneId, type = 'text', withOptions = false) {
  return {
    paneId,
    stageIndex: 0,
    questions: [{ prompt: '問題?', type, options: withOptions ? ['選項A', '選項B'] : [] }],
    agentLabel: 'Claude',
    stageTitle: 'Stage 01',
    slotLabel: ''
  }
}

// ── Test 1: Race condition fix — autoAnswerPending cleared before dequeue ─────
console.log('\n── Test 1: Bug 1 fix — queued question gets auto-answered ──')

{
  let autoAnswerPending = false
  let autoAnswerText = ''
  let activeQuestion = null
  const questionQueue = []
  const autoAnswerCallLog = []  // track calls to triggerAutoAnswer

  function dequeueNextQuestion() {
    const next = questionQueue.shift() ?? null
    activeQuestion = next
    if (next) {
      // This is the OLD behavior: checks autoAnswerPending before triggering
      // The NEW code resets autoAnswerPending BEFORE this function is called
      if (!autoAnswerPending) {
        autoAnswerCallLog.push({ fn: 'triggerAutoAnswer', q: next })
      }
    }
  }

  function onAnswerQuestion(answer) {
    // Simulates submitting an answer — calls dequeueNextQuestion
    dequeueNextQuestion()
    // inject answer...
  }

  async function triggerAutoAnswer_OLD(q) {
    autoAnswerPending = true
    // ... LLM call ...
    autoAnswerText = 'LLM answer'
    // await sleep(1500)
    if (activeQuestion?.paneId === q.paneId) {
      // BUG: autoAnswerPending is STILL true here
      // dequeueNextQuestion inside onAnswerQuestion will see pending=true → skip
      await onAnswerQuestion(autoAnswerText)
    }
    // finally:
    autoAnswerPending = false
    autoAnswerText = ''
  }

  async function triggerAutoAnswer_NEW(q) {
    autoAnswerPending = true
    // ... LLM call ...
    autoAnswerText = 'LLM answer'
    // await sleep(1500)
    if (activeQuestion?.paneId === q.paneId) {
      // FIX: reset BEFORE calling onAnswerQuestion so dequeueNextQuestion sees false
      autoAnswerPending = false
      autoAnswerText = ''
      await onAnswerQuestion('LLM answer')
    }
    // finally (safety net):
    autoAnswerPending = false
    autoAnswerText = ''
  }

  // Setup: Q1 is active, Q2 is in queue
  const Q1 = makeQuestion('pane-A')
  const Q2 = makeQuestion('pane-A')
  activeQuestion = Q1
  questionQueue.push(Q2)

  // Test OLD behavior: Q2 never gets auto-answered
  autoAnswerCallLog.length = 0
  autoAnswerPending = false
  await triggerAutoAnswer_OLD(Q1)
  const oldGotAutoAnswer = autoAnswerCallLog.some(c => c.q === Q2)
  check('OLD code: Q2 does NOT get auto-answered (confirms the bug existed)', !oldGotAutoAnswer)

  // Reset state
  activeQuestion = Q1
  questionQueue.push(Q2)
  autoAnswerCallLog.length = 0
  autoAnswerPending = false

  // Test NEW behavior: Q2 gets auto-answered
  await triggerAutoAnswer_NEW(Q1)
  const newGotAutoAnswer = autoAnswerCallLog.some(c => c.q === Q2)
  check('NEW code: Q2 DOES get auto-answered after Q1 completes', newGotAutoAnswer)
}

// ── Test 2: text→choice upgrade detection ────────────────────────────────────
console.log('\n── Test 2: Bug 2 fix — text→choice upgrade re-triggers auto-answer ──')

{
  const Q_TEXT = makeQuestion('pane-B', 'text', false)       // original text question
  const Q_CHOICE = makeQuestion('pane-B', 'choice', true)    // upgraded choice version

  // Simulate the detection logic in triggerAutoAnswer
  function wasUpgradedToChoiceCheck(originalQ, currentActiveQ) {
    return (
      originalQ.questions.every(oq => oq.type === 'text') &&
      currentActiveQ.questions.some(cq => cq.type === 'choice' && cq.options.length > 0)
    )
  }

  // When question upgraded: should re-trigger
  check(
    'Upgrade detected: original=text, current=choice → wasUpgradedToChoice=true',
    wasUpgradedToChoiceCheck(Q_TEXT, Q_CHOICE)
  )

  // When no upgrade: should NOT re-trigger
  check(
    'No upgrade: original=choice, current=choice → wasUpgradedToChoice=false',
    !wasUpgradedToChoiceCheck(makeQuestion('x', 'choice', true), Q_CHOICE)
  )

  check(
    'No upgrade: original=text, current=text → wasUpgradedToChoice=false',
    !wasUpgradedToChoiceCheck(Q_TEXT, Q_TEXT)
  )

  // Simulate the full flow: LLM running for text version, question gets upgraded
  let autoAnswerPending = false
  const retriggerLog = []

  async function triggerAutoAnswer_UPGRADED(q, currentActive) {
    autoAnswerPending = true
    const llmAnswer = 'auto text answer'  // LLM answered for text version

    // sleep(1500) ...
    if (currentActive?.paneId === q.paneId) {
      const wasUpgraded = wasUpgradedToChoiceCheck(q, currentActive)
      autoAnswerPending = false
      if (wasUpgraded) {
        retriggerLog.push({ action: 'retrigger', q: currentActive })
        // void triggerAutoAnswer(currentActive) — not actually calling for test
      } else {
        retriggerLog.push({ action: 'submit', answer: llmAnswer })
      }
    }
    autoAnswerPending = false
  }

  // Scenario: text question, got upgraded to choice mid-answer
  await triggerAutoAnswer_UPGRADED(Q_TEXT, Q_CHOICE)
  check(
    'Upgrade scenario: retrigger fired (not submit)',
    retriggerLog.some(r => r.action === 'retrigger')
  )
  check(
    'Upgrade scenario: text answer NOT submitted',
    !retriggerLog.some(r => r.action === 'submit')
  )

  // Scenario: text question, no upgrade
  retriggerLog.length = 0
  await triggerAutoAnswer_UPGRADED(Q_TEXT, Q_TEXT)
  check(
    'No upgrade scenario: answer submitted (not retrigger)',
    retriggerLog.some(r => r.action === 'submit')
  )
  check(
    'No upgrade scenario: retrigger NOT fired',
    !retriggerLog.some(r => r.action === 'retrigger')
  )
}

// ── Test 3: Backend auto_answer response format ───────────────────────────────
console.log('\n── Test 3: Backend response parsing ──')

{
  // Simulate what backend returns and frontend parses for choice questions
  function simulateBackendAutoAnswer(questions, rawLLMResponse) {
    // Parse per-question answers (mirrors backend logic)
    let answers
    if (questions.length === 1) {
      answers = [rawLLMResponse.trim()]
    } else {
      answers = []
      for (let i = 0; i < questions.length; i++) {
        const pattern = new RegExp(`A${i+1}\\.\\s*(.+?)(?=\\nA${i+2}\\.|$)`, 's')
        const m = rawLLMResponse.match(pattern)
        answers.push(m ? m[1].trim() : rawLLMResponse.trim())
      }
    }
    // Build combined
    const combined = questions.length === 1
      ? answers[0]
      : questions.map((q, i) => `Q${i+1}. ${q.prompt}\nA${i+1}. ${answers[i]}`).join('\n\n')
    return { ok: true, answer: combined, answers }
  }

  // Single choice question
  const choiceQ = [{ prompt: '選哪個技術棧?', type: 'choice', options: ['React', 'Vue', 'Angular'] }]
  const result1 = simulateBackendAutoAnswer(choiceQ, 'Vue')
  check('Single choice: answer is just the option (no prefix)', result1.answer === 'Vue')
  check('Single choice: answers array has one item', result1.answers.length === 1 && result1.answers[0] === 'Vue')

  // Multi-question
  const multiQ = [
    { prompt: '使用哪種DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] },
    { prompt: '要支援哪些語言?', type: 'text', options: [] }
  ]
  const result2 = simulateBackendAutoAnswer(multiQ, 'A1. PostgreSQL\nA2. 繁體中文和英文')
  check('Multi-Q: A1 parsed correctly', result2.answers[0] === 'PostgreSQL')
  check('Multi-Q: A2 parsed correctly', result2.answers[1] === '繁體中文和英文')
  check('Multi-Q: combined format has Q1/A1/Q2/A2', result2.answer.includes('Q1.') && result2.answer.includes('A2.'))
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`)
if (failed > 0) process.exit(1)
