import type express from 'express';
import { DeferredDirectory } from '../infrastructure/core/directory.js';

export const read = async <Reader>(
  reader: Reader,
  run: (reader: Reader) => Promise<unknown>,
  res: express.Response,
) => {
  res.setHeader('Cache-Control', 'no-store');
  return await run(reader);
};
// A deferred list answers only after Core authorized the request; a Core refusal (401/403/503) outranks a local error.
export const authorizedRead = async (res: express.Response, compute: () => Promise<unknown>) => {
  const directory = res.locals.directory,
    settle = () => (directory instanceof DeferredDirectory ? directory.settle() : undefined);
  let body: unknown;
  try {
    body = await compute();
  } catch (error) {
    await settle();
    throw error;
  }
  await settle();
  res.json(body);
};
export const sendMutation = (res: express.Response, response: unknown, status = 200) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(response);
};
