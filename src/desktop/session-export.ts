import { open, unlink } from 'node:fs/promises';

export async function writePrivateExportFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.close();
    closed = true;
  } catch (error) {
    let failure = error;
    if (!closed) {
      try {
        await handle.close();
      } catch (closeError) {
        failure = new AggregateError([error, closeError], 'The conversation export file could not be closed safely.');
      }
    }
    try {
      await unlink(path);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'The incomplete conversation export could not be removed.');
    }
    throw failure;
  }
}

export async function exportToSelectedFile(
  contents: string,
  chooseDestination: () => Promise<string | undefined>,
): Promise<'cancelled' | 'exported'> {
  const destination = await chooseDestination();
  if (!destination) return 'cancelled';
  await writePrivateExportFile(destination, contents);
  return 'exported';
}
