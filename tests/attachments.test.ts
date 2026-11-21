import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  fitAttachments,
  parseAttachments,
  parseImageAttachment,
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
