import { createHash, createHmac } from 'node:crypto';
import { BusinessError } from './domain/error.js';
import type { BlobStore } from './application/ports/blobs.js';
import { serviceOrigin } from '@nipopeto/runtime';
export type { BlobStore };

// AQ-09 Claim Check + Valet Key. Medical image bytes live in an S3-compatible
// bucket; the database keeps only a claim (key, size, sha256, MIME). Clinic
// checks access, then hands out a short-lived presigned GET URL (the valet key)
// so image bytes never travel through Clinic or the gateway on reads.

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
// RFC 3986 unreserved characters only, as SigV4 requires.
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const stampOf = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

export type BlobConfig = {
  endpoint: string;
  publicEndpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  urlTtlSeconds: number;
};

const origin = (name: string, value: string) => serviceOrigin(value, 'INVALID_' + name).origin;

export class S3BlobStore implements BlobStore {
  private readonly endpoint: URL;
  private readonly publicEndpoint: URL;
  constructor(
    private readonly config: BlobConfig,
    private readonly timeoutMs = 10000,
  ) {
    this.endpoint = new URL(origin('BLOB_ENDPOINT', config.endpoint));
    this.publicEndpoint = new URL(origin('BLOB_PUBLIC_ENDPOINT', config.publicEndpoint));
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('INVALID_BLOB_BUCKET');
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(config.accessKey)) throw new Error('INVALID_BLOB_ACCESS_KEY');
    if (!Number.isInteger(config.urlTtlSeconds) || config.urlTtlSeconds < 30 || config.urlTtlSeconds > 900)
      throw new Error('INVALID_BLOB_URL_TTL_SECONDS');
  }
  private path(key?: string) {
    return '/' + this.config.bucket + (key === undefined ? '' : '/' + key.split('/').map(encode).join('/'));
  }
  private signingKey(date: string) {
    return hmac(hmac(hmac(hmac('AWS4' + this.config.secretKey, date), this.config.region), 's3'), 'aws4_request');
  }
  // Header-signed request (SigV4) against the internal endpoint.
  private async send(
    method: string,
    path: string,
    body: Buffer = Buffer.alloc(0),
    contentType?: string,
    query: Record<string, string> = {},
  ) {
    const stamp = stampOf(new Date()),
      date = stamp.slice(0, 8),
      payload = sha256(body),
      scope = `${date}/${this.config.region}/s3/aws4_request`;
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payload,
      'x-amz-date': stamp,
    };
    if (contentType) headers['content-type'] = contentType;
    const names = Object.keys(headers).sort(),
      signed = names.join(';');
    const canonicalQuery = Object.keys(query)
      .sort()
      .map(name => `${encode(name)}=${encode(query[name]!)}`)
      .join('&');
    const canonical = [
      method,
      path,
      canonicalQuery,
      names.map(n => `${n}:${headers[n]}\n`).join(''),
      signed,
      payload,
    ].join('\n');
    const signature = hmac(
      this.signingKey(date),
      ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n'),
    ).toString('hex');
    const { host: _host, ...sent } = headers;
    return fetch(this.endpoint.origin + path + (canonicalQuery ? '?' + canonicalQuery : ''), {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
      ...(method === 'PUT' ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    let response = await this.send('PUT', this.path(key), body, contentType);
    // Bucket missing (unreachable at startup, or recreated): create it once and retry.
    if (response.status === 404) {
      await this.ensureBucket();
      response = await this.send('PUT', this.path(key), body, contentType);
    }
    if (!response.ok) throw new Error('BLOB_PUT_FAILED_' + response.status);
  }
  async remove(key: string) {
    const response = await this.send('DELETE', this.path(key));
    // Already gone is the desired end state.
    if (!response.ok && response.status !== 404) throw new Error('BLOB_DELETE_FAILED_' + response.status);
  }
  // ListObjectsV2, for the operator tool's orphan report; never on the request path.
  async list(prefix: string) {
    const found: { key: string; size: number; lastModified: Date }[] = [];
    let token: string | undefined;
    const tag = (xml: string, name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]?.replaceAll('&amp;', '&');
    do {
      const response = await this.send('GET', this.path(), undefined, undefined, {
        'list-type': '2',
        prefix,
        ...(token ? { 'continuation-token': token } : {}),
      });
      if (!response.ok) throw new Error('BLOB_LIST_FAILED_' + response.status);
      const xml = await response.text();
      for (const [, entry] of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs))
        found.push({
          key: tag(entry!, 'Key')!,
          size: Number(tag(entry!, 'Size')),
          lastModified: new Date(tag(entry!, 'LastModified')!),
        });
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return found;
  }
  async check() {
    const response = await this.send('HEAD', this.path());
    if (!response.ok) throw new Error('BLOB_BUCKET_UNAVAILABLE_' + response.status);
  }
  async ensureBucket() {
    const head = await this.send('HEAD', this.path());
    if (head.ok) return;
    if (head.status !== 404) throw new Error('BLOB_BUCKET_UNAVAILABLE_' + head.status);
    const created = await this.send('PUT', this.path());
    if (!created.ok && created.status !== 409) throw new Error('BLOB_BUCKET_CREATE_FAILED_' + created.status);
  }
  // Presigned GET (SigV4 query string). Only `host` is signed, against the
  // browser-facing endpoint, so the URL is a bearer for exactly this object and TTL.
  // Signed at the start of a window (TTL/5, at most 60 s): lists repeated within the
  // window return the same URL, so the browser keeps the image it already downloaded
  // instead of fetching it again after every refresh. Each URL stays valid >= 80% of the TTL.
  signedGetUrl(key: string, { now = new Date() }: { now?: Date } = {}) {
    const window = Math.min(60, Math.max(1, Math.floor(this.config.urlTtlSeconds / 5))) * 1000,
      signedAt = new Date(Math.floor(now.getTime() / window) * window);
    const stamp = stampOf(signedAt),
      date = stamp.slice(0, 8),
      scope = `${date}/${this.config.region}/s3/aws4_request`,
      path = this.path(key);
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKey}/${scope}`,
      'X-Amz-Date': stamp,
      'X-Amz-Expires': String(this.config.urlTtlSeconds),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map(name => `${encode(name)}=${encode(query[name]!)}`)
      .join('&');
    const canonical = [
      'GET',
      path,
      canonicalQuery,
      `host:${this.publicEndpoint.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const signature = hmac(
      this.signingKey(date),
      ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n'),
    ).toString('hex');
    return {
      url: `${this.publicEndpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(signedAt.getTime() + this.config.urlTtlSeconds * 1000),
    };
  }
}

// Used when no blob store is configured: every image operation fails closed.
export class UnconfiguredBlobStore implements BlobStore {
  private fail(): never {
    throw new BusinessError(503, 'Medical image storage is not configured.');
  }
  async put(): Promise<void> {
    this.fail();
  }
  async remove(): Promise<void> {
    this.fail();
  }
  signedGetUrl(): never {
    return this.fail();
  }
  async ensureBucket(): Promise<void> {
    this.fail();
  }
  async check(): Promise<void> {
    this.fail();
  }
}

export const blobStoreConfigured = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.BLOB_ENDPOINT);

export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  if (!env.BLOB_ENDPOINT) return new UnconfiguredBlobStore();
  const secretKey = env.BLOB_SECRET_KEY ?? '';
  if (secretKey.length < 32 || secretKey.length > 512) throw new Error('MISSING_OR_INVALID_BLOB_SECRET_KEY');
  return new S3BlobStore({
    endpoint: env.BLOB_ENDPOINT,
    publicEndpoint: env.BLOB_PUBLIC_ENDPOINT || env.BLOB_ENDPOINT,
    bucket: env.BLOB_BUCKET || 'medical-images',
    region: env.BLOB_REGION || 'us-east-1',
    accessKey: env.BLOB_ACCESS_KEY ?? '',
    secretKey,
    urlTtlSeconds: Number(env.BLOB_URL_TTL_SECONDS || 300),
  });
}
