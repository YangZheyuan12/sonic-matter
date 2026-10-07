import type { Story, Track } from '../project/model'

export type Page = 'explore' | 'concept' | 'studio' | 'sound' | 'settings'

export type ConceptId = 'physical' | 'psychological' | 'climate'

export type Concept = {
  title: string
  summary: string
  story: Story[]
  thesis?: string
  musicMapping?: {
    tempo: number
    key: string
    density: number
    brightness: number
    tension: number
    instruments: string[]
  }
}

export type AgentOperation =
  | { op: 'add_track'; track: Track }
  | { op: 'update_project'; path: 'title' | 'tempo' | 'key'; value: string | number }
  | { op: 'update_track'; track_id: string; path: 'name' | 'instrument' | 'color'; value: string }

export type AgentMode = 'local' | 'agent' | 'fallback'
export type AgentProtocol = 'responses' | 'chat-completions'

export type ApiConfig = {
  baseUrl: string
  apiKey: string
  model: string
  protocol: AgentProtocol
  musicBaseUrl: string
  musicApiKey: string
  musicModel: string
  sfxBaseUrl: string
  sfxApiKey: string
  sfxModel: string
  musicMode: 'structured' | 'audio'
  rememberKey: boolean
}

export type SoundPlan = {
  title: string
  prompt: string
  duration_seconds: number
  texture: string
  envelope: string
  space: string
  events: Array<{ time: number; event: string }>
}

export type GeneratedAudio = {
  filename: string
  url: string
  provider: string
  model?: string
  source: 'audio-model'
}

export type ThemeChoice = 'dark' | 'light' | 'system'
export type FontChoice = 'sans' | 'serif' | 'mono'

export type Preferences = {
  theme: ThemeChoice
  font: FontChoice
  fontSize: 'compact' | 'default' | 'large'
  reducedMotion: boolean
}
