<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import MockFigure from './helpMocks/MockFigure.vue'
import MockPanel from './helpMocks/MockPanel.vue'
import MockSettings from './helpMocks/MockSettings.vue'
import MockStatRow from './helpMocks/MockStatRow.vue'
import MockToolbar from './helpMocks/MockToolbar.vue'
// Read-only reference for the settings window and the system surfaces around it
// (Navide Cloud, the app menus, standalone windows, resource upkeep).
// Static mirror of the shipped UI — a prose copy of the "Settings & system"
// manual. Purely presentational: no props, no emits, no state. All prose lives
// in the locale files under `settings.help.settingsSystem.*`; the tables below
// keep only their row keys and the literal labels that are identical in every
// language.

interface TabRow {
  key: string
  /** Only set on the first row of a group; drives the rowspan cell. */
  group?: string
  groupSpan?: number
  tab: string
}

interface StatusRow {
  state: string
  color: string
}

interface StageRow {
  key: string
  stage?: string
  stageSpan?: number
}

// ── 1 · The seventeen tabs ───────────────────────────────────────────────
const tabs: TabRow[] = [
  { key: 'general', group: 'GENERAL', groupSpan: 5, tab: 'General' },
  { key: 'appearance', tab: 'Appearance' },
  { key: 'statusBadges', tab: 'Status badges' },
  { key: 'layout', tab: 'Layout' },
  { key: 'cloud', tab: 'Navide Cloud' },
  { key: 'accounts', group: 'ACCOUNTS & AGENTS', groupSpan: 3, tab: 'Accounts' },
  { key: 'cliAgents', tab: 'CLI Agents' },
  { key: 'analyzer', tab: 'Analyzer' },
  { key: 'mcp', group: 'INTEGRATIONS', groupSpan: 4, tab: 'MCP' },
  { key: 'skills', tab: 'Skills' },
  { key: 'prompts', tab: 'Prompts' },
  { key: 'memory', tab: 'Memory' },
  // Extensions belongs to PLUGINS, not INTEGRATIONS, and Execution Policy sits
  // beside it — both read off SettingsModal.vue:2015-2027, where the fourth
  // `.s-nav-group` holds exactly these two.
  { key: 'extensions', group: 'PLUGINS', groupSpan: 2, tab: 'Extensions' },
  { key: 'executionPolicy', tab: 'Execution Policy' },
  { key: 'shortcuts', group: 'SYSTEM', groupSpan: 3, tab: 'Shortcuts' },
  { key: 'updates', tab: 'Updates' },
  { key: 'help', tab: 'Help' },
]

// ── 2 · General ──────────────────────────────────────────────────────────
const generalSettings = [
  { key: 'confirmClose', name: 'Confirm before closing a pane' },
  { key: 'confirmCloseWorkspace', name: 'Confirm before closing a workspace' },
  { key: 'reclaimIdle', name: 'Reclaim idle CLIs' },
  { key: 'reclaimAfter', name: 'Reclaim after' },
  { key: 'reclaimNow', name: 'Reclaim now' },
  { key: 'resumeOnOpen', name: 'Resume conversations on open' },
  { key: 'resumeScope', name: 'Resume scope' },
  { key: 'resumeAfterRestart', name: 'Resume sessions after a backend restart' },
  { key: 'concurrentResume', name: 'Concurrent resume limit' },
  { key: 'defaultEditor', name: 'Default editor' },
  { key: 'quotaBadge', name: 'CLI quota badge' },
  { key: 'environment', name: 'Environment' },
  { key: 'backendTimeout', name: 'Backend Startup Timeout' },
  { key: 'loopPrompt', name: 'Loop Prompt' },
] as const

const statusBadges: StatusRow[] = [
  { state: 'starting', color: 'Blue' },
  { state: 'running', color: 'Green' },
  { state: 'idle', color: 'Yellow' },
  { state: 'awaiting', color: 'Orange' },
  { state: 'stopped', color: 'Ink' },
  { state: 'exited', color: 'Grey' },
  { state: 'error', color: 'Red' },
  { state: 'waiting', color: 'Grey' },
  { state: 'disconnected', color: 'Yellow' },
]

