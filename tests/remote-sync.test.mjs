import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemoteAccess,
  readRemoteAccess,
  remoteLinks,
} from '../lib/remote-sync.ts';

test('remote links keep credentials in the fragment and separate editor and audience access', () => {
  const access = createRemoteAccess();
  const links = remoteLinks('https://na-gasena.github.io/suiko/', access);
  const editor = new URL(links.editor);
  const audience = new URL(links.audience);

  assert.equal(editor.searchParams.get('room'), access.roomId);
  assert.equal(editor.searchParams.has('view'), false);
  assert.equal(editor.searchParams.has('editor'), false);
  assert.equal(
    new URLSearchParams(editor.hash.slice(1)).get('editor'),
    access.token,
  );

  assert.equal(audience.searchParams.get('view'), 'audience');
  assert.equal(audience.searchParams.has('audience'), false);
  assert.equal(
    new URLSearchParams(audience.hash.slice(1)).get('audience'),
    access.audienceToken,
  );
  assert.equal(
    new URLSearchParams(audience.hash.slice(1)).has('editor'),
    false,
  );

  assert.deepEqual(readRemoteAccess(editor), access);
  assert.deepEqual(readRemoteAccess(audience), {
    roomId: access.roomId,
    role: 'audience',
    token: access.audienceToken,
  });
});

test('room identifiers are validated before a remote connection is allowed', () => {
  assert.equal(
    readRemoteAccess(new URL('https://example.test/?room=short#editor=secret')),
    null,
  );
});
