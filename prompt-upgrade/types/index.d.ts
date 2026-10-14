export type PromptUpgradeStep = 'compose' | 'reading' | 'questions' | 'rewriting' | 'review' | 'error'

export type PromptUpgradeQuestion = { question: string; options: string[] }

export type PromptUpgradeAnswer = { kind: 'pick' | 'other' | 'skip'; text: string }

export type PromptUpgradeFlow = {
  id: string
  original: string
  step: PromptUpgradeStep
  questions: PromptUpgradeQuestion[]
  answers: (PromptUpgradeAnswer | null)[]
  otherOpen: number | null
  upgraded: string
  added: string[]
  isEditing: boolean
  isCopied: boolean
  failedDuring: 'questions' | 'rewrite' | null
  callId: string
}

export type PromptUpgradeEntry = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: PromptUpgradeFlow | null
      view: 'flow' | 'history'
      auto: boolean
      history: PromptUpgradeEntry[]
    }
  }
}