// ── 3 · Skills / Memory ──────────────────────────────────────────────────
const skillMatrix = ['on', 'native', 'none', 'pending'] as const

const memoryCoverage = [
  { key: 'mapped', label: 'Mapped' },
  { key: 'configured', label: 'Set in your config' },
  { key: 'unmapped', label: 'Not mapped' },
] as const

const updateStages: StageRow[] = [
  { key: 'autoCheck', stage: 'Check', stageSpan: 2 },
  { key: 'checkFailures' },
  { key: 'autoDownload', stage: 'Download', stageSpan: 2 },
  { key: 'retryDownload' },
  { key: 'installOnQuit', stage: 'Install', stageSpan: 2 },
  { key: 'installTimeout' },
]

// ── 5 · Navide Cloud ─────────────────────────────────────────────────────
const needsYou = [
  { key: 'pairing', label: 'Pairing' },
  { key: 'accessRequest', label: 'Access request' },
] as const

// ── 6 · Menus and windows ────────────────────────────────────────────────
const windowMenu = [
  { key: 'cloud', label: 'Navide Cloud' },
  { key: 'pipeline', label: 'Pipeline Manager' },
  { key: 'resource', label: 'Resource Manager' },
  { key: 'standard', label: 'Minimize / Zoom / Bring All to Front' },
] as const

const scheduleSections = [
  { key: 'crontab', label: 'System crontab' },
  { key: 'agents', label: 'macOS Agents' },
  { key: 'daemons', label: 'macOS Daemons' },
] as const

const otherWindows = [
  'mainWindow',
  'editor',
  'git',
  'diff',
  'branchDiff',
  'plan',
  'draggedGroup',
  'draggedWorkspace',
] as const

// ── 7 · Resources and upkeep ─────────────────────────────────────────────
const storageCategories = [
  { key: 'appData', label: 'App data' },
  { key: 'electron', label: 'Electron caches' },
  { key: 'cliHomes', label: 'CLI agent homes' },
  { key: 'workspaces', label: 'Workspaces' },
] as const

const maintenance = [
  'memory',
  'disk',
  'leftover',
  'unresponsive',
  'shortcutClash',
  'stubbornKey',
  'remoteAgent',
  'background',
  'moveSettings',
] as const
const { t } = useI18n()

// ── Mock screenshots ────────────────────────────────────────────────────────
// Two HTML pictures, drawn from the components they depict. Both are about
// ARRANGEMENT — which control sits where — because that is the one thing the
// prose tables in this topic cannot say; everything the tables already cover
// is deliberately not drawn again.
//
// Every label is a lookup of the key the real UI uses, so a renamed page or a
// reworded column lands in the picture too. Two claims in the prose did NOT
// survive being drawn from the source; they are noted where they occur.

