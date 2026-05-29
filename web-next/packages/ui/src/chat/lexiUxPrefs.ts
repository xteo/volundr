// lexi/ux-update: compact-chat preferences.
//
// Defaults make this branch's chat view compact (action icons + agent avatar
// hidden, timestamp on hover). Each can be flipped back on at runtime via
// localStorage keys `niuu.lexiUx.<key>` (no rebuild needed). A real settings
// surface can be layered on later — these read from the same keys.
export interface LexiUxChatPrefs {
  /** thumbs-up/down, regenerate, bookmark, copy row under each message */
  showMessageActions: boolean;
  /** the Hamr/Völundr avatar shown beside assistant messages */
  showAgentAvatar: boolean;
  /** message timestamp: hover-revealed (right), always shown, or never */
  timestamp: 'hover' | 'always' | 'never';
  /** copy affordance: a hover control near the message, or the inline row */
  copyMode: 'hover' | 'inline';
}

const DEFAULTS: LexiUxChatPrefs = {
  showMessageActions: false,
  showAgentAvatar: false,
  timestamp: 'hover',
  copyMode: 'hover',
};

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(`niuu.lexiUx.${key}`);
    return v === null ? fallback : v === '1' || v === 'true';
  } catch {
    return fallback;
  }
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(`niuu.lexiUx.${key}`) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getLexiUxChatPrefs(): LexiUxChatPrefs {
  return {
    showMessageActions: readBool('showMessageActions', DEFAULTS.showMessageActions),
    showAgentAvatar: readBool('showAgentAvatar', DEFAULTS.showAgentAvatar),
    timestamp: readEnum('timestamp', ['hover', 'always', 'never'] as const, DEFAULTS.timestamp),
    copyMode: readEnum('copyMode', ['hover', 'inline'] as const, DEFAULTS.copyMode),
  };
}
