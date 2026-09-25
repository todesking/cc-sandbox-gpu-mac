/** cc-gpu-run cannot guarantee a sandbox at least as strict as Claude Code's, so it runs nothing. */
export class RefuseError extends Error {
  override name = 'RefuseError';
}
