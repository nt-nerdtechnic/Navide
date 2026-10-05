import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  WELCOME_MAIN_STEPS,
  WELCOME_PANE_STEPS,
  WELCOME_REPLAY_STEPS,
  welcomeStage,
  type WelcomeStage,
} from '../lib/welcomeTour'
import { useReleaseTour } from './useReleaseTour'

// What the first-run welcome tour records, and which part is due.
//
// `pending` is set only when the first-run wizard is completed (or put off)
// — never from the onboarding status check — so an install that was already
// set up before this tour existed never sees it. Ending either part early
// (Skip, Esc) counts as seen and turns the whole tour off: it was pushed at the
// user, so a skip must not bring it back. The replay records nothing.
const PENDING_KEY = 'agentTeam.tour.welcome.pending'
const MAIN_DONE_KEY = 'agentTeam.tour.welcome.mainDone'

export function useWelcomeTour() {
  const tour = useReleaseTour()

  function stage(): WelcomeStage {
    return welcomeStage({
      pending: settingsGet<boolean>(PENDING_KEY, false) === true,
      mainDone: settingsGet<boolean>(MAIN_DONE_KEY, false) === true,
    })
  }

  /** The first-run wizard was just completed: the tour is due. */
  function markFirstRun(): void {
    settingsSet(PENDING_KEY, true)
    settingsSet(MAIN_DONE_KEY, false)
  }

  function startMain(): boolean {
    if (stage() !== 'main') return false
    return tour.startNamed('welcome-main', WELCOME_MAIN_STEPS, (completed) => {
      if (completed) settingsSet(MAIN_DONE_KEY, true)
      else settingsSet(PENDING_KEY, false)
    })
  }

  function startPane(): boolean {
    if (stage() !== 'pane') return false
    return tour.startNamed('welcome-pane', WELCOME_PANE_STEPS, () => settingsSet(PENDING_KEY, false))
  }

  function replay(): boolean {
    return tour.startNamed('welcome-replay', WELCOME_REPLAY_STEPS)
  }

  return { stage, markFirstRun, startMain, startPane, replay }
}
