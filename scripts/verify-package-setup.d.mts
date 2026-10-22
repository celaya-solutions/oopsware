/** Validate a live registration and its byte-identical pre-setup backup. */
export function assertClientConfig(
  cli: string,
  configPath: string,
  original: Uint8Array,
): Promise<void>;

/** Return true only when stty output positively reports canonical input and echo. */
export function terminalModesRestored(termios: unknown): boolean;
