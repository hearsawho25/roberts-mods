import type { Catalog, ModInfo } from '../types'

export type Tool = {
  key: string
  /** The command without the slash; for a plugin skill, its full `plugin:skill` name. */
  command: string
  description: string
  /** `run` runs the command at once; `fill` puts it in the prompt box for you to finish. */
  action: 'run' | 'fill'
  section: 'claude' | 'plugins'
}

/** The commands that change Claude Code itself, each shown only where this version has it. */
export const TOOLS: readonly Tool[] = [
  { key: 'plugin', command: 'plugin', description: 'Install, enable or remove plugins', action: 'run', section: 'claude' },
  { key: 'reload-plugins', command: 'reload-plugins', description: 'Pick up plugin changes now', action: 'run', section: 'claude' },
  { key: 'config', command: 'config', description: 'Open settings', action: 'run', section: 'claude' },
  { key: 'theme', command: 'theme', description: 'Change the theme', action: 'run', section: 'claude' },
  { key: 'color', command: 'color', description: 'Colour this prompt bar', action: 'run', section: 'claude' },
  { key: 'statusline', command: 'statusline', description: 'Set up the status line', action: 'fill', section: 'claude' },
  { key: 'output-style', command: 'output-style', description: 'Switch the response style', action: 'run', section: 'claude' },
  { key: 'keybindings', command: 'keybindings', description: 'Edit keyboard shortcuts', action: 'run', section: 'claude' },
  { key: 'hooks', command: 'hooks', description: 'See automatic actions', action: 'run', section: 'claude' },
  { key: 'permissions', command: 'permissions', description: 'Allow and deny rules', action: 'run', section: 'claude' },
  { key: 'memory', command: 'memory', description: 'Edit CLAUDE.md instructions', action: 'run', section: 'claude' },
  { key: 'mcp', command: 'mcp', description: 'Manage connectors', action: 'run', section: 'claude' },
  { key: 'skills', command: 'skills', description: 'List your skills', action: 'run', section: 'claude' },
  { key: 'reload-skills', command: 'reload-skills', description: 'Pick up skill changes now', action: 'run', section: 'claude' },
  { key: 'tui', command: 'tui', description: 'Switch the screen layout', action: 'run', section: 'claude' },
  { key: 'skin-designer', command: 'skins:skin-designer', description: 'Restyle the transcript', action: 'fill', section: 'plugins' },
  { key: 'update-config', command: 'update-config', description: 'Change settings by asking', action: 'fill', section: 'plugins' },
  { key: 'keybindings-help', command: 'keybindings-help', description: 'Rebind keys by asking', action: 'fill', section: 'plugins' },
  { key: 'revise-claude-md', command: 'claude-md-management:revise-claude-md', description: 'Fold lessons into CLAUDE.md', action: 'fill', section: 'plugins' },
  { key: 'fewer-prompts', command: 'fewer-permission-prompts', description: 'Cut repeat permission prompts', action: 'fill', section: 'plugins' },
]

export function isAvailable(tool: Tool, catalog: Catalog): boolean {
  return catalog.available.includes(tool.command)
}

export function toolsIn(section: Tool['section'], catalog: Catalog): Tool[] {
  return TOOLS.filter(tool => tool.section === section && isAvailable(tool, catalog))
}

/** The folder that holds this mod's folder: where the other mods live. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

export function joinPath(folder: string, ...parts: string[]): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return [folder.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

/** A mod's folder name as people read it: `work-report` shows as `Work Report`. */
export function displayName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(word => word !== '')
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

/** Reads a plugin.json's text into its name and description, or undefined when it is not one. */
export function readManifest(text: string): { name: string; description: string } | undefined {
  try {
    const parsed = JSON.parse(text) as { name?: unknown; description?: unknown }
    if (typeof parsed.name !== 'string' || parsed.name === '') return undefined
    return { name: parsed.name, description: typeof parsed.description === 'string' ? parsed.description : '' }
  } catch {
    return undefined
  }
}

/** The `.claude` folder this mod sits under, where Claude Code keeps its plugins and settings. */
export function claudeHome(root: string): string | undefined {
  const parts = root.split(/[\\/]/)
  const at = parts.lastIndexOf('.claude')
  if (at < 0) return undefined
  return parts.slice(0, at + 1).join(root.includes('\\') && !root.includes('/') ? '\\' : '/')
}

export type InstalledPlugin = { name: string; marketplace: string; folder: string }

/**
 * Reads installed_plugins.json into the plugins installed from a marketplace,
 * leaving out any that settings.json's `enabledPlugins` turns off.
 */
export function readInstalled(installedText: string, settingsText?: string): InstalledPlugin[] {
  let enabled: Record<string, unknown> = {}
  try {
    const settings = JSON.parse(settingsText ?? '{}') as { enabledPlugins?: unknown }
    if (typeof settings.enabledPlugins === 'object' && settings.enabledPlugins !== null) {
      enabled = settings.enabledPlugins as Record<string, unknown>
    }
  } catch {
    // Unreadable settings turn nothing off.
  }
  try {
    const parsed = JSON.parse(installedText) as { plugins?: Record<string, { installPath?: unknown }[]> }
    const found: InstalledPlugin[] = []
    for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
      const at = key.lastIndexOf('@')
      const folder = installs?.[0]?.installPath
      if (at <= 0 || typeof folder !== 'string' || enabled[key] === false) continue
      found.push({ name: key.slice(0, at), marketplace: key.slice(at + 1), folder })
    }
    return found
  } catch {
    return []
  }
}

/** Whether a hooks.json's text loads hooks modules: what makes a plugin a mod. */
export function isModHooks(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { modules?: unknown }
    return Array.isArray(parsed.modules) && parsed.modules.length > 0
  } catch {
    return false
  }
}

export function changeRequest(mod: ModInfo): string {
  if (mod.kind === 'installed') {
    return (
      `Change my installed ${mod.name} mod (from the ${mod.marketplace ?? 'unknown'} marketplace, its folder is ${mod.folder}). ` +
      'Updates from the marketplace would overwrite edits there, so make the change as my own copy in my mods folder: '
    )
  }
  return `Change my ${mod.name} mod (its folder is ${mod.folder}): `
}

export const NEW_MOD_REQUEST = 'Design and make me a new mod: '

export function fillText(tool: Tool): string {
  return `/${tool.command} `
}
