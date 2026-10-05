import { reactive, ref } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// What the first-run welcome tour records, and whether it is running.
//
// `pending` is set only when the first-run wizard is completed (or put off)
// — never from the onboarding status check — so an install that was already
// set up before this tour existed never sees it; App.vue also calls it off
// when a workspace record turns up as it comes due. Ending it, finished or
// skipped, turns it off for good: it was pushed at the user, who may well
// not be new to Navide. How far it got is kept, so a restart picks up there.
// A replay from the Help menu records nothing.
//
// Most of what a step waits for is read off the window (App.vue's
// welcomeFacts); the three momentary actions — an @ pick, a pane dropped on
// another, the quota badge opened — are reported through `notify`, which
// records nothing unless the tour is running.
const PENDING_KEY = 'agentTeam.tour.welcome.pending'
const STEP_KEY = 'agentTeam.tour.welcome.step'

export type WelcomeMoment = 'mention' | 'drop' | 'usage'

/** When each momentary action last happened while the tour ran. */
export const welcomeActionTimes = reactive({ mentionAt: 0, dropAt: 0, usageAt: 0 })

/** Which tour is on screen: the first-run one, a replay, or none. */
const active = ref<'first-run' | 'replay' | null>(null)

export function useWelcomeTour() {
  function pending(): boolean {
    return settingsGet<boolean>(PENDING_KEY, false) === true
  }

  function savedStep(): number {
    const step = settingsGet<number>(STEP_KEY, 0)
    return Number.isInteger(step) && step > 0 ? step : 0
  }

  /** The first-run wizard was just completed: the tour is due. */
  function markFirstRun(): void {
    settingsSet(PENDING_KEY, true)
    settingsSet(STEP_KEY, 0)
  }

  /** Not a first install after all: the tour is off. */
  function cancel(): void {
    settingsSet(PENDING_KEY, false)
    if (active.value === 'first-run') active.value = null
  }

  function start(): boolean {
    if (active.value || !pending()) return false
    active.value = 'first-run'
    return true
  }

  function replay(): void {
    active.value = 'replay'
  }

  function progress(step: number): void {
    if (active.value === 'first-run') settingsSet(STEP_KEY, step)
  }

  function finish(_completed: boolean): void {
    if (active.value === 'first-run') settingsSet(PENDING_KEY, false)
    active.value = null
  }

  function notify(what: WelcomeMoment): void {
    if (!active.value) return
    welcomeActionTimes[`${what}At`] = Date.now()
  }

  return { active, pending, savedStep, markFirstRun, cancel, start, replay, progress, finish, notify }
}
