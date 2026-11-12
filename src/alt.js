// Suggests alt text for an image, using Claude. Needs ANTHROPIC_API_KEY.
// ALT_TEXT_MODEL can choose another Claude model (default: claude-opus-5-5).
import Anthropic from '@anthropic-ai/sdk';
import { ValidationError } from './db.js';

const SYSTEM = `You write alt text for images in social media posts, for people who use screen readers.

Reply with the alt text only: one or two plain sentences, at most 250 characters. Describe what matters in the image for the post. Include any important readable text. Do not start with "Image of" or "Picture of", and do not add hashtags, emojis or quotation marks. Use British English. If you know nothing about who a person is, describe them rather than guessing their name.`;

function toBase64(bytes) {
  const view = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Error with a message that is safe to show to the person using the app. */
export class AltTextError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Returns suggested alt text for one image.
 * image: { bytes: ArrayBuffer, type: 'image/jpeg' | 'image/png' | 'image/gif' }, postText: optional context.
 */
export async function suggestAltText(ctx, image, postText = '') {
  if (!ctx.env.ANTHROPIC_API_KEY) throw new AltTextError('Automatic descriptions are not set up', 503);
  const client = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY, fetch: ctx.fetch, maxRetries: 1, timeout: 60_000 });
  let message;
  try {
    message = await client.beta.messages.create({
      model: ctx.env.ALT_TEXT_MODEL || 'claude-opus-5-5',
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      // If the model declines, let the API retry on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.type, data: toBase64(image.bytes) } },
          { type: 'text', text: postText ? `The post this image goes with says:\n\n${postText.slice(0, 3000)}` : 'Write alt text for this image.' },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new AltTextError('Too many descriptions at once. Try again in a minute.', 429);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('Alt text: the Anthropic API key was rejected');
      throw new AltTextError('Automatic descriptions are not set up correctly');
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Alt text: Anthropic API error ${err.status}: ${err.message}`);
      throw new AltTextError('Could not describe this image just now');
    }
    throw err;
  }
  if (message.stop_reason === 'refusal') throw new AltTextError('Could not describe this image', 422);
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    .replace(/\s+/g, ' ').replace(/^["“']|["”']$/g, '').trim();
  if (!text) throw new AltTextError('Could not describe this image');
  return text.slice(0, 1000);
}

/** Checks an uploaded image for the alt text request. */
export async function readAltTextRequest(request, { types, maxBytes }) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError('Invalid form');
  }
  const file = form.get('image');
  if (!file || typeof file === 'string') throw new ValidationError('No image');
  if (!types.includes(file.type)) throw new ValidationError('Images must be JPEG, PNG or GIF');
  if (file.size > maxBytes) throw new ValidationError('An image is too large');
  return { image: { bytes: await file.arrayBuffer(), type: file.type }, text: String(form.get('text') || '').trim() };
}
