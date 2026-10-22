import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverUrl, trimTrailingSlashes } from '../src/urls.js';

test('server URLs keep a base path, with or without slashes', () => {
  for (const base of ['http://nas:8096/jf', 'http://nas:8096/jf/', 'http://nas:8096/jf//']) {
    assert.equal(serverUrl(base, '/Users').href, 'http://nas:8096/jf/Users');
    assert.equal(serverUrl(base, 'Users?a=1&b=2').href, 'http://nas:8096/jf/Users?a=1&b=2');
  }
  assert.equal(serverUrl('http://plex:32400', '//library/sections').href, 'http://plex:32400/library/sections');
});

test('an absolute path can’t leave the server', () => {
  assert.equal(serverUrl('http://plex:32400', '//evil.example/x').origin, 'http://plex:32400');
  // A full URL does resolve elsewhere, so artwork paths check the origin themselves.
  assert.equal(serverUrl('http://plex:32400', 'http://evil.example/x').origin, 'http://evil.example');
});

test('trailing slashes are trimmed', () => {
  assert.equal(trimTrailingSlashes('https://marquee.example.com///'), 'https://marquee.example.com');
  assert.equal(trimTrailingSlashes('https://marquee.example.com'), 'https://marquee.example.com');
});
