/**
 * A SQL executor over Supabase's Management API, for scripts that run where
 * no direct Postgres connection is possible (e.g. a cloud session that can
 * reach Supabase only over HTTPS).
 *
 * The token comes from SUPABASE_ACCESS_TOKEN (an environment secret, never
 * a command-line argument) and is never printed. The project must have
 * exactly the expected name and be healthy: a personal access token reaches
 * every project on the account, so a mistyped ref must not hit another one.
 *
 * No `server-only` import: runs from a script.
 */
import type { Executor } from "./hosted-migrations";

/** The request was sent but no answer came back: the outcome is unknown. */
export class UncertainOutcome extends Error {}

export async function managementApiExecutor(options: {
  ref: string;
  expectedName: string;
  token?: string;
}): Promise<Executor> {
  const token = options.token ?? process.env.SUPABASE_ACCESS_TOKEN ?? "";
  if (!token)
    throw new Error("Set SUPABASE_ACCESS_TOKEN as an environment secret.");
  if (!/^[a-z]{20}$/.test(options.ref))
    throw new Error("Pass --project <20-letter project ref>.");
  if (!options.expectedName)
    throw new Error("Pass --name <project name> to confirm the target.");

  const api = `https://api.supabase.com/v1/projects/${options.ref}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const project = await fetch(api, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!project.ok)
    throw new Error(
      `Can't read project ${options.ref}: HTTP ${project.status}.`,
    );
  const info = (await project.json()) as { name?: string; status?: string };
  if (info.name !== options.expectedName)
    throw new Error(
      `Refusing: project ${options.ref} is named "${info.name}", not "${options.expectedName}".`,
    );
  if (info.status !== "ACTIVE_HEALTHY")
    throw new Error(`Refusing: project status is ${info.status}.`);

  return async (query) => {
    let res: Response;
    try {
      res = await fetch(`${api}/database/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new UncertainOutcome(
        `no response (${(error as Error).name}): outcome unknown`,
      );
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body) as Record<string, unknown>[];
  };
}
