// @ts-check
import { isRecord } from './contracts.mjs';
/** Parse a bounded request body without echoing caller data in syntax errors.
 * @param {string} text @returns {Record<string,unknown>} */
export function parseRequestObject(text) {
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new Error('Request body must contain valid JSON.');
  }
  if (!isRecord(body))
    throw new Error('Request body must be a JSON object.');
  return body;
}
