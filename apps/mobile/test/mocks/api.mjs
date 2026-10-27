// The Embodha API as the store module sees it. A test's `server` answers; { error } becomes an ApiError.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api(path, options = {}) {
  const m = globalThis.__store;
  m.calls.push(['api', path, options.body ?? null]);
  const answer = await m.server(path, options.body);
  if (answer?.error) throw new ApiError(answer.error.status, answer.error.code, answer.error.message);
  return answer;
}
