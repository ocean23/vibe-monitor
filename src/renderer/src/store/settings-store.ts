import { create } from 'zustand'

export interface AppSettings {
  /** 「跳回终端」唤起的终端 app 名称（macOS）。默认 Ghostty；其他常见值 iTerm / Terminal / Alacritty / Warp。 */
  terminalApp: string
  /** 灵动岛（Notch Island）总开关。 */
  islandEnabled: boolean
  /** 灵动岛状态切换 8-bit 音效开关。 */
  islandSoundEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminalApp: 'Ghostty',
  islandEnabled: true,
  islandSoundEnabled: true
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  hydrate: () => Promise<void>
  save: (patch: Partial<AppSettings>) => Promise<void>
  /** 合并主进程（托盘）推送的外部设置变更，不回写（避免回环）。 */
  applyExternal: (patch: Partial<AppSettings>) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  hydrate: async () => {
    if (get().loaded) return
    const api = window.electronAPI
    if (!api?.loadSettings) {
      set({ loaded: true })
      return
    }
    try {
      const stored = await api.loadSettings()
      set({
        settings: { ...DEFAULT_SETTINGS, ...(stored ?? {}) },
        loaded: true
      })
    } catch (err) {
      console.error('[settings] hydrate failed', err)
      set({ loaded: true })
    }
  },
  save: async (patch) => {
    const api = window.electronAPI
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    if (api?.saveSettings) {
      try {
        const persisted = await api.saveSettings(patch)
        set({ settings: { ...get().settings, ...persisted } })
      } catch (err) {
        console.error('[settings] save failed', err)
      }
    }
  },
  applyExternal: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } }))
}))
