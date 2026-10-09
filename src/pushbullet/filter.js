/**
 * "Is this push a puzzle image for us?"
 *
 * Kept a pure function of the push object so it is trivially testable and so the
 * listener never has to know what makes a candidate. Classification returns a
 * reason as well as a verdict: the reason is what the push row's `ignored` status
 * and the logs record, and "why was this image not answered?" is otherwise the
 * hardest question to answer after the fact.
 */
import { extname } from 'node:path';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

export const MIME_TO_EXTENSION = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
};

function hasImageExtension(fileName) {
  if (!fileName) return false;
  return IMAGE_EXTENSIONS.has(extname(String(fileName)).toLowerCase());
}

/**
 * @returns {{accepted: boolean, reason: string, kind?: 'mime'|'extension'}}
 */
export function classifyPush(
  push,
  { allowedSenders = [], allowedChannels = [], ignoreOutgoing = true, ignoredIdens = [] } = {}
) {
  if (!push || typeof push !== 'object') return { accepted: false, reason: 'not-a-push' };
  if (!push.iden) return { accepted: false, reason: 'no-iden' };
  if (push.active === false) return { accepted: false, reason: 'inactive' };
  if (ignoredIdens.includes(push.iden)) return { accepted: false, reason: 'ignored-iden' };
  if (push.type !== 'file') return { accepted: false, reason: `type=${push.type ?? 'unknown'}` };

  // A push created through the API (which is how our own replies are created)
  // is outgoing. Direction is relative to this account, so a file pushed from
  // one of the account's own devices is `self` and stays a candidate.
  if (ignoreOutgoing && push.direction === 'outgoing') return { accepted: false, reason: 'own-push' };

  if (allowedSenders.length) {
    const sender = push.sender_iden ?? push.sender_email ?? push.source_device_iden;
    if (!allowedSenders.includes(sender)) return { accepted: false, reason: 'sender-not-allowed' };
  }
  if (allowedChannels.length && !allowedChannels.includes(push.channel_iden)) {
    return { accepted: false, reason: 'channel-not-allowed' };
  }

  const mime = String(push.file_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return { accepted: true, reason: 'image-mime', kind: 'mime' };

  // Some clients omit file_type; the extension is a weaker signal but the fetcher
  // re-checks the magic bytes and decodability before anything is solved, so a
  // wrong guess here costs a download, not a wrong answer.
  if (hasImageExtension(push.file_name)) return { accepted: true, reason: 'image-extension', kind: 'extension' };

  return { accepted: false, reason: `not-an-image:${mime || 'unknown'}` };
}

export function isCandidatePush(push, options) {
  return classifyPush(push, options).accepted;
}
