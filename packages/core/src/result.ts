export type Ok<Value> = { ok: true; value: Value };
export type Fail<Failure> = { ok: false; failure: Failure };
export type Result<Value, Failure> = Ok<Value> | Fail<Failure>;

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const fail = <Failure>(failure: Failure): Result<never, Failure> => ({ ok: false, failure });

export const isOk = <Value, Failure>(result: Result<Value, Failure>): result is Ok<Value> =>
  result.ok;
export const isFail = <Value, Failure>(result: Result<Value, Failure>): result is Fail<Failure> =>
  !result.ok;
