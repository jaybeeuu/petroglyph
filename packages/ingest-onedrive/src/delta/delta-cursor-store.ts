/**
 * One profile's read position in the Graph delta: the change token its walk
 * resumes from. A cursor is the position of the walk that advanced it, so it
 * belongs to the profile that walked — one row per profileId, never shared
 * across a connection (decision 8, `.agent-cortex/designs/profile-flows`).
 */
export interface DeltaCursor {
  /** Opaque — the delta URL verbatim; never re-encoded, never re-appended. */
  deltaLink: string;
  updatedAt: string;
}

/**
 * Change-token storage per PROFILE. The walk reads one row and writes it back
 * when it reaches a terminal deltaLink; walk serialization per profile makes
 * CAS unnecessary here (petroglyph-n20i.10 makes the commit conditional).
 */
export interface DeltaCursorStore {
  read(profileId: string): Promise<DeltaCursor | null>;
  write(profileId: string, cursor: DeltaCursor): Promise<void>;
  clear(profileId: string): Promise<void>;
}
