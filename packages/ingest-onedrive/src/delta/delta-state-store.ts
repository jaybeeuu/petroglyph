export interface DeltaState {
  /** Opaque — the delta URL verbatim; never re-encoded, never re-appended. */
  deltaLink: string;
  updatedAt: string;
}

/**
 * Change-token storage per CONNECTION (userId, provider). One row per
 * connection; walk serialization makes CAS unnecessary here.
 */
export interface DeltaStateStore {
  read(userId: string, provider: string): Promise<DeltaState | null>;
  write(userId: string, provider: string, state: DeltaState): Promise<void>;
  clear(userId: string, provider: string): Promise<void>;
}
