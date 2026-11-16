/**
 * Normalises model output before it is published in an Agent Chat message.
 *
 * This existed twice, once in the service and once in the projection, and both
 * copies replaced every control character with a space. A line feed is a control
 * character, so a structured Markdown answer — headings, lists, fenced code —
 * arrived at every client as a single paragraph. That is data loss in the
 * projection, not a presentation choice: the message is the Runtime's published
 * record and it should preserve the shape the model produced.
 *
 * Line feeds are therefore kept (and normalised to `\n`); everything else in the
 * control range is still removed, because it has no legitimate place in a
 * published message and can be used to smuggle terminal escape sequences.
 */
export function boundedOutput(value: string | null): string {
  const text = (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, 12_000) : '模型未返回内容。';
}
