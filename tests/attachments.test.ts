import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TEXT_BYTES_PER_MESSAGE,
  fitAttachments,
  parseAttachment,
  parseAttachments,
  parseImageAttachment,
  parseTextAttachment,
} from '../src/runtime/attachments.js';

const png = (bytes: number) => `data:image/png;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;

test('a valid image data URL is accepted with its decoded size', () => {
  const attachment = parseImageAttachment({ kind: 'image', dataUrl: png(300) });
  assert.equal(attachment.mediaType, 'image/png');
  assert.ok(attachment.bytes >= 300);
});

test('a path or a remote URL is refused, not forwarded', () => {
  // A path would let a message name any host file; a URL would make the
  // provider fetch an arbitrary address.
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: '/etc/passwd' }), /data URL/);
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: 'https://example.com/a.png' }), /data URL/);
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: 'data:text/plain;base64,AAAA' }), /data URL/);
});

test('unsupported types, empty payloads, and oversized images are refused', () => {
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: 'data:image/svg+xml;base64,AAAA' }), /data URL/);
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: 'data:image/png;base64,' }), /data URL/);
  const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 3) / 3) * 4)}`;
  assert.throws(() => parseImageAttachment({ kind: 'image', dataUrl: oversized }), /limit/);
});

test('unknown fields are refused so a client cannot smuggle a path', () => {
  assert.throws(
    () => parseImageAttachment({ kind: 'image', dataUrl: png(3), path: '/etc/passwd' }),
    /unknown fields/i,
  );
  assert.throws(() => parseImageAttachment({ kind: 'file', dataUrl: png(3) }), /Only image/);
});

test('a message carries a bounded number of attachments', () => {
  assert.equal(parseAttachments(undefined).length, 0);
  const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () =>
    ({ kind: 'image', dataUrl: png(3) }));
  assert.throws(() => parseAttachments(many), /At most/);
});

test('the oldest attachments are dropped first when a budget is exceeded', () => {
  const first = parseImageAttachment({ kind: 'image', dataUrl: png(3_000) });
  const second = parseImageAttachment({ kind: 'image', dataUrl: png(3_000) });
  const result = fitAttachments([first, second], 4_000);
  assert.equal(result.dropped, 1);
  assert.equal(result.kept[0], second, 'the most recent image is the one kept');
  assert.ok(result.bytes <= 4_000);
});

test('a text attachment is accepted with its byte size', () => {
  const attachment = parseTextAttachment({
    kind: 'text',
    name: 'error.log',
    mediaType: 'text/plain',
    text: 'TypeError: x is not a function\n  at main.js:12',
  });
  assert.equal(attachment.kind, 'text');
  assert.equal(attachment.name, 'error.log');
  assert.equal(attachment.truncated, false);
  assert.ok(attachment.bytes > 0);
});

test('text attachments must be real text, not mislabelled binary', () => {
  // A NUL means this is a binary file wearing a text label. Repairing it would
  // send the model something the user did not attach.
  assert.throws(
    () => parseTextAttachment({ kind: 'text', name: 'a.bin', mediaType: 'text/plain', text: 'a\u0000b' }),
    /NUL/,
  );
  assert.throws(
    () => parseTextAttachment({ kind: 'text', name: 'a.pdf', mediaType: 'application/pdf', text: 'x' }),
    /mediaType/,
  );
  assert.throws(
    () => parseTextAttachment({ kind: 'text', name: '', mediaType: 'text/plain', text: 'x' }),
    /name/,
  );
  assert.throws(
    () => parseTextAttachment({ kind: 'text', name: 'a', mediaType: 'text/plain', text: 'x', path: '/etc' }),
    /unknown fields/i,
  );
});

test('text attachments are bounded per file and in total', () => {
  const tooBig = 'x'.repeat(MAX_TEXT_ATTACHMENT_BYTES + 1);
  assert.throws(
    () => parseTextAttachment({ kind: 'text', name: 'big.log', mediaType: 'text/plain', text: tooBig }),
    /limit/,
  );
  /*
   * Each file is under the per-file limit but the pair exceeds the per-message
   * total, so this exercises the aggregate check and not the individual one.
   */
  /*
   * Three files, each under the per-file limit, summing past the total. Two
   * files cannot do it: the per-file limit is deliberately below half the total
   * so the aggregate check is reachable at all.
   */
  const each = Math.min(MAX_TEXT_ATTACHMENT_BYTES, Math.ceil(MAX_TEXT_BYTES_PER_MESSAGE / 3) + 1);
  assert.ok(each <= MAX_TEXT_ATTACHMENT_BYTES, 'each file must still be individually legal');
  const chunk = 'x'.repeat(each);
  assert.throws(
    () => parseAttachments([
      { kind: 'text', name: 'a.log', mediaType: 'text/plain', text: chunk },
      { kind: 'text', name: 'b.log', mediaType: 'text/plain', text: chunk },
      { kind: 'text', name: 'c.log', mediaType: 'text/plain', text: chunk },
    ]),
    /total/,
  );
});

test('images and text can be attached to one message', () => {
  const attachments = parseAttachments([
    { kind: 'image', dataUrl: png(300) },
    { kind: 'text', name: 'notes.md', mediaType: 'text/markdown', text: '# hi' },
  ]);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0]?.kind, 'image');
  assert.equal(attachments[1]?.kind, 'text');
});

test('an unknown attachment kind is refused rather than guessed', () => {
  assert.throws(() => parseAttachment({ kind: 'audio', dataUrl: png(3) }), /image or text/);
  assert.throws(() => parseAttachment({ kind: 'file', text: 'x' }), /image or text/);
});
