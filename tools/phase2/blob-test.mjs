// Fixture-only configuration of the dedicated test bucket (deploy/phase2/compose.test.yml, service `blob`).
export const blobTestEnv = {
  BLOB_ENDPOINT: 'http://127.0.0.1:55333', BLOB_BUCKET: 'p2-medical-images', BLOB_REGION: 'us-east-1',
  BLOB_ACCESS_KEY: 'p2blobaccess', BLOB_SECRET_KEY: 'p2_blob_secret_fixture_only_0123456789abcdef'
};