const MARKS = ['\u2460', '\u2461', '\u2462']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.settingsSystem.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.settingsSystem.mock.${figure}.legend.${row}.text`),
  }))
}

function sample(key: string): string {
  return t(`settings.help.settingsSystem.mock.sample.${key}`)
}

const navLegend = computed(() => mockLegend('nav', ['search', 'groups', 'active']))
const resourceLegend = computed(() => mockLegend('resource', ['totals', 'rows', 'actions']))

// The nav exactly as SettingsModal.vue renders it (:1941-2043): five groups,
// seventeen pages, in this order. Labels come from the same `settings.nav.*`
// keys the real nav reads, so renaming a page renames it here.
//
// Drawing this is what caught the prose claiming four groups and sixteen
// pages, with Execution Policy missing from the table entirely: counting the
// nav items is something a picture forces and reading does not.
const settingsGroups = computed(() => [
  {
    title: t('settings.nav.group.general'),
    items: [
      { label: t('settings.nav.general'), active: true },
      { label: t('settings.nav.appearance') },
      { label: t('settings.nav.statusBadges') },
      { label: t('settings.nav.layout') },
      { label: t('settings.nav.crossDevice') },
    ],
  },
  {
    title: t('settings.nav.group.accountsAgents'),
    items: [
      { label: t('settings.nav.accounts') },
      { label: t('settings.nav.cliAgents') },
      { label: t('settings.nav.analyzer') },
    ],
  },
  {
    title: t('settings.nav.group.integration'),
    items: [
      { label: t('settings.nav.mcp') },
      { label: t('settings.nav.skills') },
      { label: t('settings.nav.prompts') },
      { label: t('settings.nav.memory') },
    ],
  },
  {
    title: t('settings.nav.group.plugins'),
    items: [
      { label: t('settings.nav.extensions') },
      { label: t('settings.nav.executionPolicy') },
    ],
  },
  {
    title: t('settings.nav.group.system'),
    items: [
      { label: t('settings.nav.keybindings') },
      { label: t('settings.nav.updates') },
      { label: t('settings.nav.help') },
    ],
  },
])

const settingsSearch = computed(() => ({
  placeholder: t('settings.search.placeholder'),
  query: sample('query'),
  results: [
    { title: sample('hit1'), group: t('settings.nav.group.general') },
    { title: sample('hit2'), group: t('settings.nav.group.general') },
  ],
  mark: MARKS[0],
}))

// Resource Manager's own column headings and filters, from `resource.*`.
const resourceColumns = computed(() => [
  t('resource.col-cpu'),
  t('resource.col-memory'),
])
const resourceFilters = computed(() => [
  { label: t('resource.filter-all', { count: 3 }), primary: true },
  { label: t('resource.filter-busy', { count: 2 }) },
  { label: t('resource.filter-idle', { count: 1 }) },
])

// An idle row carries no `IDLE` text — ResourceManagerModal.vue tells idle
// from running by the dot colour alone (:645, where only `running` overrides
// the default attention colour). Drawing it is what caught the prose above
// claiming a label that does not exist.
const resourceRows = computed(() => [
  {
    name: sample('paneA'),
    meta: sample('metaA'),
    trend: [3, 5, 4, 9, 12, 11, 12],
    values: [sample('cpuA'), sample('memA')],
    state: 'running' as const,
  },
  {
    name: sample('paneB'),
    meta: sample('metaB'),
    trend: [8, 6, 5, 4, 3, 3, 3],
    values: [sample('cpuB'), sample('memB')],
    state: 'running' as const,
  },
  {
    name: sample('paneC'),
    meta: sample('metaC'),
    trend: [2, 1, 1, 0, 0, 0, 0],
    values: [sample('cpuC'), sample('memC')],
    state: 'idle' as const,
  },
])
</script>

<template>
  <div class="syh">
    <p class="syh-intro">{{ $t('settings.help.settingsSystem.intro') }}</p>

    <!-- ── 1 · Settings overview ────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">1</span>{{ $t('settings.help.settingsSystem.s1.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s1.p1')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s1.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s1.p2')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s1.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s1.callout.text')"></div>
      </div>

      <MockFigure
        :caption="$t('settings.help.settingsSystem.mock.nav.caption')"
        :legend="navLegend"
      >
        <MockSettings
          :nav-title="$t('settings.nav.title')"
          :groups="settingsGroups"
          :search="settingsSearch"
          :nav-mark="MARKS[1]"
          page-title=""
        />
      </MockFigure>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s1.h2') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.group') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.tab') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.what') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.more') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tabs" :key="row.key">
              <td v-if="row.group" :rowspan="row.groupSpan" class="syh-group">{{ row.group }}</td>
              <td class="syh-nowrap"><strong>{{ row.tab }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s1.tabs.${row.key}.what`) }}</td>
              <td class="syh-muted">{{ $t(`settings.help.settingsSystem.s1.tabs.${row.key}.more`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s1.note')"></p>
    </section>

    <!-- ── 2 · General / Appearance / Status badges ─────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">2</span>{{ $t('settings.help.settingsSystem.s2.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h1') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.name') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.desc') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.fallback') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in generalSettings" :key="row.key">
              <td><strong>{{ row.name }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s2.generalSettings.${row.key}.desc`) }}</td>
              <td class="syh-nowrap">
                {{ $t(`settings.help.settingsSystem.s2.generalSettings.${row.key}.fallback`) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h2') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.theme')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.colors')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.language')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.uiScale')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.restore')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s2.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s2.callout.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s2.p1')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.state') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.when') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.color') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in statusBadges" :key="row.state">
              <td><code>{{ row.state }}</code></td>
              <td>{{ $t(`settings.help.settingsSystem.s2.statusBadges.${row.state}.when`) }}</td>
              <td class="syh-nowrap">{{ row.color }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s2.note')"></p>
    </section>

    <!-- ── 3 · Skills / Prompts / Memory ────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">3</span>{{ $t('settings.help.settingsSystem.s3.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p1')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s3.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s3.callout1.text')"></div>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p2')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.cell') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.meaning') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.who') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in skillMatrix" :key="key">
              <td class="syh-nowrap">
                <code>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.cell`) }}</code>
              </td>
              <td>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.meaning`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.who`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p3')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p4')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.cast')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.ring')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.overflow')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.preview')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.keyboard')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.disabled')"></li>
      </ul>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s3.note')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p5')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s3.memory.levels')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.memory.notCreated')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.memory.reload')"></li>
      </ul>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p6')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s3.coverageTable.category') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.coverageTable.meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in memoryCoverage" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.label }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s3.memoryCoverage.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s3.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s3.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 4 · Shortcuts / Updates / Analyzer / Extensions ──────────── -->
    <section class="syh-section">
      <h2 class="syh-h2">
        <span class="syh-num">4</span>{{ $t('settings.help.settingsSystem.s4.title') }}
      </h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.record')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.instant')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.search')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.conflicts')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.reset')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s4.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s4.callout.text')"></div>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s4.note')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h2') }}</h3>
      <p class="syh-p">{{ $t('settings.help.settingsSystem.s4.p2') }}</p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.stage') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.toggle') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.fallback') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in updateStages" :key="row.key">
              <td v-if="row.stage" :rowspan="row.stageSpan" class="syh-group">{{ row.stage }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s4.updateStages.${row.key}.toggle`) }}</td>
              <td class="syh-nowrap">
                {{ $t(`settings.help.settingsSystem.s4.updateStages.${row.key}.fallback`) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p3')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p4')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p5')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.backend')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.models')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.benchmark')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h4') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p6')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p7')"></p>
    </section>

    <!-- ── 5 · Navide Cloud ─────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">5</span>{{ $t('settings.help.settingsSystem.s5.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.entries.account')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.entries.settings')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p2')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p3')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout1.title') }}</div>
        <div class="syh-callout-text">{{ $t('settings.help.settingsSystem.s5.callout1.text') }}</div>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p4')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p5')"></p>
      <ol class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step1')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step2')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step3')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step4')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step5')"></li>
      </ol>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout2.title') }}</div>
        <div class="syh-callout-text">{{ $t('settings.help.settingsSystem.s5.callout2.text') }}</div>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s5.note1')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p6')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.kind') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.content') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in needsYou" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.label }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s5.needsYou.${row.key}.content`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s5.needsYou.${row.key}.actions`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p7')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.trust.block')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.trust.unpair')"></li>
      </ul>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p8')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h4') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p9')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.rules.denyAll')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.shape')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.ownDevices')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.online')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.signed')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h5') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p10')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout3.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s5.callout3.text')"></div>
      </div>
    </section>

    <!-- ── 6 · Menus, standalone windows and schedules ──────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">6</span>{{ $t('settings.help.settingsSystem.s6.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h1') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.windowTable.item') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.windowTable.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in windowMenu" :key="row.key">
              <td><strong>{{ row.label }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s6.windowMenu.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s6.note1')"></p>

      <div class="syh-card">
        <div class="syh-card-title">Pipeline Manager</div>
        <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.pipeline.p1')"></p>
        <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.pipeline.p2')"></p>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h2') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.github')"></li>
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.shortcuts')"></li>
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.legal')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s6.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s6.callout1.text')"></div>
      </div>

      <h3 class="syh-h3" v-html="$t('settings.help.settingsSystem.s6.h3')"></h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.p1')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.section') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.source') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in scheduleSections" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.label }}</strong></td>
              <td><code>{{ $t(`settings.help.settingsSystem.s6.scheduleSections.${row.key}.source`) }}</code></td>
              <td>{{ $t(`settings.help.settingsSystem.s6.scheduleSections.${row.key}.actions`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.p2')"></p>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s6.note2')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h4') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.otherTable.window') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.otherTable.how') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in otherWindows" :key="key">
              <td class="syh-nowrap">{{ $t(`settings.help.settingsSystem.s6.otherWindows.${key}.window`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s6.otherWindows.${key}.how`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s6.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s6.callout2.text')"></div>
      </div>
      <p class="syh-note">{{ $t('settings.help.settingsSystem.s6.note3') }}</p>
    </section>

    <!-- ── 7 · Resources and upkeep ─────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">7</span>{{ $t('settings.help.settingsSystem.s7.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s7.resource.columns')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.totals')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.filters')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.actions')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.autoReclaim')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.disk')"></li>
      </ul>

      <MockFigure
        :caption="$t('settings.help.settingsSystem.mock.resource.caption')"
        :legend="resourceLegend"
      >
        <MockPanel>
          <MockToolbar
            :label="$t('resource.title')"
            :buttons="[{ label: $t('resource.disk-scan') }, { label: $t('resource.refresh') }]"
            :mark="MARKS[0]"
          />
          <div class="syh-mock-cards">
            <MockPanel :label="$t('resource.cpu')" :note="sample('cpuTotal')" />
            <MockPanel :label="$t('resource.memory')" :note="sample('memTotal')" />
            <MockPanel :label="$t('resource.disk')" :note="sample('diskTotal')" />
          </div>
          <MockToolbar
            :buttons="resourceFilters"
            :note="`${$t('resource.sort-label')} · ${$t('resource.sort-memory')}`"
          />
          <MockPanel>
            <MockStatRow
              :name="$t('resource.col-name')"
              :values="resourceColumns"
              :action="$t('resource.col-trend')"
            />
            <MockStatRow
              v-for="(row, i) in resourceRows"
              :key="row.name"
              v-bind="row"
              :action="$t('resource.reclaim-row')"
              :mark="i === 0 ? MARKS[1] : undefined"
            />
          </MockPanel>
          <div class="syh-mock-foot">
            {{ $t('resource.auto-reclaim', { state: $t('label.on'), minutes: sample('autoReclaim') }) }}
          </div>
        </MockPanel>
      </MockFigure>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s7.note1')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s7.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s7.callout1.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p2')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s7.storageTable.category') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s7.storageTable.examples') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in storageCategories" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.label }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s7.storageCategories.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p3')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p4')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s7.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s7.callout2.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h3') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.leftover')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.backend')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.timeout')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h4') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s7.maintenanceTable.symptom') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s7.maintenanceTable.where') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in maintenance" :key="key">
              <td>{{ $t(`settings.help.settingsSystem.s7.maintenance.${key}.symptom`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s7.maintenance.${key}.where`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Layout for the Resource Manager mock: the three summary cards sit in a row
   that wraps, and the auto-reclaim line under the table is a plain footnote. */
.syh-mock-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4em;
}
.syh-mock-cards > * { flex: 1 1 6em; }
.syh-mock-foot {
  color: var(--text-muted);
  font-size: 0.9em;
}
.syh {
  display: flex;
  flex-direction: column;
  gap: 26px;
  color: var(--text-primary);
  max-width: 78ch;
}

.syh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.syh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.syh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.syh-num {
  color: var(--accent-fg);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-sm);
}

.syh-h3 {
  margin: 10px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}

.syh-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.syh-list {
  margin: 0;
  padding-left: 1.4em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.syh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.syh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.syh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.syh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.syh-callout--warn .syh-callout-title {
  color: var(--attention-fg);
}

.syh-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.syh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.syh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.syh-table th,
.syh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.syh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-table tr:last-child td { border-bottom: none; }

.syh-group {
  background: var(--bg-inset);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-nowrap { white-space: nowrap; }
.syh-muted { color: var(--text-secondary); }

/* `code` and `.syh-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.syh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.syh :deep(.syh-kbd) {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 6px;
  white-space: nowrap;
  color: var(--text-primary);
}
</style>
