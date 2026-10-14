export type ModInfo = {
  /** The name in the mod's plugin.json. */
  name: string
  description: string
  /** The mod's folder, absolute. */
  folder: string
  /** The slash commands the mod registered, without the slash. */
  commands: string[]
  /** `dev`: a mod in your mods folder, changed in place. `installed`: one installed from a marketplace. */
  kind: 'dev' | 'installed'
  /** For an installed mod, the marketplace it came from. */
  marketplace?: string
}

export type Catalog = {
  mods: ModInfo[]
  /** Every command name the session offers right now, without the slash. */
  available: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'roberts-toolbox': {
      catalog: Catalog | null
      /** True from a click on the Robert's Toolbox button until a pick, another click or a prompt. */
      isOpen: boolean
    }
  }
}
