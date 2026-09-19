/**
 * The transport seam over the event log. Consuming domain code reads events
 * through this port and never sees the wire shape of whatever carries them —
 * today a DynamoDB stream, later possibly a bus — so changing the transport is
 * an adapter swap rather than a migration.
 */
export interface EventSource<WireRecord> {
  /**
   * The serialized event document a wire record carries, or `undefined` when
   * the record carries no event. Which records carry an event is the adapter's
   * concern — the port only distinguishes a document from nothing to read, so
   * it stays agnostic to the transport's payload shape. The caller owns
   * parsing and validating the returned document.
   */
  readDocument(record: WireRecord): string | undefined;
}
