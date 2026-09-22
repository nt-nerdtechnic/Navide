<script setup lang="ts">
import { BranchDiffPane, useGit, type GitBranchDiffPort, type GitTransport } from '../git-composition'

const props = defineProps<{
  workspacePath: string
  base: string
  compare: string
  gitTransport: GitTransport
  branchDiff: GitBranchDiffPort
}>()
const emit = defineEmits<{
  'open-file': [payload: { filepath: string; name: string; line?: number }]
  'ask-ai-fix': [text: string]
}>()

// The legacy independent branch tab owns its repository subscription. The
// reusable Git view accepts that state from its consumer composition.
const { gitStatus, gitBranches } = useGit(() => props.workspacePath, props.gitTransport)
</script>

<template>
  <BranchDiffPane
    v-bind="props"
    :git-status="gitStatus"
    :git-branches="gitBranches"
    @open-file="emit('open-file', $event)"
    @ask-ai-fix="emit('ask-ai-fix', $event)"
  >
    <template #review="scope"><slot name="review" v-bind="scope" /></template>
  </BranchDiffPane>
</template>
