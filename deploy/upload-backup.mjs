// Uploads one file to BACKUP_S3_BUCKET under postgres/<file name>. Runs inside the engine image (node_modules in /app).
// Reads BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY. Never prints keys.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const file = process.argv[2];
const required = ['BACKUP_S3_BUCKET', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (!file || missing.length > 0) {
  console.error(`usage: upload-backup.mjs <file>; missing settings: ${missing.join(', ') || 'none'}`);
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.BACKUP_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
  },
});

const key = `postgres/${basename(file)}`;
try {
  const body = await readFile(file);
  await client.send(
    new PutObjectCommand({ Bucket: process.env.BACKUP_S3_BUCKET, Key: key, Body: body, ContentType: 'application/octet-stream' }),
  );
  console.log(`uploaded ${key} (${body.length} bytes)`);
} catch (error) {
  console.error(`upload failed: ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
  process.exit(1);
}
