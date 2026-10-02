import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

type OperationResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable" };

export type DirectEntryRepository = {
  createBatch(input: ActorRef & {
    rows: readonly Record<string, unknown>[];
    idempotency_key: string;
  }): Promise<OperationResult>;
  readEntry(input: ActorRef & { entry_id: string }): Promise<OperationResult>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string; message?: string }, operation: "write" | "read") {
  if (operation === "write") {
    if (error.code === "23505") return "conflict";
    if (error.code === "42501") return "denied";
    if (error.code === "22023") {
      return error.message === "idempotency key reused with different input"
        ? "conflict"
        : "invalid";
    }
  } else {
    if (error.code === "P0002") return "not-found";
    if (error.code === "42501") return "denied";
  }
  return "unavailable";
}

export function createDirectEntryWriteRepository(rpc?: Rpc): DirectEntryRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async createBatch(input) {
      try {
        const { data, error } = await callRpc("direct_entry_create_batch", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_rows: input.rows,
          p_idempotency_key: input.idempotency_key,
        });
        return error ? { ok: false, kind: classify(error, "write") } : { ok: true, data };
      } catch {
        console.error("[direct-entry] create batch RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async readEntry(input) {
      try {
        const { data, error } = await callRpc("direct_entry_read_projection", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
        });
        return error ? { ok: false, kind: classify(error, "read") } : { ok: true, data };
      } catch {
        console.error("[direct-entry] read projection RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
