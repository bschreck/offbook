/** Pages Functions bindings. `_`-prefixed directories are not routed. */
export interface Env {
  DB: D1Database;
}

export type Ctx = EventContext<Env, string, unknown>;

/** A signed-in user, as resolved from the session cookie. */
export interface AuthedUser {
  id: string;
  username: string;
  usernameDisplay: string;
  usageBytes: number;
  rev: number;
}
