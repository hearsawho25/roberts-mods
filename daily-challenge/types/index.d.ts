export type Swap = { day: string; id: string }

export type Progress = {
  completed: Record<string, string>
  swap: Swap | null
}

declare module 'claude-code' {
  interface PluginState {
    'daily-challenge': { progress: Progress | null }
  }
}
