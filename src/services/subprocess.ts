export interface DownloadProcess {
  stdout: { readString: () => Promise<string> };
  stderr?: DownloadProcess["stdout"];
  wait: () => Promise<{ exitCode: number }>;
  kill: (timeout: number) => Promise<unknown>;
}

export interface DownloadSubprocess {
  pathSearch: (name: string) => Promise<string>;
  call: (options: {
    command: string;
    arguments: string[];
    stderr: string;
    environmentAppend?: boolean;
    environment?: Record<string, string>;
  }) => Promise<DownloadProcess>;
}

/**
 * Read a subprocess pipe to EOF so its output cannot block the child.
 *
 * Args:
 *   pipe: Native process output pipe.
 *   collect: Retain output for curl diagnostics; discard browser output.
 * Returns:
 *   Collected output, or an empty string when discarding it.
 */
export async function readOutput(
  pipe: DownloadProcess["stdout"],
  collect = true,
): Promise<string> {
  let output = "";
  let chunk: string;
  while ((chunk = await pipe.readString())) {
    if (collect) output += chunk;
  }
  return output;
}
