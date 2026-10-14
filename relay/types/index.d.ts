/** One saved handoff, as kept in the store under `relay.handoffs` (newest first). */
export type RelayHandoff = {
  id: string
  projectKey: string
  root: string
  title: string
  path: string
  createdAt: number
  consumedAt?: number
}

/**
 * The live context window's figures, as `session.measure` / `$.session.usage()`
 * report them: `tokens` and `percent` (of the model's full `window`) are absent
 * before the first response of the live window.
 */
export type RelayContext = {
  tokens?: number
  percent?: number
  window?: number
}

/** The handoff open in the preview pane (`relay-handoff`), until Clear & continue, Cancel or a new one. */
export type RelayDraft = {
  /** The index record's id. */
  id: string
  /** The project the handoff was written in. */
  projectKey: string
  title: string
  text: string
  /** Where the file was saved; '' when the write failed. */
  path: string
  /** A prompt the cold guard held, to append below the handoff after the clear. */
  heldText?: string
}

/** The cold-cache confirmation shown on the row before a handoff re-reads a cold cache. */
export type RelayColdConfirm = {
  tokens: number
  /** The estimated cache re-write cost; absent for an unknown model. */
  usd?: number
  heldText?: string
}

/** The unconsumed handoff offered on the band at startup or after /clear. */
export type RelayOffer = {
  id: string
  title: string
  path: string
  createdAt: number
}

/** The store's `relay.fillAfterClear`: what to put in the prompt box once /clear has run. */
export type RelayFillMarker = {
  text: string
  /** The project the Clear & continue was pressed in; a session in another project leaves the marker alone. */
  projectKey?: string
  /** The saved file, named in toasts when the box or the clipboard failed. */
  path?: string
  /** Whether the text reached the clipboard. */
  isCopied?: boolean
  heldText?: string
  /** When Clear & continue was pressed (`$.clock.now()` ms); ignored after 10 minutes. */
  at: number
  /** Set when the prompt was already filled after `$.command.run` resolved, so SessionStart does not fill twice. */
  filledAt?: number
}

/** What one warming ping cost: the cache it read, the cache it wrote, and the $ when the model's price is known. */
export type RelayPingReceipt = {
  /** When the ping answered (`$.clock.now()` ms). */
  at: number
  read: number
  write: number
  usd?: number
}

/**
 * This session's cache warming, mirrored in the store under `relay.warming.<session id>`
 * so a hot reload (which drops the module's timer) can pick it up again.
 */
export type RelayWarming = {
  /** When the warming window ends; null when no window is armed. */
  windowEnd: number | null
  /** When the next ping is due; absent while waiting for a reply (or once the window has no room for one). */
  nextPingAt?: number
  /** `/keepwarm off` for this session: replies no longer arm a window until `/keepwarm <duration>`. */
  off: boolean
  /** When `/keepwarm off` was typed; the store keeps an off flag 3 days. */
  offAt?: number
  /** Why warming last stopped, shown on the row until the next reply. */
  stopped?: string
  /** The last ping's receipt. */
  last?: RelayPingReceipt
  /** When the last main-thread reply landed (pings excluded): a handoff saved after it is still current. */
  lastTurnAt?: number
}

/** A typed prompt the cold-cache guard held, shown on the row with Handoff & start fresh / Send anyway. */
export type RelayColdGuard = {
  heldText: string
  tokens: number
  /** The estimated cache re-write cost; absent for an unknown model. */
  usd?: number
  /** When the cache went cold (`lastResponseAt` + one hour). */
  coldSince: number
}

/** A resumed session's own cost estimate (`estimated_cache_write_usd`), good while the cache clock is the resumed one. */
export type RelayResumeEstimate = {
  /** The `lastResponseAt` the resume set. */
  at: number
  usd: number
}

declare module 'claude-code' {
  interface PluginState {
    relay: {
      /** Cache warming for this session; null before anything armed it. */
      warming: RelayWarming | null
      /** The prompt the cold guard holds; null when none. */
      coldGuard: RelayColdGuard | null
      /** The cold episode (its `lastResponseAt`) the guard already held a prompt in: the next send goes through. */
      guardEpisode: number | null
      /** The resume's cache-write estimate; null when not resumed (or the clock has moved on). */
      resumeEstimate: RelayResumeEstimate | null
      /** When the running main-thread turn started (`turn.start`); null when none runs. */
      turnRunning: number | null
      /** Mirrors the store's `relay.settings.enabled` (default true). */
      enabled: boolean
      /** "Not yet" was pressed this session: offer again from 90% / 400k. */
      handoffSnoozed: boolean
      /** When the main thread last answered (`$.clock.now()` ms); null = cache state unknown. */
      lastResponseAt: number | null
      /** Latest context figures; null before any reading and after /clear or compaction. */
      context: RelayContext | null
      /** Bumped every 30s (while on and a reply was seen) so the row's "left" time redraws. */
      tick: number
      /** True while a handoff is being written (the fork is running). */
      handoffBusy: boolean
      /** The handoff the preview pane shows; null when none is open. */
      handoffDraft: RelayDraft | null
      /** The cold-cache confirmation on the row; null when not asked. */
      coldConfirm: RelayColdConfirm | null
      /** The waiting handoff offered on the band; null when none. */
      offer: RelayOffer | null
    }
  }
}
