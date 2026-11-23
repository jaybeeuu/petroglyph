/**
 * Where the adapter writes one line, at one level.
 *
 * The level is a decision the call site makes, not something the sink infers:
 * INFO reports progress, WARN reports an outcome an operator should count but
 * must not page on, and ERROR reports a failure or a data-integrity fault — a
 * Graph or token failure, a land failure, a vault row that cannot be read, a
 * change whose eTag is missing, bytes that match no known type. A healthy run
 * therefore emits no ERROR line, so an alarm or a metric filter on ERROR means
 * something broke. Without a level a deferred walk and a failed walk are
 * indistinguishable to anything reading the log stream.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The default sink. Node writes `warn` and `error` to stderr, so a metric
 * filter separates a deferred walk from a failed one without parsing the text.
 */
export const consoleLogger: Logger = {
  info(message) {
    console.info(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};
