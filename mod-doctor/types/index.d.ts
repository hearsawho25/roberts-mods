/** A checked mod's standing: in the loaded set and passing, missing from it, or loaded but failing validate. */
export type ModDoctorModStatus = 'loaded' | 'not-loaded' | 'broken'

/** One checked mod as the report lists it; the same shape as core.ts's ModReport. */
export type ModDoctorMod = {
  name: string
  /** The version on record in `claude plugin list`; null when it states none. */
  version: string | null
  status: ModDoctorModStatus
  /** Up to three error lines from `claude plugin validate`, paths relative to the mod's folder. */
  errors: string[]
  /** `validate passes; try /reload-plugins` or `couldn't validate: <reason>`; null when none. */
  note: string | null
  /** Set when the mod is read from its folder and the folder's version differs from the one on record. */
  drift: { folder: string; record: string } | null
  /** Its slash commands, without the `/`. */
  commands: string[]
}

/** One check's result; the same shape as core.ts's Report. */
export type ModDoctorReport = {
  /** When the check ran, epoch ms. */
  checkedAt: number
  /** Problems first, then by name. */
  mods: ModDoctorMod[]
  /** `--plugin-dir` mods heard through plugin.register (provenance `@inline`). */
  inline: string[]
  /** Enabled plugins with no hooks module. */
  skipped: number
  /** Set when the check itself could not run; the mods are then empty. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'mod-doctor': {
      /** Every module heard loading this session: engine.create's list plus each plugin.register since, sorted. */
      loaded: string[]
      /** The `--plugin-dir` mods heard through plugin.register. */
      inline: string[]
      /** The last check's result; null before the first. */
      report: ModDoctorReport | null
      /** True while a check runs. */
      checking: boolean
      /** The toastKey of every toast raised this session. */
      toasted: string[]
      /** Whether the Mod Doctor pane is open: the row's Open/Close. */
      paneOpen: boolean
    }
  }
}
