/**
 * The transport seam over the event log. Consuming domain code reads events
 * through this port and never sees the wire shape of whatever carries them —
 * today a DynamoDB stream, later possibly a bus — so changing the transport is
 * an adapter swap rather than a migration.
 */
export interface EventSource<WireRecord> {
  /**
   * The serialized CloudEvent document a wire record carries, or `undefined`
   * when the record carries no event (a non-INSERT on the immutable log, or a
   * row without a string `doc`). The caller owns parsing and validation.
   */
  readDocument(record: WireRecord): string | undefined;
}
