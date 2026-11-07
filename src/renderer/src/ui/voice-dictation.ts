/** Add a dictated phrase to the editable message text. */
export function appendVoiceDraft(base: string, transcript: string): string {
  return `${base}${base && transcript ? ' ' : ''}${transcript}`;
}
