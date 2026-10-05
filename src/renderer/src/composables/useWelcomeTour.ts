import { reactive } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  WELCOME_MAIN_STEPS,
  WELCOME_PANE_STEPS,
  WELCOME_REPLAY_STEPS,
  WELCOME_START_STEPS,
  welcomeStage,
  type WelcomeStage,
} from '../lib/welcomeTour'
import { useReleaseTour } from './useReleaseTour'

// What the first-run welcome tour records, and which part is due.
//
// `pending` is set only when the first-run wizard is completed (or put off)
// — never from the onboarding status check — so an install that was already
// set up before this tour existed never sees it. Ending any part early (Skip,
// Esc) counts as seen and turns the whole tour off: it was pushed at the user,
// who may well not be new to Navide, so a skip must not bring it back. Skip is
// therefore on every card — the last card of the first two parts too, since
// another part still follows. The replay records nothing.
//
// The first-run parts are interactive: an action card waits until the person
// does what it asks (lib/welcomeTour.ts names the actions). Most actions are
// read off state the window already has; the three that are momentary — an
// @ pick, a pane dropped on another, the quota badge opened (which switching
// account from it always follows) — are reported through `notify`, which records nothing unless an
// interactive part is running. The replay is a plain walk-through.
const PENDING_KEY = 'agentTeam.tour.welcome.pending'
const START_DONE_KEY = 'agentTeam.tour.welcome.startDone'
const MAIN_DONE_KEY = 'agentTeam.tour.welcome.mainDone'

export type WelcomeMoment = 'mention' | 'drop' | 'usage'

/** When each momentary action last happened during an interactive part. */
export const welcomeActionTimes = reactive({ mentionAt: 0, dropAt: 0, usageAt: 0 })

export function useWelcomeTour() {
  const tour = useReleaseTour()

  function stage(): WelcomeStage {
    return welcomeStage({
      pending: settingsGet<boolean>(PENDING_KEY, false) === true,
      startDone: settingsGet<boolean>(START_DONE_KEY, false) === true,
      mainDone: settingsGet<boolean>(MAIN_DONE_KEY, false) === true,
    })
  }

  /** The first-run wizard was just completed: the tour is due. */
  function markFirstRun(): void {
    settingsSet(PENDING_KEY, true)
    settingsSet(START_DONE_KEY, false)
    settingsSet(MAIN_DONE_KEY, false)
  }

  /** A part ended: finishing it moves on, leaving it early ends the tour. */
  function partEnded(doneKey: string): (completed: boolean) => void {
    return (completed) => {
      if (completed) settingsSet(doneKey, true)
      else settingsSet(PENDING_KEY, false)
    }
  }

  function startWelcome(): boolean {
    if (stage() !== 'start') return false
    return tour.startNamed('welcome-start', WELCOME_START_STEPS, partEnded(START_DONE_KEY), {
      skipOnLast: true,
      interactive: true,
    })
  }

  /** A workspace was already open when the tour came due (a window opened on
   *  a folder never shows Welcome): go on to the main-screen part. */
  function passWelcome(): void {
    if (stage() === 'start') settingsSet(START_DONE_KEY, true)
  }

  function startMain(): boolean {
    if (stage() !== 'main') return false
    return tour.startNamed('welcome-main', WELCOME_MAIN_STEPS, partEnded(MAIN_DONE_KEY), {
      skipOnLast: true,
      interactive: true,
    })
  }

  function startPane(): boolean {
    if (stage() !== 'pane') return false
    return tour.startNamed('welcome-pane', WELCOME_PANE_STEPS, () => settingsSet(PENDING_KEY, false), {
      interactive: true,
    })
  }

  function replay(): boolean {
    return tour.startNamed('welcome-replay', WELCOME_REPLAY_STEPS)
  }

  /** A momentary action happened; a no-op unless an interactive part runs. */
  function notify(what: WelcomeMoment): void {
    if (!tour.interactive.value) return
    welcomeActionTimes[`${what}At`] = Date.now()
  }

  return { stage, markFirstRun, startWelcome, passWelcome, startMain, startPane, replay, notify }
}
