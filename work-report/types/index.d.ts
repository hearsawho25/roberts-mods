export type ReportTab = 'today' | 'week' | 'month' | 'year'

declare module 'claude-code' {
  interface PluginState {
    'work-report': { tab: ReportTab; rev: number }
  }
}
