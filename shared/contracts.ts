// Types shared by the Electron main process, the preload bridge and the renderer.
// Type-only: every runtime imports this file with `import type`.

export interface MeetStatus {
  prepared: boolean;
  connected: boolean;
  eligible: number;
  sessionId: string | null;
  muted: boolean;
  ready: boolean;
  error: string;
  extensionPath: string;
}

export interface PreparedMeetStatus extends MeetStatus {
  extensionId: string;
}

export type MeetPlayResult =
  | { sent: true }
  | { sent: false; reason: 'stopped' | 'stale' | 'connection' | 'unavailable' | 'busy' };

export interface MeetPlayPayload {
  slot: number;
  id: string;
  bytes: ArrayBuffer;
  decodedBytes: number;
  createdAt: number;
  sessionId: string | null;
}

export interface MacVolume {
  volume: number;
  muted: boolean;
}

export interface ShortcutStatus {
  shortcut: string;
  registered: boolean;
}

/** The API the preload script exposes to the renderer as `window.soundboard`. */
export interface SoundboardApi {
  getVolume(): Promise<MacVolume>;
  setVolume(value: number): Promise<MacVolume>;
  hide(): void;
  getShortcut(): Promise<ShortcutStatus>;
  meetStatus(): Promise<MeetStatus>;
  prepareMeet(): Promise<PreparedMeetStatus>;
  showMeetFolder(): Promise<void>;
  playMeet(payload: MeetPlayPayload): Promise<MeetPlayResult>;
  stopMeet(): Promise<{ stopped: true }>;
  onMeetStatus(callback: (status: MeetStatus) => void): () => void;
}
