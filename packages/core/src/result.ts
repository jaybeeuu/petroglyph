export type Success<Value> = { ok: true; value: Value };
export type Failure<Reason> = { ok: false; failure: Reason };
export type Result<Value, Reason> = Success<Value> | Failure<Reason>;

export const ok = <Value>(value: Value): Success<Value> => ({ ok: true, value });
export const fail = <Reason>(reason: Reason): Failure<Reason> => ({ ok: false, failure: reason });

export const isOk = <Value, Reason>(result: Result<Value, Reason>): result is Success<Value> =>
  result.ok;
export const isFail = <Value, Reason>(result: Result<Value, Reason>): result is Failure<Reason> =>
  !result.ok;
