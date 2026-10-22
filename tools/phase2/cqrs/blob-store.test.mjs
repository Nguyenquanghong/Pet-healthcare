import test from 'node:test';
import assert from 'node:assert/strict';
import {S3BlobStore,UnconfiguredBlobStore,blobStoreFromEnv} from '../../../services/clinic/dist/blobStore.js';

// AQ-09 valet key. The SigV4 signature itself is verified against a real S3-compatible
// server in tools/phase2/clinic.test.mjs; here: shape, TTL, config validation, fail-closed.
const config={endpoint:'http://127.0.0.1:55333',publicEndpoint:'https://files.example.test',bucket:'medical-images',region:'us-east-1',accessKey:'clinicaccess',secretKey:'s'.repeat(40),urlTtlSeconds:300};

test('signed GET URL is a short-lived path-style bearer for one object on the public endpoint',()=>{
  const store=new S3BlobStore(config),now=new Date('2030-01-01T00:00:00Z');
  const {url,expiresAt}=store.signedGetUrl('images/abc',{now}),parsed=new URL(url);
  assert.equal(parsed.origin,'https://files.example.test');assert.equal(parsed.pathname,'/medical-images/images/abc');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'),'AWS4-HMAC-SHA256');assert.equal(parsed.searchParams.get('X-Amz-Credential'),'clinicaccess/20300101/us-east-1/s3/aws4_request');
  assert.equal(parsed.searchParams.get('X-Amz-Date'),'20300101T000000Z');assert.equal(parsed.searchParams.get('X-Amz-Expires'),'300');assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'),'host');
  assert.match(parsed.searchParams.get('X-Amz-Signature'),/^[0-9a-f]{64}$/);assert.equal(expiresAt.toISOString(),'2030-01-01T00:05:00.000Z');
  assert.ok(!url.includes(config.secretKey));assert.ok(!url.includes('127.0.0.1'));
  assert.equal(store.signedGetUrl('images/abc',{now}).url,url);assert.notEqual(store.signedGetUrl('images/abd',{now}).url,url);
  // Same URL within a 60 s window (browser keeps the downloaded image), a new one after it;
  // expiry counts from the window start, so a URL is valid for at least 240 of its 300 s.
  const later=store.signedGetUrl('images/abc',{now:new Date(now.getTime()+59000)});assert.equal(later.url,url);assert.equal(later.expiresAt.toISOString(),'2030-01-01T00:05:00.000Z');
  assert.notEqual(store.signedGetUrl('images/abc',{now:new Date(now.getTime()+60000)}).url,url);
  assert.equal(new S3BlobStore({...config,urlTtlSeconds:30}).signedGetUrl('images/abc',{now:new Date(now.getTime()+7000)}).expiresAt.toISOString(),'2030-01-01T00:00:36.000Z');
  assert.notEqual(new S3BlobStore({...config,secretKey:'t'.repeat(40)}).signedGetUrl('images/abc',{now}).url,url);
});

test('configuration is validated and image operations fail closed without a bucket',async()=>{
  for(const bad of [{endpoint:'ftp://x'},{endpoint:'http://u:p@x'},{publicEndpoint:'http://x/path'},{bucket:'Bad_Bucket'},{accessKey:'ab'},{urlTtlSeconds:10},{urlTtlSeconds:3600}])
    assert.throws(()=>new S3BlobStore({...config,...bad}),/INVALID_BLOB/);
  assert.ok(blobStoreFromEnv({}) instanceof UnconfiguredBlobStore);
  assert.throws(()=>blobStoreFromEnv({BLOB_ENDPOINT:'http://127.0.0.1:9',BLOB_ACCESS_KEY:'clinicaccess',BLOB_SECRET_KEY:'short'}),/MISSING_OR_INVALID_BLOB_SECRET_KEY/);
  const store=blobStoreFromEnv({BLOB_ENDPOINT:'http://127.0.0.1:9',BLOB_ACCESS_KEY:'clinicaccess',BLOB_SECRET_KEY:'s'.repeat(40),BLOB_URL_TTL_SECONDS:'120'});
  assert.ok(store instanceof S3BlobStore);assert.equal(new URL(store.signedGetUrl('images/x').url).searchParams.get('X-Amz-Expires'),'120');
  const none=new UnconfiguredBlobStore();
  await assert.rejects(none.put(),error=>error.status===503);await assert.rejects(none.remove(),error=>error.status===503);assert.throws(()=>none.signedGetUrl(),error=>error.status===503);
});
