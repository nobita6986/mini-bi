/**
 * Bind files selected on staged worker rows to server-issued entry IDs after a
 * successful partial batch. The caller passes only rows actually included in
 * the request; array length/order must match the server response exactly.
 */
export type InitialWorkerUploadFiles = {
  cccdFront: File | null;
  cccdBack: File | null;
  contract: File | null;
};

export function hasInitialWorkerUploads(files: InitialWorkerUploadFiles | undefined):
  files is InitialWorkerUploadFiles {
  return files !== undefined &&
    (files.cccdFront !== null || files.cccdBack !== null || files.contract !== null);
}

export function mapSavedWorkerInitialUploads<T>(input: {
  clientRowIds: readonly string[];
  entryIds: readonly string[];
  uploadsByClientRowId: ReadonlyMap<string, T>;
}): Map<string, T> | null {
  if (input.clientRowIds.length < 1 || input.clientRowIds.length !== input.entryIds.length) {
    return null;
  }
  if (new Set(input.clientRowIds).size !== input.clientRowIds.length ||
      new Set(input.entryIds).size !== input.entryIds.length ||
      input.clientRowIds.some((id) => id.length === 0) ||
      input.entryIds.some((id) => id.length === 0)) {
    return null;
  }

  const result = new Map<string, T>();
  for (let index = 0; index < input.clientRowIds.length; index += 1) {
    const clientRowId = input.clientRowIds[index];
    const entryId = input.entryIds[index];
    if (clientRowId === undefined || entryId === undefined) return null;
    const uploads = input.uploadsByClientRowId.get(clientRowId);
    if (uploads !== undefined) result.set(entryId, uploads);
  }
  return result;
}
