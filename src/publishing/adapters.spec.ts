import {FacebookAdapter} from './adapters';
import {SocialAccount} from '@prisma/client';
import * as graph from '../social/meta-graph';
import {validateForPlatform} from '../social/platforms';

describe('Facebook multi-image publishing', () => {
  const account = {platformAccountId: 'page'} as SocialAccount;
  afterEach(() => jest.restoreAllMocks());
  it('uploads every photo unpublished and attaches them in order to one feed post', async () => {
    const request = jest.spyOn(graph, 'graphRequest').mockResolvedValueOnce({id: 'photo-a'}).mockResolvedValueOnce({id: 'photo-b'}).mockResolvedValueOnce({id: 'page_post'});
    const result = await new FacebookAdapter().publish(account, 'token', {text: 'Menu', media: [{url: 'a', mimeType: 'image/jpeg'}, {url: 'b', mimeType: 'image/jpeg'}]});
    expect(request.mock.calls.slice(0, 2).map(call => call[3])).toEqual([
      {url: 'a', published: 'false', temporary: 'true'}, {url: 'b', published: 'false', temporary: 'true'},
    ]);
    expect(request).toHaveBeenLastCalledWith('POST', '/page/feed', 'token', {message: 'Menu', attached_media: '[{"media_fbid":"photo-a"},{"media_fbid":"photo-b"}]'});
    expect(result.remotePostId).toBe('page_post');
  });
  it('does not publish a partial album after an upload fails', async () => {
    const request = jest.spyOn(graph, 'graphRequest').mockResolvedValueOnce({id: 'photo-a'}).mockRejectedValueOnce(new Error('upload failed'));
    await expect(new FacebookAdapter().publish(account, 'token', {text: 'Menu', media: [{url: 'a', mimeType: 'image/jpeg'}, {url: 'b', mimeType: 'image/jpeg'}]})).rejects.toThrow('upload failed');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['FACEBOOK', 'INSTAGRAM'] as const)('blocks mixed images and video for %s before scheduling', platform => {
    expect(validateForPlatform(platform, 'Menu', [{mimeType: 'image/jpeg', size: 10, width: 1080, height: 1080}, {mimeType: 'video/mp4', size: 10, width: null, height: null}])).toContainEqual(expect.stringMatching(/one video on its own/));
  });
});
