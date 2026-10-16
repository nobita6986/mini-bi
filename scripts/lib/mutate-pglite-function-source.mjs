export async function replaceFunctionSourceForMutationProbe(db, signature, expected, replacement) {
  const { rows: sourceRows } = await db.query(
    "select p.prosrc from pg_proc p where p.oid=$1::regprocedure",
    [signature],
  );
  const source = sourceRows[0]?.prosrc;
  if (typeof source !== "string" || expected === "" ||
      source.split(expected).length - 1 !== 1) {
    throw new Error(`mutation probe source fragment mismatch: ${signature}`);
  }
  const { rows: definitionRows } = await db.query(
    "select pg_get_functiondef($1::regprocedure) as definition",
    [signature],
  );
  const definition = definitionRows[0]?.definition;
  if (typeof definition !== "string" || definition.split(source).length - 1 !== 1) {
    throw new Error(`mutation probe function reconstruction failed: ${signature}`);
  }
  await db.exec(definition.replace(source, source.replace(expected, replacement)));
}
